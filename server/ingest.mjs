import { reconcileCheckinBalances } from "./account-state.mjs";
import { observeCheckinHealth } from "./checkin-health.mjs";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { dayKey, nextReset } from "./domain.mjs";
import { Problem } from "./errors.mjs";

export const accountEvent = z
  .object({
    eventId: z.string().min(1),
    kind: z.enum(["account", "checkin"]),
    accountId: z.string().min(1),
    occurredAt: z.iso.datetime(),
    site: z.object({
      name: z.string(),
      url: z.url(),
      checkinUrl: z.url().optional(),
    }),
    name: z.string(),
    balance: z.number().nullable().optional(),
    dailyBalance: z.number().nonnegative().nullable().optional(),
    longBalance: z.number().nonnegative().nullable().optional(),
    unit: z.string().optional(),
    status: z.string().optional(),
    businessDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    timezone: z.string().optional(),
    method: z.string().optional(),
    result: z
      .enum([
        "成功",
        "已签到",
        "失败",
        "待确认",
        "需登录",
        "需人工操作",
        "未执行",
        "无法签到",
      ])
      .optional(),
    reason: z.string().optional(),
    reward: z.string().optional(),
  })
  .strict();

export function ingestAccounts(resources, source, events) {
  const store = resources.store;
  const balances = [];
  const result = store.transaction(() => {
    const acknowledgedIds = [];
    for (const raw of events) {
      const e = accountEvent.parse(raw),
        eventId = `${source}:${e.eventId}`;
      if (store.db.prepare("SELECT id FROM events WHERE id=?").get(eventId)) {
        acknowledgedIds.push(e.eventId);
        continue;
      }
      if (e.kind === "checkin" && !e.result)
        throw new Problem(400, "签到事件缺少结果");
      const site = resources.site(e.site, source);
      const id = store.ref(source, "account", e.accountId);
      const old = id && store.get("account", id);
      const fresh =
        !old?.confirmedAt ||
        !Number.isFinite(Date.parse(old.confirmedAt)) ||
        Date.parse(e.occurredAt) >= Date.parse(old.confirmedAt);
      const account = old || {
        id: randomUUID(),
        siteId: site.id,
        name: e.name,
        source,
        sourceId: e.accountId,
        balance: null,
        quota: "long",
        benefit: {},
      };
      if (fresh && e.balance !== undefined) {
        if (e.balance !== null && e.occurredAt !== old?.confirmedAt)
          balances.push(account.id);
        Object.assign(account, {
          balance: e.balance,
          unit: e.unit || account.unit || "待确认",
          confirmedAt: e.occurredAt,
          ...(e.dailyBalance !== undefined
            ? { dailyBalance: e.dailyBalance }
            : {}),
          ...(e.longBalance !== undefined
            ? { longBalance: e.longBalance }
            : {}),
        });
        if (
          account.quota === "daily" &&
          account.benefit.tz &&
          account.benefit.resetAt
        )
          account.validUntil = nextReset(
            e.occurredAt,
            account.benefit.tz,
            account.benefit.resetAt,
          );
      }
      if (!account.observedAt || e.occurredAt >= account.observedAt)
        Object.assign(account, {
          observedAt: e.occurredAt,
          status: e.status || account.status || "正常",
        });
      store.put("account", { ...account, version: old ? old.version + 1 : 1 });
      store.ref(source, "account", e.accountId, account.id);
      store.db
        .prepare("INSERT INTO events VALUES(?,?,?,?,?)")
        .run(
          eventId,
          account.id,
          e.occurredAt,
          e.businessDate ||
            dayKey(
              e.occurredAt,
              e.timezone || account.benefit?.tz || "Asia/Shanghai",
            ),
          JSON.stringify({ ...e, source }),
        );
      acknowledgedIds.push(e.eventId);
      if (e.kind === "checkin") observeCheckinHealth(store, account.id, e);
    }
    store.setting(`received:${source}`, new Date().toISOString());
    return { acknowledgedIds };
  });
  balances.push(...reconcileCheckinBalances(store, balances));
  resources.reconcileAccountState(balances);
  return result;
}

export function recordCall(
  store,
  source,
  id,
  channelId,
  modelId,
  occurredAt,
  result,
  fields = {},
) {
  const columns = [
    "source",
    "source_id",
    "channel_id",
    "model",
    "occurred_at",
    "result",
    "error_type",
    "latency",
    "ttft",
    "request_id",
    "token_id",
    "stream_status",
    "summary",
    "upstream_channel",
    "application",
    "input_tokens",
    "output_tokens",
    "is_stream",
    "group_name",
    "token_basis",
    "origin",
    "legacy_import",
  ];
  const values = [
    source,
    String(id),
    channelId || "",
    modelId,
    occurredAt,
    result,
    fields.errorType,
    fields.latencyMs,
    fields.ttftMs,
    fields.requestId,
    fields.tokenId == null ? null : String(fields.tokenId),
    fields.streamStatus,
    fields.summary,
    fields.upstreamChannel == null ? null : String(fields.upstreamChannel),
    fields.application,
    fields.inputTokens,
    fields.outputTokens,
    fields.isStream == null ? null : Number(fields.isStream),
    fields.group,
    fields.tokenBasis,
    fields.origin || "live",
    0,
  ].map((v) => v ?? null);
  const before = store
    .sql(
      "SELECT channel_id,result,occurred_at FROM calls WHERE source=? AND source_id=?",
    )
    .get(values[0], values[1]);
  store
    .sql(
      `INSERT INTO calls(${columns}) VALUES(${columns.map(() => "?")}) ON CONFLICT(source,source_id) DO UPDATE SET ${columns
        .slice(2)
        .map((c) => `${c}=excluded.${c}`)
        .join(",")}`,
    )
    .run(...values);
  store.noteCall(before, {
    channel_id: values[2],
    result: values[5],
    occurred_at: values[4],
  });
}

export function receipt(store, source, eventId, action) {
  return store.transaction(() => {
    const old = store.db
      .prepare("SELECT data FROM receipts WHERE source=? AND event_id=?")
      .get(source, eventId);
    if (old) return JSON.parse(old.data);
    const result = action();
    store.db
      .prepare("INSERT INTO receipts VALUES(?,?,?)")
      .run(source, eventId, JSON.stringify(result));
    return result;
  });
}
