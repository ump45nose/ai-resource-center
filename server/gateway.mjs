import { clearModelHealth } from "./channel-health.mjs";
import {
  tagsOf,
  gatewayBlock,
  channelHeaders,
  archiveOf,
} from "./channel-rules.mjs";
import { verified, autoManaged } from "./maintenance-policy.mjs";
import {
  newApiType,
  channelType,
  headerOverride,
  passthroughSetting,
  findByTag,
} from "./newapi-channel.mjs";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { canonicalApi } from "./domain.mjs";
import { Problem } from "./errors.mjs";
import { eligible, entitlement, policies } from "./resources.mjs";

const snapshot = (r) => ({
  models: r.models,
  base_url: r.base_url,
  priority: r.priority || 0,
  weight: r.weight || 100,
  status: r.status,
  group: r.group,
  type: r.type,
  model_mapping: r.model_mapping || "",
  header_override: r.header_override || "",
  setting: r.setting || "",
});

export class Gateway {
  constructor(store, sources, { allowWrites = false } = {}) {
    Object.assign(this, { store, sources, allowWrites });
  }
  writable() {
    if (!this.allowWrites)
      throw new Problem(
        409,
        "当前实例为并行预备服务，网关写入未启用",
        undefined,
        "gateway_writes_disabled",
      );
  }
  target() {
    const id = policies(this.store).newApiSourceId;
    const rows = (this.store.setting("sources") || []).filter(
      (s) => s.kind === "newapi" && s.enabled !== false,
    );
    const source = id
      ? rows.find((s) => s.id === id)
      : rows.length === 1
        ? rows[0]
        : null;
    if (!source) throw new Problem(409, "请指定接收渠道的 New API 来源");
    return source;
  }
  async stage(offering, { force = false } = {}) {
    this.writable();
    const c = this.store.require("channel", offering.channelId);
    if (gatewayBlock(c)) throw new Problem(409, gatewayBlock(c));
    if (!eligible(this.store, c))
      throw new Problem(400, "该资源不允许进入主动验证网关");
    if (tagsOf(c).includes("client_restricted") && !c.nativePassthrough)
      throw new Problem(
        409,
        "客户端限定渠道先通过对应客户端验证，不使用通用请求冒充验证",
      );
    if (!c.credentialId)
      throw new Problem(409, "需要上游推理 key 才能准备模型验证");
    const source = offering.gateway
      ? this.sources.get(offering.gateway.sourceId)
      : this.target();
    if (
      offering.gateway &&
      (offering.connectionVersion || 1) === (c.connectionVersion || 1)
    )
      return offering;
    if (offering.gateway) {
      const remote = await this.sources.request(
        source,
        `/api/channel/${offering.gateway.channelId}`,
      );
      if (
        offering.applied &&
        !force &&
        !isDeepStrictEqual(snapshot(remote), offering.applied)
      )
        throw new Problem(409, "网关配置已被外部修改，先处理差异");
      const {
        key,
        channel_info,
        created_time,
        test_time,
        response_time,
        balance,
        balance_updated_time,
        used_quota,
        ...config
      } = remote;
      const update = {
        ...config,
        id: remote.id,
        type: channelType(c.protocol, remote),
        key: this.store.reveal(c.credentialId),
        base_url: canonicalApi(c.baseUrl, c.protocol),
        models: offering.evaluationModelId,
        model_mapping: JSON.stringify({
          [offering.evaluationModelId]: offering.modelId,
        }),
        header_override: headerOverride(channelHeaders(this.store, c)),
      };
      await this.sources.configureChannel(source, update);
      const after = await this.sources.request(
        source,
        `/api/channel/${remote.id}`,
      );
      const expected = snapshot({ ...remote, ...update });
      if (!isDeepStrictEqual(snapshot(after), expected))
        throw new Problem(502, "验证连接更新后回读不一致");
      return this.store.put("offering", {
        ...offering,
        connectionVersion: c.connectionVersion || 1,
        applied: snapshot(after),
        apply: { state: "staged", at: new Date().toISOString() },
      });
    }
    const tag = offering.gatewayTag || `arc2-${randomUUID()}`;
    const alias = offering.evaluationModelId || `arc-eval-${randomUUID()}`;
    this.store.put("offering", {
      ...offering,
      gatewayTag: tag,
      evaluationModelId: alias,
    });
    let remote = await findByTag(this.sources, source, tag);
    if (!remote) {
      if (offering.gatewayPending)
        throw new Problem(409, "上次渠道创建结果未确认，请核对后再继续");
      this.store.put("offering", {
        ...this.store.require("offering", offering.id),
        gatewayPending: true,
      });
      await this.sources.request(source, "/api/channel/", "POST", {
        mode: "single",
        channel: {
          type: newApiType(c.protocol),
          name: `${c.name} · ${offering.modelId}`,
          tag,
          base_url: canonicalApi(c.baseUrl, c.protocol),
          key: this.store.reveal(c.credentialId),
          models: alias,
          model_mapping: JSON.stringify({ [alias]: offering.modelId }),
          group: "default",
          status: 1,
          priority: 0,
          weight: 100,
          auto_ban: 0,
          header_override: headerOverride(channelHeaders(this.store, c)),
          ...passthroughSetting(c),
        },
      });
      remote = await findByTag(this.sources, source, tag);
    }
    if (!remote) throw new Problem(502, "New API 渠道创建尚未回读确认");
    return this.store.put("offering", {
      ...this.store.require("offering", offering.id),
      gatewayPending: false,
      gateway: { sourceId: source.id, channelId: remote.id },
      connectionVersion: c.connectionVersion || 1,
      applied: snapshot(remote),
      apply: { state: "staged", at: new Date().toISOString() },
    });
  }
  async inference(offering, runId, { origin = "live" } = {}) {
    let staged = await this.stage(offering);
    const source = this.sources.get(staged.gateway.sourceId);
    if (staged.applied?.status !== 1) {
      const remote = await this.sources.request(
        source,
        `/api/channel/${staged.gateway.channelId}`,
      );
      if (!isDeepStrictEqual(snapshot(remote), staged.applied))
        throw new Problem(409, "验证连接已被外部修改");
      await this.sources.request(
        source,
        `/api/channel/${staged.gateway.channelId}/status`,
        "POST",
        { status: 1 },
      );
      const after = await this.sources.request(
        source,
        `/api/channel/${staged.gateway.channelId}`,
      );
      if (after.status !== 1) throw new Problem(502, "验证连接启用未确认");
      staged = this.store.put("offering", {
        ...staged,
        applied: snapshot(after),
      });
    }
    const identityId = `evaluation:${runId}`,
      existing = this.store.get("identity", identityId);
    if (existing?.credentialId)
      return {
        baseUrl: `${source.url.replace(/\/$/, "")}/v1`,
        modelId: existing.modelId,
        apiKey: this.store.reveal(existing.credentialId),
        tokenId: existing.tokenId,
      };
    const modelId =
      staged.apply?.state === "synced" &&
      !this.distribution?.config("newapi").enabled
        ? staged.modelId
        : staged.evaluationModelId;
    const name = existing?.pendingName || `arc2-eval-${runId}`;
    if (!existing) {
      this.store.put("identity", {
        id: identityId,
        pendingName: name,
        channelId: staged.channelId,
      });
      await this.sources.request(source, "/api/token/", "POST", {
        name,
        expired_time: Math.floor(Date.now() / 1000) + 3600,
        remain_quota: 0,
        unlimited_quota: true,
        model_limits_enabled: true,
        model_limits: modelId,
        group: "default",
        cross_group_retry: false,
      });
    }
    const token = (
      await this.sources.pages(source, "/api/token/search", { keyword: name })
    ).find((t) => t.name === name);
    if (!token) throw new Problem(409, "验证身份创建尚未确认，不重复创建");
    const data = await this.sources.request(
      source,
      `/api/token/${token.id}/key`,
      "POST",
    );
    const apiKey = `${data.key}-${staged.gateway.channelId}`;
    this.store.put("identity", {
      id: identityId,
      channelId: staged.channelId,
      sourceId: source.id,
      origin,
      tokenId: token.id,
      modelId,
      credentialId: this.store.secret(apiKey),
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    });
    return {
      baseUrl: `${source.url.replace(/\/$/, "")}/v1`,
      modelId,
      apiKey,
      tokenId: token.id,
    };
  }
  async revoke(runId) {
    const identity = this.store.get("identity", `evaluation:${runId}`);
    if (!identity?.tokenId || identity.revokedAt) return;
    await this.sources.request(
      this.sources.get(identity.sourceId),
      `/api/token/${identity.tokenId}`,
      "DELETE",
    );
    this.store.put("identity", {
      ...identity,
      revokedAt: new Date().toISOString(),
    });
  }
  async pauseEvaluation(offeringId) {
    const o = this.store.require("offering", offeringId);
    if (
      !o.gateway ||
      (o.apply?.state !== "staged" &&
        !this.distribution?.config("newapi").enabled)
    )
      return;
    const source = this.sources.get(o.gateway.sourceId);
    const remote = await this.sources.request(
      source,
      `/api/channel/${o.gateway.channelId}`,
    );
    if (
      !isDeepStrictEqual(snapshot(remote), o.applied) &&
      !(
        o.evaluationPausePending &&
        remote.status === 2 &&
        isDeepStrictEqual(
          snapshot({ ...remote, status: o.applied.status }),
          o.applied,
        )
      )
    )
      throw new Problem(409, "验证连接已被外部修改");
    if (remote.status !== 2) {
      this.store.put("offering", { ...o, evaluationPausePending: true });
      await this.sources.request(
        source,
        `/api/channel/${remote.id}/status`,
        "POST",
        { status: 2 },
      );
    }
    const after = await this.sources.request(
      source,
      `/api/channel/${remote.id}`,
    );
    if (after.status !== 2) throw new Problem(502, "验证连接停用未确认");
    this.store.put("offering", {
      ...o,
      applied: snapshot(after),
      evaluationPausePending: false,
    });
  }
  async evidence(runId, offering) {
    const identity = this.store.get("identity", `evaluation:${runId}`);
    if (!identity?.tokenId) return { observed: false, matched: false };
    await this.sources.calls(this.sources.get(identity.sourceId));
    const rows = this.store.db
      .prepare(
        "SELECT channel_id,model,upstream_channel,result,request_id FROM calls WHERE source=? AND CAST(token_id AS INTEGER)=?",
      )
      .all(identity.sourceId, Number(identity.tokenId));
    return {
      observed: rows.length > 0,
      matched:
        rows.length > 0 &&
        rows.every(
          (r) =>
            r.channel_id === offering.channelId &&
            r.model === offering.modelId &&
            String(r.upstream_channel) === String(offering.gateway.channelId),
        ),
      successful: rows.some((r) => r.result === "success"),
      requestIds: rows.map((r) => r.request_id).filter(Boolean),
    };
  }
  refreshGrades() {
    for (const c of this.store
      .list("channel")
      .filter((c) => autoManaged(this.store, c))) {
      for (const modelId of c.models || []) {
        const o = this.store.get("offering", `${c.id}:${modelId}`) || {
          id: `${c.id}:${modelId}`,
          channelId: c.id,
          modelId,
        };
        this.store.put("offering", {
          ...o,
          grade: { ...this.grade(o), computedAt: new Date().toISOString() },
        });
      }
    }
    this.distribution?.reconcile("newapi");
  }
  grade(offering) {
    const p = policies(this.store),
      from = new Date(Date.now() - p.days * 86400000).toISOString();
    const rows = this.store.db
      .prepare(
        "SELECT source,source_id,result,error_type,request_id FROM calls WHERE channel_id=? AND model=? AND occurred_at>=? AND result IN ('success','failure') AND (origin IS NULL OR origin='live') AND legacy_import=0",
      )
      .all(offering.channelId, offering.modelId, from)
      .filter((r) =>
        offering.gateway
          ? r.source === offering.gateway.sourceId
          : r.source !== "cron",
      )
      .filter((r) => !r.error_type || r.error_type === "upstream");
    const rate = rows.length
      ? (100 * rows.filter((r) => r.result === "success").length) / rows.length
      : null;
    const c = this.store.require("channel", offering.channelId),
      a = this.store.get("account", c.accountId),
      rights = entitlement(a);
    if (
      offering.verification?.result === "failure" &&
      (!offering.verification.errorType ||
        offering.verification.errorType === "upstream")
    ) {
      rights.available = false;
      rights.reasons.push(offering.verification.reason || "最近任务验证未通过");
    }
    const tier =
      c.rating === "差"
        ? "backup"
        : rows.length < p.samples
          ? "observing"
          : rate >= p.good
            ? "preferred"
            : rate >= p.warn
              ? "regular"
              : "backup";
    const currentPriority =
      this.store.get("targetLink", `newapi:${c.id}`)?.snapshot?.priority ??
      c.sourceObservation?.priority ??
      c.priority ??
      offering.applied?.priority ??
      0;
    const priority =
      !rights.available || ["observing", "backup"].includes(tier)
        ? tier === "observing" && rights.available
          ? currentPriority
          : 0
        : rights.daily
          ? tier === "preferred"
            ? 400
            : 300
          : tier === "preferred"
            ? 200
            : 100;
    const cohort = new Set(
      this.store
        .list("channel")
        .filter(
          (other) =>
            other.protocol === c.protocol &&
            other.usage === c.usage &&
            other.enabled &&
            !other.mergedInto &&
            other.models?.includes(offering.modelId),
        )
        .map((other) => other.id),
    );
    const timed = this.store.db
      .prepare(
        "SELECT channel_id,ttft FROM calls WHERE model=? AND occurred_at>=? AND result='success' AND ttft>0 AND (origin IS NULL OR origin='live') AND legacy_import=0",
      )
      .all(offering.modelId, from)
      .filter((r) => cohort.has(r.channel_id));
    const median = (values) => {
      const sorted = values.sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      return sorted.length % 2
        ? sorted[mid]
        : (sorted[mid - 1] + sorted[mid]) / 2;
    };
    const own = timed.filter((r) => r.channel_id === offering.channelId);
    const comparable =
      new Set(timed.map((r) => r.channel_id)).size > 1 && own.length >= 3;
    const weight = comparable
      ? Math.round(
          Math.max(
            50,
            Math.min(
              200,
              (100 * median(timed.map((r) => r.ttft))) /
                median(own.map((r) => r.ttft)),
            ),
          ),
        )
      : 100;
    return {
      tier,
      samples: rows.length,
      successRate: rate,
      windowStart: from,
      priority,
      weight,
      entitlement: rights,
      coverage: "中心已采集、可归因的调用；不表示上游完整成功率",
      reason: !rights.available
        ? rights.reasons.join("、")
        : c.rating === "差"
          ? "人工评价较差，不自动提权"
          : rows.length < p.samples
            ? `仅 ${rows.length} 条有效真实调用，等待 ${p.samples} 条；保留原优先级`
            : `近 ${p.days} 天成功率 ${rate.toFixed(1)}% · ${rights.daily ? "当日额度优先" : "长期额度"}`,
      weightReason: comparable
        ? "同模型、协议及用途的首字延迟比较，权重限制 50～200"
        : "缺少可比的首字延迟记录，权重保持 100",
    };
  }
  async acceptExternal(offering) {
    const remote = await this.sources.request(
      this.sources.get(offering.gateway.sourceId),
      `/api/channel/${offering.gateway.channelId}`,
    );
    return this.store.put("offering", {
      ...offering,
      applied: snapshot(remote),
      apply: { state: "external", at: new Date().toISOString() },
      autoManaged: false,
    });
  }
  async apply(offeringId, { force = false, automatic = false } = {}) {
    this.writable();
    if (
      automatic &&
      (!policies(this.store).autoApply ||
        !autoManaged(
          this.store,
          this.store.require(
            "channel",
            this.store.require("offering", offeringId).channelId,
          ),
        ))
    )
      throw new Problem(409, "自动维护已关闭或渠道改为人工管理，未调整网关");
    let o = this.store.require("offering", offeringId);
    const c = this.store.require("channel", o.channelId);
    if (gatewayBlock(c)) throw new Problem(409, gatewayBlock(c));
    if (!eligible(this.store, c))
      throw new Problem(400, "此渠道不参与网关自动恢复");
    if (
      !verified(o, c) &&
      !(
        o.apply?.state === "synced" &&
        o.lastPassedVerification?.connectionVersion ===
          (c.connectionVersion || 1)
      )
    )
      throw new Problem(409, "模型尚未通过任务验证");
    if (this.distribution?.config("newapi").enabled) {
      await this.pauseEvaluation(o.id);
      if (verified(o, c)) clearModelHealth(this.store, o.id);
      const current = this.store.require("channel", c.id),
        recovering =
          archiveOf(current).length > 0 ||
          !!current.callIssue ||
          !!current.availability ||
          ["maintenance", "closed"].includes(current.management?.state);
      if (
        recovering ||
        !current.enabled ||
        !(current.models || []).includes(o.modelId)
      )
        this.store.put("channel", {
          ...current,
          enabled: true,
          archiveReason: null,
          availability: null,
          callIssue: null,
          management: { ...current.management, state: "active" },
          models: recovering
            ? [o.modelId]
            : [...new Set([...(current.models || []), o.modelId])],
          maintenance: {
            ...current.maintenance,
            lastRestoredAt: new Date().toISOString(),
            restoredModelId: o.modelId,
            previousIssue: current.availability || current.archiveReason,
          },
          version: current.version + 1,
        });
      const saved = this.store.put("offering", {
        ...this.store.require("offering", o.id),
        grade: this.grade(o),
        apply: {
          state:
            this.distribution
              .channelStatus(c.id)
              .some((j) => j.target === "newapi" && j.state === "applied") &&
            !recovering
              ? "distributed"
              : "pending_sync",
          at: new Date().toISOString(),
        },
      });
      this.distribution.reconcile("newapi");
      const job = this.distribution
        .currentJobs("newapi")
        .find((j) => j.subject === c.id && j.state === "applied");
      if (job)
        this.distribution.finish(
          job.id,
          await this.distribution.applyNewApi(job),
        );
      return this.store.require("offering", saved.id);
    }
    o = await this.stage(o, { force });
    const source = this.sources.get(o.gateway.sourceId);
    const remote = await this.sources.request(
      source,
      `/api/channel/${o.gateway.channelId}`,
    );
    if (
      o.applied &&
      !force &&
      !isDeepStrictEqual(snapshot(remote), o.applied)
    ) {
      this.store.put("offering", {
        ...o,
        apply: { state: "conflict", external: snapshot(remote) },
      });
      throw new Problem(409, "网关配置已被外部修改，请处理差异");
    }
    const grade = this.grade(o);
    const desired = {
      ...snapshot(remote),
      models: o.modelId,
      model_mapping: "",
      group: "default",
      priority:
        c.mode === "manual" && c.management?.fixed
          ? remote.priority
          : grade.priority,
      weight: c.management?.fixed ? remote.weight : grade.weight,
      status: grade.entitlement.available ? 1 : 2,
    };
    if (!isDeepStrictEqual(snapshot(remote), desired)) {
      const {
        key,
        status,
        created_time,
        test_time,
        response_time,
        balance,
        balance_updated_time,
        used_quota,
        channel_info,
        ...config
      } = remote;
      await this.sources.configureChannel(source, {
        ...config,
        ...desired,
        id: remote.id,
      });
      if (remote.status !== desired.status)
        await this.sources.request(
          source,
          `/api/channel/${remote.id}/status`,
          "POST",
          { status: desired.status },
        );
    }
    const after = await this.sources.request(
      source,
      `/api/channel/${remote.id}`,
    );
    if (!isDeepStrictEqual(snapshot(after), desired))
      throw new Problem(502, "网关写入后的回读不一致");
    const saved = this.store.put("offering", {
      ...this.store.require("offering", o.id),
      applied: snapshot(after),
      grade,
      apply: { state: "synced", at: new Date().toISOString() },
    });
    if (desired.status === 1) {
      if (verified(o, c)) clearModelHealth(this.store, o.id);
      const current = this.store.require("channel", c.id);
      const restored =
        !!current.availability ||
        !!current.callIssue ||
        ["maintenance", "closed"].includes(current.management?.state);
      this.store.put("channel", {
        ...current,
        enabled: true,
        availability: null,
        archiveReason: null,
        callIssue: null,
        management: { ...current.management, state: "active" },
        models: restored
          ? [o.modelId]
          : [...new Set([...(current.models || []), o.modelId])],
        maintenance: {
          ...current.maintenance,
          lastRestoredAt: new Date().toISOString(),
          restoredModelId: o.modelId,
          ...(restored
            ? {
                previousIssue:
                  current.availability ||
                  current.callIssue ||
                  current.management?.state,
              }
            : {}),
        },
        version: current.version + 1,
      });
    }
    this.store.action(c.id, {
      kind: "gateway_applied",
      modelId: o.modelId,
      priority: grade.priority,
      result: "synced",
    });
    return saved;
  }
}
