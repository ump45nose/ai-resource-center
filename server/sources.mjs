import { reconcileCallHealth } from "./channel-health.mjs";
import { hubSyncState } from "./hub-ingest.mjs";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { Problem, publicValue, errorMessage } from "./errors.mjs";
import { errorType } from "./domain.mjs";
import { recordCall } from "./ingest.mjs";

const configurationVersion = (s) => ({
  ...s,
  version: Number.isInteger(s.version) ? s.version : 1,
  ...(typeof s.version === "string" ? { platformVersion: s.version } : {}),
});
const protocolFor = (type) =>
  ({
    1: "OpenAI",
    14: "Anthropic",
    24: "Gemini",
    25: "OpenAI",
    43: "OpenAI",
    60: "OpenAI",
    62: "OpenAI",
    63: "OpenAI",
  })[type] || `New API 类型 ${type}`;
const defaultBase = {
  1: "https://api.openai.com",
  14: "https://api.anthropic.com",
  24: "https://generativelanguage.googleapis.com",
  25: "https://api.moonshot.cn",
  43: "https://api.deepseek.com",
};
const internalUrl = (url) =>
  !!url &&
  /^(localhost$|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|cpa$|new-api$)/.test(
    new URL(url).hostname,
  );
const headerNames = (value) => {
  if (!value) return [];
  try {
    return Object.keys(typeof value === "string" ? JSON.parse(value) : value);
  } catch {
    return [];
  }
};

