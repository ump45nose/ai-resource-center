import { createHash } from "node:crypto";
import { automaticCheckin } from "./account-state.mjs";
import { dayKey } from "./domain.mjs";
import { Problem } from "./errors.mjs";
import { entitlement, verified } from "./maintenance-policy.mjs";
import { isInternal, isRemoved } from "./channel-rules.mjs";
import { confirmedCheckin, checkinNotDue } from "./checkin-health.mjs";

const ZONE = "Asia/Taipei";
const CHECKINS =
  "SELECT id,account_id,occurred_at,business_date,data FROM events WHERE business_date>=? AND business_date<=? AND json_extract(data,'$.kind')='checkin'";
const NEWEST = " ORDER BY occurred_at DESC,id DESC";
const shift = (day, days) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);

function dateRange(query = {}, now = new Date()) {
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
function checkinPage(rows, query, scope) {
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

function identities(store, list = store.list("account")) {
  const accounts = new Map(list.map((a) => [a.id, a]));
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

// One row per business date and beneficiary; each group lists its newest event first.
function groupCheckins(ids, sites, events) {
  const groups = new Map(), unresolved = [];
  for (const row of events) {
    const executor = ids.canonical(row.account_id);
    const links = executor && ids.beneficiaries.get(executor.id);
    const account = links?.length === 1 ? links[0] : executor;
    if (!account || links?.length > 1 || !sites.has(account.siteId)) { unresolved.push(row); continue; }
    const event = { ...JSON.parse(row.data), occurredAt: row.occurred_at };
    // The API account's disabled built-in check-in is not the separate worker's result.
    if (account.checkinAccountId && executor.id === account.id &&
        event.reason === "auto_checkin_disabled") continue;
    const key = `${row.business_date}:${account.id}`;
    let group = groups.get(key);
    if (!group) {
      group = { events: [], row: {
        id: key, accountId: account.id, executorAccountId: executor.id,
        accountName: account.name || account.id, siteId: account.siteId,
        siteName: sites.get(account.siteId).name, businessDate: row.business_date,
        timezone: event.timezone || ZONE, occurredAt: row.occurred_at,
        latestResult: event.result || "待确认", reason: event.reason || null,
        method: event.method || null, confirmed: false, confirmedAt: null,
        applicable: !executor.checkinArchive?.active && checkinNotDue(event) !== "skipped",
        rewardText: null, reward: null,
      } };
      groups.set(key, group);
    }
    group.events.push(event);
    if (confirmedCheckin(event)) {
      group.row.confirmed = true;
      group.row.confirmedAt ||= row.occurred_at;
      group.row.rewardText ||= event.reward || null;
    }
  }
  return { groups: [...groups.values()], unresolved };
}

const recorded = (store) => store.db.prepare(
  "SELECT min(business_date) first,max(business_date) last FROM events WHERE json_extract(data,'$.kind')='checkin'",
).get();
const newestRow = (a, b) => b.businessDate.localeCompare(a.businessDate) ||
  b.occurredAt.localeCompare(a.occurredAt) || a.id.localeCompare(b.id);

function checkinRows(store, range, siteId) {
  if (siteId) store.require("site", siteId);
  const ids = identities(store), sites = new Map(store.list("site").map((s) => [s.id, s]));
  const { groups, unresolved } = groupCheckins(ids, sites,
    store.db.prepare(CHECKINS + NEWEST).all(range.start, range.end));
  const bounds = recorded(store);
  return {
    rows: groups.map((g) => g.row).filter((r) => !siteId || r.siteId === siteId).sort(newestRow),
    coverage: { startDate: range.start, endDate: range.end, timezone: range.timezone,
      firstRecordedDate: bounds.first, lastRecordedDate: bounds.last,
      complete: false, unresolvedAccounts: unresolved.length,
      basis: "仅包含来源已接收的签到记录；缺失日期不表示未签到或收益为零" },
  };
}

export function listCheckins(store, query = {}, now = new Date()) {
  const range = dateRange(query, now), { rows, coverage } = checkinRows(store, range, query.siteId);
  return { ...checkinPage(rows, query, [range, query.siteId || null]), coverage };
}

const reasonLabels = {
  account_disabled: "插件账号已停用",
  auto_checkin_disabled: "插件自动签到已关闭",
  detection_disabled: "签到检测已关闭",
  center_archived: "中心已暂停签到",
  no_provider: "站点类型不支持签到",
  no_selected_method: "未配置签到方式",
  balance_threshold: "未达签到门槛",
  method_disabled: "站点暂不允许签到",
  no_available_method: "无可用签到方式",
  status_unavailable: "签到状态读取失败",
  checkin_unconfirmed: "执行未确认",
  authentication_required: "签到站需登录",
  identity_mismatch: "签到账号不一致",
  manual_verification_required: "需要人工验证",
  cancelled: "签到已取消",
};
const automaticMethods = ["自动签到", "自动重试"];

function zoneOf(...zones) {
  for (const zone of zones.filter(Boolean)) {
    try {
      dayKey(0, zone);
      return zone;
    } catch {}
  }
  return ZONE;
}

// Precedence: disabled account, then any completion (event, site status, manual
// mark), archive, today's newest due event unless a later site status says no
// check-in is possible, and finally the automation settings.
function checkinStatus({
  account, executor, shared, observation, statusToday, group, automatic, timezone, today, businessDate,
}) {
  const make = (state, label, tone, detail, basis, more) => ({
    state, label, tone, detail, basis, reason: null, method: null, confirmedAt: null,
    businessDate, timezone, ...more,
  });
  if (account.enabled === false)
    return make("not_applicable", "账号已停用", "neutral", "中心已停用此账号", "settings");
  const confirmed = group?.events.find(confirmedCheckin);
  if (confirmed)
    return make("done",
      confirmed.result === "成功" && automaticMethods.includes(confirmed.method) ? "已自动签到" : "今日已签到",
      "green", "今日签到完成", "event",
      { reason: confirmed.reason || null, method: confirmed.method || null, confirmedAt: group.row.confirmedAt });
  const facts = observation?.checkin;
  const day = (at) => (Number.isFinite(Date.parse(at)) ? dayKey(at, timezone) : null);
  if (statusToday && facts.isCheckedInToday === true)
    return make("done", "今日已签到", "green", "站点状态显示今日已签到", "site_status",
      { method: "站点状态", confirmedAt: facts.statusObservedAt });
  if (facts && facts.isCheckedInToday !== false && (facts.lastCheckInDate === today ||
      (day(observation.observedAt) === today && facts.isCheckedInToday === true)))
    return make("done", "已标记签到", "green", "插件中的人工标记，不是执行结果", "manual_mark",
      { method: "人工标记", confirmedAt: observation.observedAt || null });
  if (executor.checkinArchive?.active)
    return make("not_applicable", "签到已归档", "amber",
      `${executor.checkinArchive.label || "持续失败"}，等待复查`, "settings", { reason: "center_archived" });
  const threshold = executor.benefit?.threshold || account.benefit?.threshold;
  const notNeeded = (reason, basis, more) => make("not_needed", reasonLabels[reason] || "无需签到", "neutral",
    reason === "balance_threshold" ? (threshold ? String(threshold) : "余额充足，暂不符合签到条件") : "今日无需签到",
    basis, { reason, ...more });
  const latest = group?.events[0], due = latest && checkinNotDue(latest), reason = latest?.reason || null;
  const closed = statusToday && (facts.ineligibleReason === "balance_threshold" ? "balance_threshold"
    : facts.availability === "disabled" ? "method_disabled" : null);
  if (latest && due !== "skipped" &&
      !(closed && Date.parse(facts.statusObservedAt) > Date.parse(latest.occurredAt))) {
    const fields = { reason, method: latest.method || null };
    if (due) return notNeeded(reason, "event", fields);
    if (latest.result === "需登录")
      return make("action_required", "签到站需登录", "red", "登录签到站后重试", "event", fields);
    if (latest.result === "需人工操作")
      return reason === "manual_verification_required"
        ? make("action_required", "需要人工验证", "amber", "在签到站完成人工验证后重试", "event", fields)
        : make("action_required", "需人工操作", "red", "需要在签到站人工处理", "event", fields);
    if (["失败", "无法签到"].includes(latest.result))
      return make("failed", reasonLabels[reason] || (latest.result === "失败" ? "签到失败" : "无法签到"),
        "red", "今日签到未完成", "event", fields);
    return make("pending", reasonLabels[reason] || (latest.result === "未执行" ? "签到未执行" : "签到待确认"),
      "amber", reason === "checkin_unconfirmed" ? "尚未确认今日签到成功" : "今日签到结果待确认", "event", fields);
  }
  if (closed) return notNeeded(closed, "site_status");
  const skipped = due === "skipped" ? reason : null;
  if (automatic) {
    const label = shared ? "签到归属待确认"
      : reasonLabels[skipped] || (facts?.configured === false ? "未配置签到方式"
        : facts?.supportStatus === "unknown" ? "签到支持待确认"
          : statusToday && facts.isCheckedInToday === false ? "未签到" : "签到待确认");
    return make("pending", label, "amber",
      shared ? "签到账号同时关联多个账号，结果未归属" : "今日尚未收到签到结果",
      skipped ? "settings" : "none", { reason: skipped });
  }
  return make("not_applicable", "无自动签到", "neutral",
    reasonLabels[skipped] || (observation?.enabled === false ? "插件账号已停用" : "未签到"),
    "settings", { reason: skipped });
}

// Every entrance reads account check-in state from here. An account's day is the
// business day its check-in events are recorded in: the event's zone, else the
// check-in account's reset zone (as at ingest), else Asia/Taipei.
export function checkinStates(store, data, now = new Date(), only) {
  const ids = identities(store, data.accounts), sites = new Map(data.sites.map((s) => [s.id, s]));
  const date = dayKey(now, ZONE), range = [shift(date, -7), shift(date, 1)];
  const executorOf = (a) => (a.checkinAccountId && ids.canonical(a.checkinAccountId)) || a;
  let events;
  if (!only) events = store.db.prepare(CHECKINS + NEWEST).all(...range);
  else {
    const wanted = new Set(only.flatMap((a) => [a.id, executorOf(a).id]));
    const accountIds = data.accounts.filter((a) => wanted.has(ids.canonical(a.id)?.id)).map((a) => a.id);
    events = accountIds.length ? store.db.prepare(
      `${CHECKINS} AND account_id IN (${accountIds.map(() => "?").join()})${NEWEST}`,
    ).all(...range, ...accountIds) : [];
  }
  const { groups, unresolved } = groupCheckins(ids, sites, events);
  const byAccount = new Map();
  for (const group of groups)
    byAccount.set(group.row.accountId, [...(byAccount.get(group.row.accountId) || []), group]);
  const evaluate = (account) => {
    const executor = executorOf(account);
    const shared = ids.beneficiaries.get(executor.id)?.length > 1;
    const own = shared ? [] : byAccount.get(account.id) || [];
    const observation = !shared && executor.sourceObservation?.present !== false
      ? executor.sourceObservation : null;
    const timezone = zoneOf(own[0]?.events[0].timezone, executor.benefit?.tz);
    const today = dayKey(now, timezone), facts = observation?.checkin;
    const statusToday = Number.isFinite(Date.parse(facts?.statusObservedAt)) &&
      dayKey(facts.statusObservedAt, timezone) === today;
    // A site that keys its own period (Chatflows resets at noon) reports the key
    // with a same-day status, and its events carry the same key.
    const businessDate = (statusToday && facts.businessDate) || today;
    const group = own.find((g) => g.row.businessDate === businessDate);
    const automatic = account.enabled !== false && automaticCheckin(store, account);
    const status = checkinStatus({
      account, executor, shared, observation, statusToday, group, automatic, timezone, today, businessDate,
    });
    const row = status.basis === "event" && status.state !== "not_needed" ? { ...group.row, timezone }
      : status.state === "done" ? {
        id: `${businessDate}:${account.id}`, accountId: account.id, executorAccountId: executor.id,
        accountName: account.name || account.id, siteId: account.siteId,
        siteName: sites.get(account.siteId)?.name, businessDate, timezone,
        occurredAt: status.confirmedAt, latestResult: "已签到", reason: null, method: status.method,
        confirmed: true, confirmedAt: status.confirmedAt, applicable: true, rewardText: null, reward: null,
      } : null;
    return { status, automatic,
      row: row && { ...row, state: status.state, basis: status.basis, label: status.label } };
  };
  const cache = new Map();
  return {
    date,
    unresolved: unresolved.filter((r) => r.business_date === date).length,
    of: (account) => {
      if (!cache.has(account.id)) cache.set(account.id, evaluate(account));
      return cache.get(account.id);
    },
  };
}

// Each counted account lands in exactly one of completed, failed, unconfirmed,
// notNeeded or notObserved; disabled and not-applicable accounts are not counted.
const summaryBucket = ({ status, row }) =>
  status.state === "done" ? "completed"
    : ["failed", "action_required"].includes(status.state) ? "failed"
      : status.state === "not_needed" ? "notNeeded"
        : status.state === "pending" ? (row ? "unconfirmed" : "notObserved") : null;

export function dailyResources(resources, now = new Date()) {
  const store = resources.store, data = resources.snapshot();
  const today = checkinStates(store, data, now), date = today.date;
  const sites = new Map(data.sites.filter((s) => !s.removed && !s.mergedInto && !s.resourceExcluded).map((s) => [s.id, s]));
  const accounts = data.accounts.filter((a) => !a.mergedInto && a.role !== "checkin" && sites.has(a.siteId))
    .map((account) => ({ account, ...today.of(account) }));
  const counted = accounts.filter((a) => (a.automatic || a.row) && summaryBucket(a));
  const count = (bucket) => counted.filter((a) => summaryBucket(a) === bucket).length;
  const items = counted.filter((a) => a.row).map((a) => a.row).sort(newestRow);
  const bounds = recorded(store);
  const channels = data.channels.filter((c) => !isRemoved(c) && !isInternal(c) && !c.mergedInto && sites.has(c.siteId));
  const channelIds = new Set(channels.map((c) => c.id));
  const passed = data.offerings.filter((o) => channelIds.has(o.channelId) && verified(o, data.channels.find((c) => c.id === o.channelId)));
  return {
    date, timezone: ZONE, observedAt: now.toISOString(),
    checkinSummary: { expected: counted.length,
      automaticExpected: accounts.filter((a) => a.automatic).length, observed: items.length,
      completed: count("completed"), failed: count("failed"), unconfirmed: count("unconfirmed"),
      notNeeded: count("notNeeded"), notObserved: count("notObserved"), items },
    interventions: items.filter((r) => r.state === "action_required").map((r) => ({
      id: `checkin:${r.accountId}:${date}:${r.latestResult === "需登录" ? "login" : "human"}`,
      siteId: r.siteId, accountId: r.accountId, businessDate: date,
      kind: r.latestResult === "需登录" ? "checkin_login" : "checkin_human_required",
      title: `${r.siteName} · ${r.accountName}：${r.latestResult}`, state: "open", action: "review_checkin",
    })),
    accounts: accounts.map(({ account: a, automatic, status }) => ({ id: a.id, siteId: a.siteId,
      siteName: sites.get(a.siteId).name, name: a.name, enabled: a.enabled !== false,
      automaticCheckin: automatic, entitlement: entitlement(a, now), checkinToday: status })),
    resourceSummary: { sites: sites.size, registeredChannels: channels.length,
      catalogReadableChannels: channels.filter((c) => resources.scanObservation(c, data)?.catalogStatus === "ok").length,
      verifiedModels: passed.length, verificationBasis: "渠道与模型组合的已有任务验证结论，非实时可用性保证" },
    coverage: { startDate: date, endDate: date, timezone: ZONE,
      firstRecordedDate: bounds.first, lastRecordedDate: bounds.last,
      complete: false, unresolvedAccounts: today.unresolved,
      basis: "各账号按签到记录的时区取当前业务日，汇总已接收的签到记录与插件当日签到状态；未收到不表示未签到" },
  };
}
