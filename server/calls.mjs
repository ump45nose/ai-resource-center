import { z } from "zod";

const querySchema = z.object({
  days: z.coerce.number().int().min(1).max(90).default(7),
  channelId: z.string().optional(),
  model: z.string().optional(),
  application: z.string().optional(),
  source: z.string().optional(),
  result: z.enum(["success", "failure", "pending"]).optional(),
  groupBy: z.enum(["channel", "model", "application"]).default("channel"),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
const metrics = `COUNT(*) AS total, SUM(result='success') AS success, SUM(result='failure') AS failure,
 SUM(result='pending') AS pending, AVG(CASE WHEN result='success' THEN latency END) AS latency,
 AVG(CASE WHEN result='success' AND ttft>0 THEN ttft END) AS ttft,
 SUM(input_tokens) AS inputTokens, SUM(output_tokens) AS outputTokens,
 SUM(stream_status='disconnected') AS disconnected`;

export function callReport(store, raw) {
  const q = querySchema.parse(raw);
  const terms = ["occurred_at>=?", "occurred_at<=?"],
    args = [
      new Date(Date.now() - q.days * 86400000).toISOString(),
      new Date().toISOString(),
    ];
  for (const [name, col] of Object.entries({
    channelId: "channel_id",
    model: "model",
    application: "application",
    source: "source",
    result: "result",
  })) {
    if (q[name] !== undefined) {
      terms.push(
        q[name] === "__unknown"
          ? col === "channel_id"
            ? "channel_id=''"
            : `${col} IS NULL`
          : `${col}=?`,
      );
      if (q[name] !== "__unknown") args.push(q[name]);
    }
  }
  const where = terms.join(" AND ");
  const summary = store.db
    .prepare(
      `SELECT ${metrics}, SUM(channel_id='') AS unlinked, SUM(application IS NULL) AS unknownApplication FROM calls WHERE ${where}`,
    )
    .get(...args);
  const column = {
    channel: "channel_id",
    model: "model",
    application: "application",
  }[q.groupBy];
  const groups = store.db
    .prepare(
      `SELECT ${column} AS name, ${metrics} FROM calls WHERE ${where} GROUP BY ${column} ORDER BY total DESC LIMIT 500`,
    )
    .all(...args);
  const names = new Map(store.list("channel").map((c) => [c.id, c.name]));
  const items = store.db
    .prepare(
      `SELECT * FROM calls WHERE ${where} ORDER BY occurred_at DESC, source,source_id DESC LIMIT ? OFFSET ?`,
    )
    .all(...args, q.limit, (q.page - 1) * q.limit);
  return {
    summary,
    groups: groups.map((x) => ({
      ...x,
      label:
        q.groupBy === "channel"
          ? names.get(x.name) || "待关联渠道"
          : x.name || "未关联应用",
    })),
    items: items.map((x) => ({
      ...x,
      channelName: names.get(x.channel_id) || "待关联渠道",
    })),
    page: q.page,
    limit: q.limit,
    coverage: (store.setting("sources") || [])
      .filter((s) => ["newapi", "cpa"].includes(s.kind))
      .map(({ id, name, last, error, coverage }) => ({
        id,
        name,
        last,
        error,
        coverage,
      })),
    options: {
      models: store.db
        .prepare(
          "SELECT DISTINCT model FROM calls WHERE occurred_at>=? ORDER BY model LIMIT 500",
        )
        .all(args[0])
        .map((x) => x.model),
      applications: store.db
        .prepare(
          "SELECT DISTINCT application FROM calls WHERE occurred_at>=? AND application IS NOT NULL ORDER BY application LIMIT 500",
        )
        .all(args[0])
        .map((x) => x.application),
    },
  };
}
