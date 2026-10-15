import { z } from "zod";
import { Problem } from "./center.mjs";
import { canonicalApi, errorLabel } from "./domain.mjs";

const eventSchema = z
  .object({
    eventId: z.string().min(1).max(160),
    profileId: z.string().max(160).optional(),
    channelId: z.string().optional(),
    baseUrl: z.url().optional(),
    protocol: z
      .enum(["OpenAI", "OpenAI Responses", "Anthropic", "Gemini"])
      .optional(),
    model: z.string().max(300),
    occurredAt: z.iso.datetime(),
    origin: z.enum(["live", "history"]),
    result: z.enum(["pending", "success", "failure", "cancelled", "unknown"]),
    latency: z.number().min(0).nullable().optional(),
    ttft: z.number().min(0).nullable().optional(),
    isStream: z.boolean().optional(),
    inputTokens: z.number().int().min(0).optional(),
    outputTokens: z.number().int().min(0).optional(),
    tokenBasis: z.enum(["provider", "local_estimate"]).optional(),
    errorType: z
      .enum([
        "rate",
        "quota",
        "key",
        "account",
        "input",
        "cancelled",
        "upstream",
      ])
      .optional(),
    statusCode: z.number().int().min(100).max(599).optional(),
    streamStatus: z
      .enum(["completed", "disconnected", "failed", "cancelled", "unknown"])
      .optional(),
  })
  .strict();
const batchSchema = z
  .object({
    device: z.string().min(1).max(160),
    events: z.array(eventSchema).min(1).max(100),
  })
  .strict();

export function ingestRpCalls(center, gateways, auth, body) {
  const { device, events } = batchSchema.parse(body),
    store = center.store;
  const allowed = store
    .list("channel")
    .filter(
      (c) =>
        c.category === "rp" &&
        (auth.role === "admin" || auth.scope.channelIds.includes(c.id)),
    );
  const source = auth.scope.sourceId || "sillytavern";
  const acknowledgedIds = [];
  store.transaction(() => {
    for (const e of events) {
      if (e.channelId && !allowed.some((c) => c.id === e.channelId))
        throw new Problem(403, "RP 连接未授权");
      let c = e.channelId
        ? allowed.find((c) => c.id === e.channelId)
        : undefined;
      if (!c && e.profileId) {
        const mapped = store.ref(
          source,
          "channel",
          `${device.replace(/^fn:/, "")}:${e.profileId}`,
        );
        if (mapped) c = allowed.find((c) => c.id === mapped);
      }
      if (!c && e.profileId) {
        const matches = allowed.filter((c) =>
          [c.nativeCredentialRef, c.tavern].some(
            (r) => r?.device === device && r?.profileId === e.profileId,
          ),
        );
        if (matches.length === 1) c = matches[0];
      }
      // The actual request address takes precedence over an old saved profile.
      if (
        c &&
        e.origin === "live" &&
        (!e.baseUrl ||
          !e.protocol ||
          c.protocol !== e.protocol ||
          canonicalApi(c.baseUrl, c.protocol) !==
            canonicalApi(e.baseUrl, e.protocol))
      )
        c = undefined;
      if (e.origin === "history" && !e.profileId && !e.channelId) c = undefined;
      if (e.origin === "history" && e.result !== "unknown")
        throw new Problem(400, "历史保存结果必须保留终态未知");
      const id = `${device}:${e.eventId}`;
      const old = store.db
        .prepare("SELECT result FROM calls WHERE source=? AND source_id=?")
        .get(source, id);
      if (old && old.result !== "pending") {
        acknowledgedIds.push(e.eventId);
        continue;
      }
      const summary =
        e.origin === "history"
          ? "历史保存结果；生成终态与原始站点未记录"
          : e.result === "unknown"
            ? "未采集到明确生成终态"
            : e.result === "cancelled"
              ? "用户或客户端取消"
              : e.result === "failure"
                ? `${e.statusCode ? `HTTP ${e.statusCode} · ` : ""}${errorLabel(e.errorType || "upstream")}`
                : null;
      gateways.call(source, id, c, e.model, e.occurredAt, e.result, {
        latency: e.latency,
        ttft: e.ttft,
        errorType: e.errorType,
        application: `酒馆 · ${device}`,
        upstreamChannel: e.profileId,
        requestId: e.eventId,
        isStream: e.isStream,
        streamStatus: e.streamStatus,
        inputTokens: e.inputTokens,
        outputTokens: e.outputTokens,
        tokenBasis: e.tokenBasis,
        origin: e.origin,
        summary,
      });
      acknowledgedIds.push(e.eventId);
    }
    const now = new Date().toISOString();
    if (events.some((e) => e.origin === "live"))
      store.setting("received:sillytavernCalls", now);
    if (events.some((e) => e.origin === "history"))
      store.setting("received:sillytavernHistory", now);
    store.setting(
      "sources",
      (store.setting("sources") || []).map((s) =>
        s.id === source
          ? {
              ...s,
              last: now,
              error: null,
              coverage:
                "真实请求由酒馆扩展采集；未收到终态保留待终态。历史留存不包含失败或可靠站点归属，本地 Token 估算单列",
            }
          : s,
      ),
    );
  });
  center.recompute();
  return { acknowledgedIds };
}