export class Sources {
  constructor(store, resources, fetcher = fetch) {
    Object.assign(this, { store, resources, fetch: fetcher });
  }
  list() {
    return (this.store.setting("sources") || [])
      .filter((s) => !["cpa", "sillytavern"].includes(s.kind))
      .map((s) => ({
        ...publicValue(configurationVersion(s)),
        credentialStatus: s.credentialId ? "present" : "missing",
        receivedAt: this.store.setting(`received:${s.id}`) || null,
        ...(s.kind === "all-api-hub"
          ? { hubSync: hubSyncState(this.store, s.id) }
          : {}),
      }));
  }
  get(id) {
    const source = (this.store.setting("sources") || []).find(
      (s) => s.id === id,
    );
    if (!source) throw new Problem(404, "来源不存在");
    return configurationVersion(source);
  }
  save(data, id, version) {
    const rows = this.store.setting("sources") || [],
      old = id && this.get(id);
    if (old && old.version !== version)
      throw new Problem(
        409,
        "来源已更新",
        { currentVersion: old.version },
        "version_conflict",
      );
    const source = {
      enabled: true,
      syncEnabled: false,
      inventoryMinutes: 10,
      callsMinutes: 1,
      ...old,
      ...data,
      id: old?.id || randomUUID(),
      version: old ? old.version + 1 : 1,
    };
    if (source.kind === "cpa") throw new Problem(400, "CPA 本版不接入");
    if (
      old?.url &&
      data.url &&
      new URL(old.url).origin !== new URL(data.url).origin
    ) {
      source.credentialId = null;
      source.syncEnabled = false;
      source.cursor = null;
      source.lastInventoryAt = null;
      source.lastCallsAt = null;
    }
    if (source.syncEnabled && !old?.lastInventoryAt)
      throw new Problem(409, "请先预览并完成首次同步，再开启自动同步");
    if (source.kind === "newapi" && !source.url)
      throw new Problem(400, "该来源需要服务地址");
    source.url ??= null;
    this.store.setting("sources", [
      ...rows.filter((s) => s.id !== source.id),
      source,
    ]);
    return this.list().find((s) => s.id === source.id);
  }
  update(id, changes) {
    this.store.setting(
      "sources",
      (this.store.setting("sources") || []).map((s) =>
        s.id === id ? { ...s, ...changes } : s,
      ),
    );
  }
  async configureChannel(source, data) {
    // New API rc.46 separates status transitions from configuration updates.
    const {
      status,
      channel_info,
      created_time,
      test_time,
      response_time,
      balance,
      balance_updated_time,
      used_quota,
      ...changes
    } = data;
    if (Object.keys(changes).every((key) => key === "id")) return null;
    return this.request(source, "/api/channel/", "PUT", changes);
  }
  async request(source, path, method = "GET", body) {
    if (source.kind === "cpa") throw new Problem(409, "CPA 本版不接入");
    const key = source.credentialId && this.store.reveal(source.credentialId);
    const response = await this.fetch(source.url.replace(/\/$/, "") + path, {
      method,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
        ...(source.userId ? { "New-Api-User": String(source.userId) } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: "error",
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok)
      throw new Problem(
        502,
        `${source.name} HTTP ${response.status}`,
        { httpStatus: response.status },
        "source_http_error",
      );
    const data = await response.json();
    if (data.success === false || data.error)
      throw new Problem(
        502,
        `${source.name}：${errorMessage({ message: String(data.message || data.error?.message || "来源接口未完成操作").replaceAll(key || "\0", "[凭据已隐藏]") })}`,
        undefined,
        "source_api_error",
      );
    return data.data ?? data;
  }
  async pages(source, path, query = {}) {
    const rows = [];
    for (let p = 1; p <= 1000; p++) {
      const data = await this.request(
        source,
        `${path}?${new URLSearchParams({ ...query, p, page_size: 100 })}`,
      );
      const items = data.items || data;
      if (!Array.isArray(items)) throw new Problem(502, "来源分页格式不兼容");
      rows.push(...items);
      if (
        items.length < 100 ||
        (data.total != null && rows.length >= data.total)
      )
        return rows;
    }
    throw new Problem(502, "来源分页未结束，请缩小同步范围");
  }
  findChannel(source, externalId) {
    const id =
      this.store.ref(source.id, "channel", externalId) ||
      this.store
        .list("channel")
        .find(
          (c) =>
            c.gateway?.sourceId === source.id &&
            String(c.gateway.channelId) === String(externalId),
        )?.id;
    return id ? this.store.get("channel", id) : null;
  }
  managedBrowserImage(source, row) {
    const c = this.findChannel(source, row.externalId);
    return (
      ["oaichat", "wanzij"].includes(c?.browserImageAdapter?.provider) &&
      c.browserImageAdapter.baseUrl === row.baseUrl &&
      c.baseUrl === row.baseUrl &&
      c.gateway?.sourceId === source.id &&
      String(c.gateway.channelId) === String(row.externalId)
    );
  }
  importChannel(source, row) {
    // Explicitly managed native-image adapters use an internal transport URL.
    // They are public-site resources, rather than subscription reverse proxies.
    if (row.internal && this.managedBrowserImage(source, row))
      row = { ...row, internal: false };
    const offering = this.store
      .list("offering")
      .find(
        (o) =>
          o.gateway?.sourceId === source.id &&
          String(o.gateway.channelId) === row.externalId,
      );
    if (offering)
      return {
        id: offering.channelId,
        name: row.name,
        result: "managed_model_observed",
        modelId: offering.modelId,
      };
    const old = this.findChannel(source, row.externalId);
    if (row.internal || !row.baseUrl) {
      if (old && row.internal)
        this.store.put("channel", {
          ...old,
          internal: true,
          sourceObservation: {
            ...row,
            observedAt: new Date().toISOString(),
            present: true,
          },
        });
      return {
        externalId: row.externalId,
        name: row.name,
        result: "excluded",
        reason: row.internal ? "内部订阅转发" : "来源未提供可识别的上游地址",
      };
    }
    const observed = {
      ...row,
      observedAt: new Date().toISOString(),
      present: true,
    };
    if (old) {
      const previous = old.sourceObservation || {};
      const changedFields = Object.keys(row).filter(
        (key) => !isDeepStrictEqual(previous[key], row[key]),
      );
      this.store.put("channel", {
        ...old,
        sourceObservation: observed,
        internal: false,
      });
      this.store.ref(source.id, "channel", row.externalId, old.id);
      return {
        id: old.id,
        name: row.name,
        result: changedFields.length ? "updated" : "unchanged",
        fields: changedFields,
      };
    }
    const site = this.resources.site(
      { name: row.name, url: new URL(row.baseUrl).origin },
      source.id,
    );
    if (site.curation)
      return {
        externalId: row.externalId,
        name: row.name,
        result: "unlinked",
        reason: "终版已有站点，仅记录来源配置，不新增渠道",
      };
    const accountRef = `gateway:${row.externalId}`;
    let accountId = this.store.ref(source.id, "account", accountRef);
    if (!accountId) {
      accountId = randomUUID();
      this.store.put("account", {
        id: accountId,
        siteId: site.id,
        name: "网关连接 · 账号待关联",
        balance: null,
        unit: "待确认",
        quota: "long",
        benefit: {},
        source: source.id,
        unlinked: true,
      });
      this.store.ref(source.id, "account", accountRef, accountId);
    }
    const c = this.resources.channel({
      siteId: site.id,
      accountId,
      name: row.name,
      baseUrl: row.baseUrl,
      models: row.models,
      protocol: row.protocol,
      enabled: row.enabled,
      gateway: row.gateway,
      group: row.group,
      priority: row.priority,
      weight: row.weight,
      bindings: ["New API"],
      sourceObservation: observed,
    });
    this.store.ref(source.id, "channel", row.externalId, c.id);
    return { id: c.id, name: row.name, result: "created" };
  }
  async inventory(source) {
    if (source.kind !== "newapi")
      throw new Problem(
        400,
        source.kind === "cpa"
          ? "CPA 本版不接入"
          : "此来源由客户端上报，不提供服务器拉取",
      );
    const startedAt = Date.now();
    const channels = await this.pages(source, "/api/channel/");
    this.onInventory?.(source.id, channels, startedAt);
    return channels.map((x) => {
      const baseUrl = x.base_url || defaultBase[x.type] || null;
      return {
        externalId: String(x.id),
        name: x.name,
        baseUrl,
        nativeType: x.type,
        models: (x.models || "").split(",").filter(Boolean),
        protocol: protocolFor(x.type),
        enabled: x.status === 1,
        status: x.status,
        gateway: { sourceId: source.id, channelId: x.id },
        group: x.group,
        priority: x.priority ?? 0,
        weight: x.weight ?? 100,
        modelMapping: x.model_mapping || "",
        headerNames: headerNames(x.header_override),
        hasCompatibilitySettings: !!x.setting,
        internal:
          internalUrl(baseUrl) &&
          !this.managedBrowserImage(source, {
            externalId: String(x.id),
            baseUrl,
          }),
      };
    });
  }
  async preview(id) {
    const source = this.get(id),
      rows = await this.inventory(source);
    const preview = this.store.put("sourcePreview", {
      id: randomUUID(),
      sourceId: id,
      sourceVersion: source.version,
      rows,
      at: new Date().toISOString(),
    });
    return {
      previewId: preview.id,
      sourceId: id,
      items: rows.map((row) => {
        const c = this.findChannel(source, row.externalId);
        return {
          ...row,
          existingChannelId: c?.id || null,
          result:
            row.internal || !row.baseUrl ? "excluded" : c ? "linked" : "new",
        };
      }),
      total: rows.length,
    };
  }
  async check(id) {
    const source = this.get(id);
    if (source.kind === "cpa") throw new Problem(409, "CPA 本版不接入");
    if (source.kind !== "newapi")
      return {
        sourceId: id,
        connected: null,
        mode: "push",
        receivedAt: this.store.setting(`received:${id}`) || null,
        reason: "此来源由客户端上报",
      };
    try {
      const status = await this.request(source, "/api/status"),
        rows = await this.inventory(source);
      const checkedAt = new Date().toISOString();
      this.update(id, {
        checkedAt,
        authorizationError: null,
        platformVersion: status.version,
        logConsumeEnabled: status.log_consume_enabled ?? null,
      });
      return {
        sourceId: id,
        connected: true,
        version: status.version,
        channels: rows.length,
        capabilities: ["inventory", "calls"],
        checkedAt,
      };
    } catch (e) {
      this.update(id, { authorizationError: errorMessage(e) });
      throw e;
    }
  }
  async sync(id, scope = "all", progress = () => {}, previewId) {
    const source = this.get(id);
    if (source.kind === "cpa") throw new Problem(409, "CPA 本版不接入");
    if (source.enabled === false) throw new Problem(409, "来源已暂停");
    if (source.kind !== "newapi")
      return {
        mode: "push",
        receivedAt: this.store.setting(`received:${id}`) || null,
        reason: "此来源由客户端上报",
      };
    const results = { channels: [], calls: 0, unmatched: 0, errors: [] };
    if (scope !== "calls") {
      try {
        let rows;
        if (previewId) {
          const preview = this.store.require("sourcePreview", previewId);
          if (
            preview.sourceId !== id ||
            preview.sourceVersion !== source.version
          )
            throw new Problem(
              409,
              "接入设置已变化，请重新预览",
              undefined,
              "scope_changed",
            );
          rows = preview.rows;
        } else rows = await this.inventory(source);
        this.store.transaction(() => {
          results.channels = rows.map((row) => this.importChannel(source, row));
          const ids = new Set(rows.map((r) => r.externalId));
          for (const c of this.store
            .list("channel")
            .filter(
              (c) =>
                c.gateway?.sourceId === id &&
                !ids.has(String(c.gateway.channelId)),
            )) {
            const was = c.sourceObservation;
            this.store.put("channel", {
              ...c,
              sourceObservation: {
                ...was,
                present: false,
                observedAt: new Date().toISOString(),
              },
            });
            if (was?.present !== false)
              results.channels.push({
                id: c.id,
                name: c.name,
                result: "absent",
                reason: "来源已不再提供，保留历史和人工状态",
              });
          }
          this.update(id, {
            lastInventoryAt: new Date().toISOString(),
            inventoryError: null,
            excludedChannelIds: rows
              .filter((r) => r.internal || !r.baseUrl)
              .map((r) => r.externalId),
          });
        });
        progress({ stage: "渠道资料已同步", result: results });
      } catch (e) {
        if (e.code === "scope_changed") throw e;
        const message = errorMessage(e);
        results.errors.push({ scope: "inventory", message });
        this.update(id, {
          inventoryError: message,
          inventoryAttemptAt: new Date().toISOString(),
        });
      }
    }
    if (scope !== "inventory") {
      try {
        Object.assign(results, await this.calls(this.get(id)));
      } catch (e) {
        const message = errorMessage(e);
        results.errors.push({ scope: "calls", message });
        this.update(id, {
          callsError: message,
          callsAttemptAt: new Date().toISOString(),
        });
      }
    }
    this.update(id, {
      lastAttempt: new Date().toISOString(),
      ...(results.errors.length ? {} : { last: new Date().toISOString() }),
      error: results.errors.map((e) => e.message).join("；") || null,
      lastChanges: results,
    });
    if (results.errors.length)
      throw new Problem(
        502,
        results.errors.map((e) => e.message).join("；"),
        { partialResult: results },
        "source_sync_partial",
      );
    return results;
  }
  async calls(source) {
    const channels = this.store
      .list("channel")
      .filter((c) => c.gateway?.sourceId === source.id);
    const end = Math.floor(Date.now() / 1000),
      since =
        source.callsAdapterVersion === 2
          ? source.cursor || end - 7 * 86400
          : end - 7 * 86400;
    const rows = await this.pages(source, "/api/log/", {
      start_timestamp: since,
      end_timestamp: end,
    });
    let calls = 0,
      added = 0,
      unmatched = 0;
    this.store.transaction(() => {
      for (const x of rows.filter((x) => [2, 5].includes(x.type))) {
        const upstreamChannel = x.channel ?? x.channel_id;
        if ((source.excludedChannelIds || []).includes(String(upstreamChannel)))
          continue;
        const offering = this.store
          .list("offering")
          .find(
            (o) =>
              o.gateway?.sourceId === source.id &&
              String(o.gateway.channelId) === String(upstreamChannel),
          );
        const c = offering
          ? this.store.get("channel", offering.channelId)
          : channels.find(
              (c) => String(c.gateway.channelId) === String(upstreamChannel),
            );
        if (c?.internal) continue;
        if (!c) unmatched++;
        const other =
          typeof x.other === "string"
            ? JSON.parse(x.other || "{}")
            : x.other || {};
        const stream =
          typeof other.stream_status === "string"
            ? other.stream_status
            : other.stream_status?.status;
        const failure =
          x.type === 5 ||
          ["disconnected", "failed", "incomplete", "error"].includes(stream);
        const mediaPending =
          c?.capabilities?.some((v) => ["image", "video"].includes(v)) &&
          ![
            "/v1/images/generations",
            "/v1/images/edits",
            "/v1/chat/completions",
            "/v1/responses",
          ].includes(other.request_path);
        added += Number(
          !this.store.db
            .prepare("SELECT 1 FROM calls WHERE source=? AND source_id=?")
            .get(source.id, String(x.id)),
        );
        recordCall(
          this.store,
          source.id,
          x.id,
          c?.id,
          offering?.modelId || x.model_name || "",
          new Date(x.created_at * 1000).toISOString(),
          mediaPending ? "pending" : failure ? "failure" : "success",
          {
            errorType: failure ? errorType(x.content, other.status_code) : null,
            summary:
              failure &&
              (other.status_code === 410 ||
                /旧接口.*停用|接口已停用/.test(x.content || ""))
                ? "接口已停用"
                : failure &&
                    /封禁|未注册|account.*banned/i.test(x.content || "")
                  ? "账号封禁"
                  : null,
            upstreamChannel,
            latencyMs: x.use_time > 0 ? x.use_time * 1000 : null,
            ttftMs: other.frt,
            requestId: x.request_id,
            tokenId: x.token_id,
            origin:
              this.store
                .list("identity")
                .find(
                  (identity) =>
                    identity.sourceId === source.id &&
                    String(identity.tokenId) === String(x.token_id),
                )?.origin || "live",
            streamStatus: stream,
            isStream: x.is_stream,
            inputTokens: x.prompt_tokens,
            outputTokens: x.completion_tokens,
            group: x.group,
          },
        );
        calls++;
      }
      this.update(source.id, {
        cursor: end - 60,
        callsAdapterVersion: 2,
        lastCallsAt: new Date().toISOString(),
        callsError: null,
        coverage:
          "仅包含 New API 已记录调用；失败日志及流式终态可能不完整。历史导入单列，不与其他来源直接累计。",
        unmatched,
      });
    });
    reconcileCallHealth(
      this.store,
      channels.map((c) => c.id),
    );
    this.resources.onChange?.();
    return { calls, added, unmatched };
  }
}
