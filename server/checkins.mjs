import { createHash } from "node:crypto";
import { automaticCheckin } from "./account-state.mjs";
import { dayKey } from "./domain.mjs";
import { Problem } from "./errors.mjs";
import { entitlement, verified } from "./maintenance-policy.mjs";
import { isInternal, isRemoved } from "./channel-rules.mjs";

const ZONE = "Asia/Taipei";
const successful = new Set(["成功", "已签到"]);

export function dateRange(query = {}, now = new Date()) {
  const today = dayKey(now, ZONE);
  const earliest = dayKey(new Date(now.getTime() - 29 * 86400000), ZONE);
  const start = query.start_date || earliest, end = query.end_date || today;
  for (const day of [start, end]) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) ||
        !Number.isFinite(new Date(day + "T00:00:00Z").getTime()) ||
        new Date(day + "T00:00:00Z").toISOString().slice(0, 10) !== day)
      throw new Problem(400, "日期不合法");
  }
  if (start < earliest || end > today || start > end)
    throw new Problem(400, "查询范围须在最近 30 个业务日内");
  return { start, end, timezone: ZONE };
}

// A cursor belongs to one query and one source snapshot. New events require a restart.
export function checkinPage(rows, query, scope) {
  const limit = query.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200)
    throw new Problem(400, "分页参数不合法");
  const revision = createHash("sha256").update(JSON.stringify([scope, rows])).digest("hex").slice(0, 24);
  let offset = 0;
  if (query.cursor) {
    try {
      if (query.cursor.length > 256) throw new Error();
      const cursor = JSON.parse(Buffer.from(query.cursor, "base64url").toString());
      if (!Number.isSafeInteger(cursor.offset) || cursor.offset < 0) throw new Error();
      if (cursor.revision !== revision) throw new Problem(409, "记录已变化，请从首页重读", undefined, "cursor_expired");
      offset = cursor.offset;
    } catch (error) {
      if (error instanceof Problem) throw error;
      throw new Problem(400, "分页游标不合法");
    }
  }
  return {
    items: rows.slice(offset, offset + limit),
    nextCursor: offset + limit < rows.length
      ? Buffer.from(JSON.stringify({ offset: offset + limit, revision })).toString("base64url") : null,
  };
}

function identities(store) {
  const accounts = new Map(store.list("account").map((a) => [a.id, a]));
  const beneficiaries = new Map();
  const canonical = (id) => {
    const seen = new Set();
    while (accounts.get(id)?.mergedInto && !seen.has(id)) {
      seen.add(id); id = accounts.get(id).mergedInto;
    }
    return accounts.get(id);
  };
  for (const account of accounts.values()) {
    if (!account.mergedInto && account.role !== "checkin" && account.checkinAccountId) {
      const executor = canonical(account.checkinAccountId);
      if (executor) {
        const list = beneficiaries.get(executor.id) || [];
        list.push(account); beneficiaries.set(executor.id, list);
      }
    }
  }
  return { accounts, canonical, beneficiaries };
}

