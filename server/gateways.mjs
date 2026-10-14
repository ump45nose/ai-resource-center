import { isDeepStrictEqual } from "node:util";
import { randomUUID } from "node:crypto";
import { Problem } from "./center.mjs";
import { errorType, normalizeUrl } from "./domain.mjs";

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
  async applyOnce(id, { force = false } = {}) {
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
      remote = observed(
        await this.request(source, `/api/channel/${c.gateway.channelId}`),
      );
      if (c.applied && !force && !isDeepStrictEqual(remote, c.applied)) {
        this.store.put("channel", {
          ...c,
          apply: "diff",
          external: remote,
          applyMsg: "网关配置与上次回读不同，已暂停覆盖",
        });
        throw new Problem(409, "发现外部配置修改", { external: remote });
      }
      const desired = routing(c);
      if (c.category === "rp") desired.status = 2;
      const update = {
        id: c.gateway.channelId,
        name: desired.name,
        models: desired.models.join(","),
        base_url: desired.base_url,
        priority: desired.priority,
        weight: desired.weight,
      };
      if (
        c.category !== "rp" &&
        !isDeepStrictEqual({ ...remote, status: desired.status }, desired)
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
        detail.ttft ?? null,
        detail.requestId || null,
        detail.tokenId ? String(detail.tokenId) : null,
        detail.streamStatus || null,
        detail.summary?.slice(0, 300) || null,
      );
  }
  async sync(id) {
    const source = this.source(id);
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
        !["diff", "conflict", "failed"].includes(c.apply),
    )) {
      if (
        c.applied &&
        c.priority === c.applied.priority &&
        (c.weight || 100) === c.applied.weight
      )
        continue;
      try {
        await this.apply(c.id);
      } catch {
        /* apply persists an actionable failure on the channel */
      }
    }
  }
  async scheduled() {
    if (this.running) return;
    this.running = true;
    try {
      for (const s of (this.store.setting("sources") || []).filter(
        (s) => s.kind === "newapi",
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
      if (Date.now() - (this.store.setting("evaluatedAt") || 0) >= 3600000) {
        await this.recalculateAndApply();
        this.store.setting("evaluatedAt", Date.now());
      }
    } finally {
      this.running = false;
    }
  }
  async inferenceToken(c, identity, expiry = -1, pinned = false) {
    const source = this.source(c.gateway.sourceId);
    if (source.kind !== "newapi")
      throw new Problem(400, "该网关无法创建独立调用身份");
    const identityId = `${c.id}:${identity}`,
      old = this.store.get("identity", identityId);
    if (old && !pinned)
      return {
        key: this.store.reveal(old.credentialId),
        tokenId: old.tokenId,
        baseUrl: source.url + "/v1",
      };
    const name = `arc-${randomUUID()}`;
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
    const data = await this.pages(source, "/api/token/search", {
      keyword: name,
    });
    const token = data.find((x) => x.name === name);
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
