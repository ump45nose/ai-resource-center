import { paginate } from "./resources.mjs";

function select(store, table, scope, filters = []) {
  const clauses = [],
    args = [];
  if (scope) {
    const [column, ids] = scope;
    if (!ids.length) return [];
    clauses.push(`${column} IN (${ids.map(() => "?").join(",")})`);
    args.push(...ids);
  }
  for (const [field, operator, value] of filters)
    if (value) {
      clauses.push(`${field}${operator}?`);
      args.push(value);
    }
  return store.db
    .prepare(
      `SELECT * FROM ${table} ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""} ORDER BY occurred_at DESC`,
    )
    .all(...args);
}

export function history(store, a) {
  const ids = a.channelId
    ? [a.channelId]
    : a.siteId
      ? store
          .list("channel")
          .filter((c) => c.siteId === a.siteId)
          .map((c) => c.id)
      : null;
  if (a.kind === "operations")
    return paginate(
      store
        .list("operation")
        .filter(
          (o) =>
            !ids ||
            ids.includes(o.input.channelId) ||
            o.input.channelIds?.some((id) => ids.includes(id)),
        ),
      a,
    );
  if (a.kind === "changes")
    return paginate(
      select(store, "actions", ids && ["target", ids]).map((r) => ({
        ...r,
        data: JSON.parse(r.data),
      })),
      a,
    );
  return {
    ...paginate(
      select(store, "calls", ids && ["channel_id", ids], [
        ["model", "=", a.modelId],
        ["occurred_at", ">=", a.from],
        ["occurred_at", "<=", a.to],
      ]),
      a,
    ),
    coverage: "按来源保存；不同来源未确认关联的请求不能直接相加",
  };
}