export function checkinRows(store, range, siteId) {
  if (siteId) store.require("site", siteId);
  const ids = identities(store), sites = new Map(store.list("site").map((s) => [s.id, s]));
  const groups = new Map();
  let unresolved = 0;
  const events = store.db.prepare(
    "SELECT id,account_id,occurred_at,business_date,data FROM events WHERE business_date>=? AND business_date<=? AND json_extract(data,'$.kind')='checkin' ORDER BY occurred_at DESC,id DESC",
  ).all(range.start, range.end);
  for (const row of events) {
    const executor = ids.canonical(row.account_id);
    const links = executor && ids.beneficiaries.get(executor.id);
    const account = links?.length === 1 ? links[0] : executor;
    if (!account || links?.length > 1 || !sites.has(account.siteId)) { unresolved++; continue; }
    if (siteId && account.siteId !== siteId) continue;
    const event = JSON.parse(row.data);
    // The API account's disabled built-in check-in is not the separate worker's result.
    if (account.checkinAccountId && executor.id === account.id &&
        event.reason === "auto_checkin_disabled") continue;
    const key = `${row.business_date}:${account.id}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        id: key, accountId: account.id, executorAccountId: executor.id,
        accountName: account.name || account.id, siteId: account.siteId,
        siteName: sites.get(account.siteId).name, businessDate: row.business_date,
        timezone: event.timezone || ZONE, occurredAt: row.occurred_at,
        latestResult: event.result || "待确认", reason: event.reason || null,
        notRequired: event.result === "无需签到" || event.reason === "balance_threshold",
        method: event.method || null, confirmed: false, confirmedAt: null,
        applicable: event.result !== "无需签到" && !["balance_threshold", "account_disabled", "auto_checkin_disabled", "no_provider", "no_selected_method"].includes(event.reason),
        rewardText: null, reward: null,
      };
      groups.set(key, group);
    }
    if (successful.has(event.result)) {
      group.confirmed = true;
      group.confirmedAt ||= row.occurred_at;
      group.rewardText ||= event.reward || null;
    }
  }
  const bounds = store.db.prepare(
    "SELECT min(business_date) first,max(business_date) last FROM events WHERE json_extract(data,'$.kind')='checkin'",
  ).get();
  return {
    rows: [...groups.values()].sort((a, b) => b.businessDate.localeCompare(a.businessDate) || b.occurredAt.localeCompare(a.occurredAt) || a.id.localeCompare(b.id)),
    coverage: { startDate: range.start, endDate: range.end, timezone: range.timezone,
      firstRecordedDate: bounds.first, lastRecordedDate: bounds.last,
      complete: false, unresolvedAccounts: unresolved,
      basis: "仅包含来源已接收的签到记录；缺失日期不表示未签到或收益为零" },
  };
}

export function listCheckins(store, query = {}, now = new Date()) {
  const range = dateRange(query, now), { rows, coverage } = checkinRows(store, range, query.siteId);
  return { ...checkinPage(rows, query, [range, query.siteId || null]), coverage };
}

export function dailyResources(resources, now = new Date()) {
  const store = resources.store, date = dayKey(now, ZONE), data = resources.snapshot();
  const { rows, coverage } = checkinRows(store, { start: date, end: date, timezone: ZONE });
  const sites = new Map(data.sites.filter((s) => !s.removed && !s.mergedInto && !s.resourceExcluded).map((s) => [s.id, s]));
  const accounts = data.accounts.filter((a) => !a.mergedInto && a.role !== "checkin" && sites.has(a.siteId));
  const enabled = new Set(accounts.filter((a) => a.enabled !== false).map((a) => a.id));
  const notRequired = new Set(rows.filter((r) => enabled.has(r.accountId) && r.notRequired && !r.confirmed).map((r) => r.accountId));
  const expected = accounts.filter((a) => a.enabled !== false && !notRequired.has(a.id) && automaticCheckin(store, a));
  const today = rows.filter((r) => enabled.has(r.accountId) && (r.applicable || r.confirmed));
  const observed = new Set(today.map((r) => r.accountId));
  const channels = data.channels.filter((c) => !isRemoved(c) && !isInternal(c) && !c.mergedInto && sites.has(c.siteId));
  const channelIds = new Set(channels.map((c) => c.id));
  const passed = data.offerings.filter((o) => channelIds.has(o.channelId) && verified(o, data.channels.find((c) => c.id === o.channelId)));
  return {
    date, timezone: ZONE, observedAt: now.toISOString(),
    checkinSummary: { expected: new Set([...expected.map((a) => a.id), ...observed]).size,
      automaticExpected: expected.length, observed: today.length, notRequired: notRequired.size,
      completed: today.filter((r) => r.confirmed).length,
      failed: today.filter((r) => !r.confirmed && ["失败", "需登录", "需人工操作", "无法签到"].includes(r.latestResult)).length,
      unconfirmed: today.filter((r) => !r.confirmed && !["失败", "需登录", "需人工操作", "无法签到"].includes(r.latestResult)).length,
      notObserved: expected.filter((a) => !observed.has(a.id)).length, items: today },
    interventions: today.filter((r) => ["需登录", "需人工操作"].includes(r.latestResult)).map((r) => ({
      id: `checkin:${r.accountId}:${date}:${r.latestResult === "需登录" ? "login" : "human"}`,
      siteId: r.siteId, accountId: r.accountId, businessDate: date,
      kind: r.latestResult === "需登录" ? "checkin_login" : "checkin_human_required",
      title: `${r.siteName} · ${r.accountName}：${r.latestResult}`, state: "open", action: "review_checkin",
    })),
    accounts: accounts.map((a) => ({ id: a.id, siteId: a.siteId, siteName: sites.get(a.siteId).name,
      name: a.name, enabled: a.enabled !== false, automaticCheckin: a.enabled !== false && automaticCheckin(store, a),
      entitlement: entitlement(a, now) })),
    resourceSummary: { sites: sites.size, registeredChannels: channels.length,
      catalogReadableChannels: channels.filter((c) => resources.scanObservation(c, data)?.catalogStatus === "ok").length,
      verifiedModels: passed.length, verificationBasis: "渠道与模型组合的已有任务验证结论，非实时可用性保证" },
    coverage,
  };
}
