import { isDeepStrictEqual } from "node:util";
import { randomUUID, randomBytes } from "node:crypto";
import { Problem } from "./center.mjs";
import {
  errorType,
  normalizeUrl,
  canonicalApi,
  availability,
} from "./domain.mjs";

const routing = (c) => ({
  priority: c.priority || 0,
  weight: c.weight || 100,
  models: c.models,
  name: c.name,
  base_url: c.baseUrl,
  status: c.enabled ? 1 : 2,
});
const observed = (x) => ({
  priority: x.priority || 0,
  weight: x.weight || 100,
  models: (x.models || "").split(",").filter(Boolean),
  name: x.name,
  base_url: x.base_url || "",
  status: x.status,
});
export class Gateways {
  constructor(center, fetcher = fetch) {
    this.center = center;
    this.store = center.store;
    this.fetch = fetcher;
    this.running = false;
    this.applying = new Set();
    this.provisioning = new Map();
    this.lastEligibilityCheck = null;
  }
  source(id) {
    const s = (this.store.setting("sources") || []).find((s) => s.id === id);
    if (!s) throw new Problem(400, "来源尚未配置");
    return s;
  }
  async request(source, path, method = "GET", body) {
    const credential = this.store.reveal(source.credentialId);
    const response = await this.fetch(source.url.replace(/\/$/, "") + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${credential}`,
        ...(source.userId ? { "New-Api-User": String(source.userId) } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok)
      throw new Problem(502, `${source.name} HTTP ${response.status}`);
    const data = await response.json();
    if (data.success === false)
      throw new Problem(502, `${source.name}: ${data.message || "请求失败"}`);
    return data.data ?? data;
  }
  async pages(source, path, query = {}) {
    const rows = [];
    let page = 1;
    for (;;) {
      const data = await this.request(
        source,
        `${path}${path.includes("?") ? "&" : "?"}${new URLSearchParams({ ...query, p: page, page_size: 100 })}`,
      );
      const items = data.items || data;
      if (!Array.isArray(items)) throw new Problem(502, "来源分页格式不兼容");
      rows.push(...items);
      if (
        items.length < 100 ||
        (data.total !== undefined && rows.length >= data.total)
      )
        return rows;
      if (page++ >= 1000)
        throw new Problem(502, "来源数据过大，请缩小同步区间");
    }
  }
  async inventory(id) {
    const source = this.source(id);
    let rows;
    if (source.kind === "newapi") {
      const channels = await this.pages(source, "/api/channel/");
      rows = channels.map((x) => ({
        sourceId: String(x.id),
        accountSourceId: `channel-account:${x.id}`,
        site: { name: x.name, url: new URL(x.base_url || source.url).origin },
        name: x.name,
        baseUrl: x.base_url || source.url,
        protocol:
          x.type === 14 ? "Anthropic" : x.type === 24 ? "Gemini" : "OpenAI",
        models: (x.models || "").split(",").filter(Boolean),
        category: "general",
        gateway: { sourceId: id, channelId: x.id },
        group: x.group,
        priority: x.priority || 0,
        weight: x.weight || 100,
        applied: observed(x),
        enabled: x.status === 1,
        note: "来自网关，用途待人工确认",
      }));
    } else if (source.kind === "cpa") {
      const data = await this.request(
        source,
        "/v0/management/openai-compatibility",
      );
      const providers = data["openai-compatibility"] || data;
      if (!Array.isArray(providers))
        throw new Problem(502, "CPA 配置格式不兼容");
      // Account reverse proxies are deliberately excluded; only configured compatibility providers.
      rows = providers.flatMap((p) =>
        (p["api-key-entries"] || []).map((entry, i) => ({
          sourceId: `${p.name}:${i}`,
          accountSourceId: p.name,
          site: { name: p.name, url: new URL(p["base-url"]).origin },
          name: p.name,
          baseUrl: p["base-url"],
          models: (p.models || []).map((m) => m.alias || m.name),
          protocol: "OpenAI",
          category: "general",
          key: entry["api-key"],
          gateway: { sourceId: id, provider: p.name },
          note: "CPA OpenAI compatibility",
        })),
      );
    } else throw new Problem(400, "该来源通过客户端上报");
    const preview = this.center.importPreview(rows, id);
    return { rows, preview };
  }
  async apply(id, options = {}) {
    if (this.applying.has(id))
      throw new Problem(409, "该渠道正在应用，请稍后回读");
    this.applying.add(id);
    try {
      return await this.applyOnce(id, options);
    } finally {
      this.applying.delete(id);
    }
  }
  async connect(id, sourceId) {
    if (this.applying.has(id))
      throw new Problem(409, "该连接正在应用，请稍后回读");
    this.applying.add(id);
    try {
      return await this.connectOnce(id, sourceId);
    } finally {
      this.applying.delete(id);
    }
  }
  async connectOnce(id, sourceId) {
    const c = this.store.get("channel", id),
      source = this.source(sourceId);
    if (!c || !["general", "media"].includes(c.category))
      throw new Problem(400, "只有通用与生图视频连接可以接入公共网关");
    if (source.kind !== "newapi")
      throw new Problem(400, "新增渠道仅支持 New API");
    if (c.gateway) throw new Problem(409, "已经关联网关，请先读取现有配置");
    const key = this.store.reveal(c.credentialId);
    if (!key || !c.models.length)
      throw new Problem(400, "请先补充 key 并选定模型");
    if (c.gatewayPreparing && c.gatewayPreparing !== sourceId)
      throw new Problem(409, "有未确认的网关接入，请先核对原网关");
    const tag = `arc-${c.id}`;
    let remote = (await this.pages(source, "/api/channel/")).find(
      (x) => x.tag === tag,
    );
    if (!remote) {
      if (c.gatewayPreparing)
        throw new Problem(
          409,
          "上次创建结果尚未确认，请在 New API 核对后处理；没有重复创建",
        );
      this.store.put("channel", { ...c, gatewayPreparing: sourceId });
      await this.request(source, "/api/channel/", "POST", {
        mode: "single",
        channel: {
          type:
            c.protocol === "Anthropic" ? 14 : c.protocol === "Gemini" ? 24 : 1,
          name: c.name,
          tag,
          key,
          base_url: canonicalApi(c.baseUrl, c.protocol),
          models: c.models.join(","),
          group: "default",
          status: c.enabled ? 1 : 2,
          priority: c.priority,
          weight: c.weight,
          auto_ban: 0,
          header_override: JSON.stringify(
            Object.fromEntries(c.headers.map((x) => [x.name, x.value])),
          ),
        },
      });
      remote = (await this.pages(source, "/api/channel/")).find(
        (x) => x.tag === tag,
      );
    }
    if (!remote)
      throw new Problem(502, "网关创建结果未确认，请核对该站点的渠道标签");
    const current = this.store.get("channel", id);
    const saved = this.store.put("channel", {
      ...current,
      gatewayPreparing: undefined,
      gateway: { sourceId, channelId: remote.id },
      applied: observed(remote),
      group: remote.group,
      version: current.version + 1,
      apply: current.version === c.version ? "synced" : "pending",
      applyMsg:
        current.version === c.version
          ? "New API 已创建并回读；没有调用上游"
          : "已关联网关；期间的中心修改仍待应用",
      mode: current.version === c.version ? "auto" : current.mode,
      baseRouting: {
        priority: remote.priority || 0,
        weight: remote.weight || 100,
      },
    });
    this.store.ref(sourceId, "channel", remote.id, id);
    this.center.backfill(sourceId);
    this.store.action(id, {
      result: "gateway_connected",
      sourceId,
      channelId: remote.id,
    });
    return this.center.publicChannel(saved);
  }
  async applyOnce(id, { force = false, automatic = false } = {}) {
    const c = this.store.get("channel", id);
    if (!c) throw new Problem(404, "渠道不存在");
    if (!c.gateway)
      throw new Problem(
        400,
        c.category === "rp"
          ? "请在酒馆中应用保存后的连接"
          : "该连接没有网关绑定",
      );
    const source = this.source(c.gateway.sourceId);
    if (source.kind !== "newapi")
      throw new Problem(400, "CPA 配置保留人工管理，请在 CPA 确认并重新读取");
    let remote;
    try {
      const fullRemote = await this.request(
        source,
        `/api/channel/${c.gateway.channelId}`,
      );
      remote = observed(fullRemote);
      if (c.applied && !force && !isDeepStrictEqual(remote, c.applied)) {
        this.store.put("channel", {
          ...c,
          apply: "diff",
          external: remote,
          applyMsg: "网关配置与上次回读不同，已暂停覆盖",
        });
        throw new Problem(409, "发现外部配置修改", { external: remote });
      }
      const desired = automatic
        ? { ...remote, priority: c.priority, weight: c.weight }
        : routing(c);
      if (c.category === "rp") desired.status = 2;
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
        ...nativeConfig
      } = fullRemote;
      const update = {
        ...nativeConfig,
        id: c.gateway.channelId,
        name: desired.name,
        models: desired.models.join(","),
        base_url: desired.base_url,
        priority: desired.priority,
        weight: desired.weight,
        ...(!automatic && c.credentialPending
          ? { key: this.store.reveal(c.credentialId) }
          : {}),
      };
      if (
        c.category !== "rp" &&
        ((c.credentialPending && !automatic) ||
          !isDeepStrictEqual({ ...remote, status: desired.status }, desired))
      )
        await this.request(source, "/api/channel/", "PUT", update);
      if (remote.status !== desired.status)
        await this.request(
          source,
          `/api/channel/${c.gateway.channelId}/status`,
          "POST",
          { status: desired.status },
        );
      const after = observed(
        await this.request(source, `/api/channel/${c.gateway.channelId}`),
      );
      const expected = c.category === "rp" ? { ...remote, status: 2 } : desired;
      if (!isDeepStrictEqual(after, expected))
        throw new Problem(502, "网关回读与目标配置不同");
      const current = this.store.get("channel", id);
      this.store.put("channel", {
        ...current,
        applied: after,
        ...(!automatic && c.credentialPending
          ? { credentialPending: current.credentialId !== c.credentialId }
          : {}),
        external: undefined,
        apply:
          current.version !== c.version || c.category === "rp"
            ? "pending"
            : "synced",
        applyMsg:
          current.version !== c.version
            ? "旧版本已回读，新修改待应用"
            : c.category === "rp"
              ? "旧网关入口已停用，等待酒馆应用"
              : c.credentialPending && !automatic
                ? "网关配置已回读；key 已提交，等待真实调用确认"
                : "网关已回读确认",
      });
      this.store.action(id, { before: remote, after, result: "applied" });
      return this.center.publicChannel(this.store.get("channel", id));
    } catch (error) {
      if (error.statusCode !== 409) {
        const current = this.store.get("channel", id);
        this.store.put("channel", {
          ...current,
          apply: "failed",
          applyMsg: error.message,
        });
        this.store.action(id, {
          before: remote,
          result: "failed",
          reason: error.message,
        });
      }
      throw error;
    }
  }
  async adopt(id) {
    const c = this.store.get("channel", id),
      s = this.source(c.gateway.sourceId),
      r = observed(
        await this.request(s, `/api/channel/${c.gateway.channelId}`),
      );
    return this.store.put("channel", {
      ...c,
      name: r.name,
      models: r.models,
      baseUrl: r.base_url,
      enabled: r.status === 1,
      priority: r.priority,
      weight: r.weight,
      applied: r,
      external: undefined,
      mode: "manual",
      version: c.version + 1,
      apply: "synced",
      applyMsg: "已采用网关配置，转为人工管理",
    });
  }
  call(source, id, c, model, time, result, detail = {}) {
    const previous = this.store.db
      .prepare("SELECT result FROM calls WHERE source=? AND source_id=?")
      .get(source, String(id));
    this.store.db
      .prepare(
        "INSERT INTO calls VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(source,source_id) DO UPDATE SET result=excluded.result,error_type=excluded.error_type,summary=excluded.summary",
      )
      .run(
        source,
        String(id),
        c.id,
        model,
        time,
        result,
        detail.errorType || null,
        detail.latency ?? null,
        Number.isFinite(detail.ttft) && detail.ttft > 0 ? detail.ttft : null,
        detail.requestId || null,
        detail.tokenId ? String(detail.tokenId) : null,
        typeof detail.streamStatus === "string"
          ? detail.streamStatus
          : detail.streamStatus
            ? JSON.stringify(detail.streamStatus)
            : null,
        detail.summary?.slice(0, 300) || null,
      );
    const current = this.store.get("channel", c.id);
    if (
      (!previous || previous.result !== result) &&
      current &&
      c.models.includes(model) &&
      (!current.callObservedAt || time >= current.callObservedAt)
    ) {
      const reasons = {
        rate: "限流",
        quota: "余额或额度不足",
        key: "调用凭据错误",
        account: "账号需验证",
      };
      this.store.put("channel", {
        ...current,
        callObservedAt: time,
        ...(result === "success" ? { availability: undefined } : {}),
        callIssue:
          result === "failure" && reasons[detail.errorType]
            ? { reason: reasons[detail.errorType], model, at: time }
            : result === "success"
              ? undefined
              : current.callIssue,
      });
    }
  }
  async syncCpa(source) {
    const end = Date.now(),
      start = source.cursorMs || end - 7 * 86400000;
    const channels = this.store
      .list("channel")
      .filter((c) => c.gateway?.sourceId === source.id && c.category !== "rp");
    const providers = [
      ...new Set(
        channels.map((c) => "openai-compatible-" + c.gateway.provider),
      ),
    ];
    if (!providers.length) return { records: 0, unmatched: 0 };
    let before = {},
      records = 0,
      unmatched = 0;
    for (;;) {
      const data = await this.request(
        source,
        "/v0/management/monitoring/analytics",
        "POST",
        {
          from_ms: start,
          to_ms: end,
          time_zone: "UTC",
          filters: { providers, include_failed: true },
          include: { events_page: { limit: 200, ...before } },
        },
      );
      const page = data.events;
      if (!page || !Array.isArray(page.items))
        throw new Problem(502, "CPA 持久化记录接口格式不兼容");
      for (const x of page.items) {
        const matches = channels.filter(
          (c) =>
            "openai-compatible-" + c.gateway.provider ===
            x.auth_provider_snapshot,
        );
        if (matches.length !== 1) {
          unmatched++;
          continue;
        }
        const c = matches[0];
        this.call(
          source.id,
          x.event_hash,
          c,
          x.requested_model || x.model,
          new Date(x.timestamp_ms).toISOString(),
          x.failed ? "failure" : "success",
          {
            errorType: x.failed
              ? errorType(x.fail_summary, x.fail_status_code)
              : null,
            latency: x.latency_ms,
            ttft: x.ttft_ms,
            requestId: x.request_id,
            summary: x.failed
              ? `HTTP ${x.fail_status_code || "未知"} · ${errorType(x.fail_summary, x.fail_status_code)}`
              : null,
          },
        );
        records++;
      }
      if (!page.has_more) break;
      if (
        !page.next_before_ms ||
        !page.next_before_id ||
        (before.before_ms === page.next_before_ms &&
          before.before_id === page.next_before_id)
      )
        throw new Problem(502, "CPA 分页游标没有前进，已停止同步");
      before = {
        before_ms: page.next_before_ms,
        before_id: page.next_before_id,
      };
    }
    this.store.setting(
      "sources",
      (this.store.setting("sources") || []).map((s) =>
        s.id === source.id
          ? {
              ...s,
              cursorMs: end - 1,
              last: new Date().toISOString(),
              error: null,
              coverage: unmatched
                ? `${unmatched} 条因凭据无法唯一关联而未计入；只读取 Manager 已存记录`
                : "只读取 Manager 已存记录；账号反代不计入",
            }
          : s,
      ),
    );
    this.center.recompute();
    return { records, unmatched };
  }
  async sync(id) {
    const source = this.source(id);
    if (source.kind === "cpa") return this.syncCpa(source);
    if (source.kind !== "newapi")
      throw new Problem(400, "该来源不提供调用日志同步");
    const serverStatus = await this.request(source, "/api/status");
    source.version = serverStatus.version;
    const since = source.cursor || Math.floor(Date.now() / 1000) - 7 * 86400,
      end = Math.floor(Date.now() / 1000);
    const logs = await this.pages(source, "/api/log/", {
      start_timestamp: since,
      end_timestamp: end,
    });
    const channels = this.store
      .list("channel")
      .filter((c) => c.gateway?.sourceId === id);
    for (const x of logs.filter((x) => [2, 5].includes(x.type))) {
      const c = channels.find(
        (c) => c.gateway.channelId === (x.channel ?? x.channel_id),
      );
      if (!c || c.category === "rp") continue;
      const other =
        typeof x.other === "string"
          ? JSON.parse(x.other || "{}")
          : x.other || {};
      // Text log records are attempts; media completion is ingested from task state below.
      if (c.category === "media") continue;
      const error =
        x.type === 5 ? errorType(x.content, other.status_code) : null;
      this.call(
        id,
        x.id,
        c,
        x.model_name,
        new Date(x.created_at * 1000).toISOString(),
        x.type === 2 ? "success" : "failure",
        {
          errorType: error,
          latency: Number.isFinite(x.use_time) ? x.use_time * 1000 : null,
          ttft: Number.isFinite(other.frt) ? other.frt : null,
          requestId: x.request_id,
          tokenId: x.token_id,
          streamStatus: other.stream_status,
          summary:
            x.type === 5
              ? `HTTP ${other.status_code || "未知"} · ${error}`
              : null,
        },
      );
    }
    const tasks = await this.pages(source, "/api/task", {
      start_timestamp: Math.floor(Date.now() / 1000) - 7 * 86400,
      end_timestamp: end,
    });
    for (const x of tasks) {
      const c = channels.find(
        (c) => c.gateway.channelId === (x.channel_id ?? x.channel),
      );
      if (!c || c.category !== "media") continue;
      const status = String(x.status).toUpperCase(),
        result = ["SUCCESS", "SUCCEEDED", "COMPLETED"].includes(status)
          ? "success"
          : ["FAILURE", "FAILED"].includes(status)
            ? "failure"
            : "pending";
      this.call(
        id,
        `task:${x.task_id || x.id}`,
        c,
        x.model || x.model_name || x.properties?.model || "",
        new Date((x.submit_time || x.created_at) * 1000).toISOString(),
        result,
        {
          errorType: result === "failure" ? errorType(x.fail_reason) : null,
          summary: result === "failure" ? "生成任务失败" : null,
        },
      );
    }
    this.store.setting(
      "sources",
      (this.store.setting("sources") || []).map((s) =>
        s.id === id
          ? {
              ...s,
              version: source.version,
              cursor: end - 1,
              last: new Date().toISOString(),
              error: null,
              coverage: "仅反映网关已记录的调用；部分失败未记录",
            }
          : s,
      ),
    );
    this.center.recompute();
    return { records: logs.length, tasks: tasks.length };
  }
  async recalculateAndApply() {
    const result = this.center.recompute();
    for (const c of result.filter(
      (c) =>
        c.mode === "auto" &&
        c.gateway &&
        ["general", "media"].includes(c.category) &&
        this.source(c.gateway.sourceId).kind === "newapi" &&
        !["diff", "conflict", "failed", "pending"].includes(c.apply),
    )) {
      if (
        c.applied &&
        c.priority === c.applied.priority &&
        (c.weight || 100) === c.applied.weight
      )
        continue;
      try {
        await this.apply(c.id, { automatic: true });
      } catch {
        /* apply persists an actionable failure on the channel */
      }
    }
  }
  async scheduled(now = new Date()) {
    if (this.running) return;
    this.running = true;
    try {
      for (const s of (this.store.setting("sources") || []).filter((s) =>
        ["newapi", "cpa"].includes(s.kind),
      )) {
        try {
          await this.sync(s.id);
        } catch (error) {
          this.store.setting(
            "sources",
            (this.store.setting("sources") || []).map((x) =>
              x.id === s.id ? { ...x, error: error.message } : x,
            ),
          );
        }
      }
      const previous = this.lastEligibilityCheck,
        accounts = this.store.list("account");
      const eligibilityChanged =
        !previous ||
        this.store.list("channel").some(
          (c) =>
            c.mode === "auto" &&
            c.gateway &&
            ["general", "media"].includes(c.category) &&
            availability(
              c,
              accounts.find((a) => a.id === c.accountId),
              now,
            ) !==
              availability(
                c,
                accounts.find((a) => a.id === c.accountId),
                previous,
              ),
        );
      if (
        eligibilityChanged ||
        now.getTime() - (this.store.setting("evaluatedAt") || 0) >= 3600000
      ) {
        await this.recalculateAndApply();
        this.store.setting("evaluatedAt", now.getTime());
      }
      this.lastEligibilityCheck = now;
    } finally {
      this.running = false;
    }
  }
  async inferenceToken(c, identity, expiry = -1, pinned = false) {
    const sourceId = c.gateway.sourceId;
    const previous = this.provisioning.get(sourceId) || Promise.resolve();
    const current = previous
      .catch(() => {})
      .then(() => this.provisionIdentity(c, identity, expiry, pinned));
    this.provisioning.set(sourceId, current);
    try {
      return await current;
    } finally {
      if (this.provisioning.get(sourceId) === current)
        this.provisioning.delete(sourceId);
    }
  }
  async provisionIdentity(c, identity, expiry, pinned) {
    const source = this.source(c.gateway.sourceId),
      identityId = `${c.id}:${identity}`,
      old = this.store.get("identity", identityId);
    if (old?.credentialId && !pinned) {
      if (source.kind === "newapi") {
        const token = await this.request(source, `/api/token/${old.tokenId}`);
        if (token.model_limits !== c.models.join(",")) {
          await this.request(source, "/api/token/", "PUT", {
            ...token,
            model_limits_enabled: true,
            model_limits: c.models.join(","),
          });
          this.store.put("identity", {
            ...old,
            state: "generated",
            verifiedAt: undefined,
          });
        }
      }
      return {
        key: this.store.reveal(old.credentialId),
        tokenId: old.tokenId,
        baseUrl: source.inferenceUrl || source.url + "/v1",
      };
    }
    if (source.kind === "cpa") {
      if (pinned)
        throw new Problem(
          400,
          "CPA 没有已确认的固定渠道能力，评估请使用客户端直连连接",
        );
      const key = old?.pendingCredentialId
        ? this.store.reveal(old.pendingCredentialId)
        : "arc-" + randomBytes(32).toString("hex");
      const pendingCredentialId =
        old?.pendingCredentialId || this.store.secret(key);
      this.store.put("identity", {
        id: identityId,
        channelId: c.id,
        application: identity,
        pendingCredentialId,
        state: "preparing",
      });
      const response = await this.request(source, "/v0/management/api-keys"),
        keys = response["api-keys"];
      if (!Array.isArray(keys))
        throw new Problem(502, "CPA 推理身份列表格式不兼容");
      if (!keys.includes(key))
        await this.request(source, "/v0/management/api-keys", "PUT", [
          ...keys,
          key,
        ]);
      const after = await this.request(source, "/v0/management/api-keys");
      if (
        !after["api-keys"]?.includes(key) ||
        keys.some((k) => !after["api-keys"].includes(k))
      )
        throw new Problem(502, "CPA 身份回读未确认，原有推理身份需要核对");
      this.store.put("identity", {
        id: identityId,
        channelId: c.id,
        application: identity,
        credentialId: pendingCredentialId,
        state: "generated",
      });
      return { key, baseUrl: source.inferenceUrl };
    }
    if (source.kind !== "newapi")
      throw new Problem(400, "该来源无法创建推理身份");
    const name = old?.pendingName || `arc-${randomUUID()}`;
    let token;
    if (old?.pendingName) {
      const existing = await this.pages(source, "/api/token/search", {
        keyword: name,
      });
      token = existing.find((x) => x.name === name);
      if (!token)
        throw new Problem(
          409,
          "上次推理身份创建未确认，请在网关核对并处理后重试；没有重复创建",
        );
    } else {
      this.store.put("identity", {
        id: identityId,
        channelId: c.id,
        application: identity,
        pendingName: name,
        state: "preparing",
      });
      await this.request(source, "/api/token/", "POST", {
        name,
        expired_time: expiry,
        remain_quota: 0,
        unlimited_quota: true,
        model_limits_enabled: true,
        model_limits: c.models.join(","),
        group: c.group?.split(",")[0] || "default",
        cross_group_retry: false,
      });
    }
    const data = token
      ? [token]
      : await this.pages(source, "/api/token/search", {
          keyword: name,
        });
    token = data.find((x) => x.name === name);
    if (!token) throw new Problem(502, "推理身份创建结果不确定，请在网关核对");
    const dataKey = await this.request(
      source,
      `/api/token/${token.id}/key`,
      "POST",
    );
    const raw = dataKey.key;
    if (typeof raw !== "string") throw new Problem(502, "推理凭据回读失败");
    const key = pinned ? `${raw}-${c.gateway.channelId}` : raw;
    const credentialId = this.store.secret(key);
    this.store.put("identity", {
      id: identityId,
      channelId: c.id,
      application: identity,
      tokenId: token.id,
      credentialId,
      expiry,
      state: "generated",
    });
    return {
      key,
      tokenId: token.id,
      baseUrl: source.url + "/v1",
      credentialId,
    };
  }
  async endEvaluation(e) {
    if (e.tokenId)
      await this.request(
        this.source(e.sourceId),
        "/api/token/?status_only=true",
        "PUT",
        { id: e.tokenId, status: 2 },
      );
  }
}
