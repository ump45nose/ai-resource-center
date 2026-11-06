import test from "node:test";
import assert from "node:assert/strict";
import { issueToken } from "../server/auth.mjs";
import { checkinStates, dailyResources } from "../server/checkins.mjs";
import { fixture } from "./helpers.mjs";

// Taipei 12:00 on 2026-11-06; the UTC day is also 2026-11-06.
const NOON = new Date("2026-11-06T04:00:00.000Z");
// Taipei 07:30 on 2026-11-06; the UTC day is still 2026-11-05.
const DAWN = new Date("2026-11-05T23:30:00.000Z");

function hub(f, id, { checkin = {}, observation = {}, ...fields } = {}) {
  const site = f.resources.site({ name: id, url: `https://${id}.test` });
  const account = f.store.put("account", {
    id,
    siteId: site.id,
    name: `${id} 账号`,
    balance: 1,
    unit: "USD",
    quota: "long",
    benefit: {},
    sourceObservation: {
      source: "all-api-hub",
      externalId: id,
      siteType: "new-api",
      present: true,
      enabled: true,
      observedAt: "2026-11-06T03:00:00.000Z",
      checkin: { enabled: true, supportStatus: "supported", supported: true, ...checkin },
      ...observation,
    },
    ...fields,
  });
  f.store.ref("all-api-hub", "account", id, account.id);
  return account;
}

async function report(f, token, id, result, fields = {}) {
  const r = await f.call(
    "POST",
    "/api/v1/ingest",
    {
      events: [
        {
          eventId: `${id}:${result}:${fields.occurredAt || "noon"}`,
          kind: "checkin",
          accountId: id,
          occurredAt: "2026-11-06T02:00:00.000Z",
          site: { name: id, url: `https://${id}.test` },
          name: `${id} 账号`,
          timezone: "Asia/Taipei",
          method: "自动签到",
          result,
          ...fields,
        },
      ],
    },
    token,
  );
  assert.equal(r.statusCode, 200, r.body);
}

const stateOf = (daily, id) => daily.accounts.find((a) => a.id === id).checkinToday;

test("one server status drives the daily summary, interventions and failure windows", async (t) => {
  const f = await fixture(t);
  const token = issueToken(f.store, "ingest", { sourceId: "all-api-hub" });
  const { store } = f;
  hub(f, "threshold");
  await report(f, token, "threshold", "无需签到", { reason: "balance_threshold" });
  hub(f, "observed-threshold", {
    checkin: { statusObservedAt: "2026-11-06T03:30:00.000Z", availability: "disabled", ineligibleReason: "balance_threshold" },
  });
  hub(f, "disallowed");
  await report(f, token, "disallowed", "失败", { reason: "method_disabled" });
  hub(f, "recovered", {
    checkin: { statusObservedAt: "2026-11-06T03:30:00.000Z", availability: "disabled", ineligibleReason: "balance_threshold" },
  });
  await report(f, token, "recovered", "失败", { reason: "network_error" });
  hub(f, "marked", { checkin: { enabled: false, lastCheckInDate: "2026-11-06", isCheckedInToday: true } });
  hub(f, "site-status", {
    checkin: { statusObservedAt: "2026-11-06T03:30:00.000Z", lastCheckInDate: "2026-11-06", isCheckedInToday: true },
  });
  hub(f, "login");
  await report(f, token, "login", "需登录", { reason: "authentication_required" });
  hub(f, "disabled", { enabled: false });
  await report(f, token, "disabled", "成功");
  hub(f, "archived", { checkinArchive: { active: true, reason: "website", label: "网站打不开" } });
  await report(f, token, "archived", "失败", { reason: "network_error" });
  hub(f, "pending");
  hub(f, "uncertain");
  await report(f, token, "uncertain", "待确认", { reason: "checkin_unconfirmed" });
  hub(f, "failed");
  await report(f, token, "failed", "失败", { reason: "network_error" });

  const daily = dailyResources(f.resources, NOON);
  assert.equal(daily.date, "2026-11-06");
  const states = Object.fromEntries(
    daily.accounts.map((a) => [a.id, [a.checkinToday.state, a.checkinToday.basis, a.checkinToday.label]]),
  );
  assert.deepEqual(states, {
    account: ["not_applicable", "settings", "无自动签到"],
    threshold: ["not_needed", "event", "未达签到门槛"],
    "observed-threshold": ["not_needed", "site_status", "未达签到门槛"],
    disallowed: ["not_needed", "event", "站点暂不允许签到"],
    recovered: ["not_needed", "site_status", "未达签到门槛"],
    marked: ["done", "manual_mark", "已标记签到"],
    "site-status": ["done", "site_status", "今日已签到"],
    login: ["action_required", "event", "签到站需登录"],
    disabled: ["not_applicable", "settings", "账号已停用"],
    archived: ["not_applicable", "settings", "签到已归档"],
    pending: ["pending", "none", "签到待确认"],
    uncertain: ["pending", "event", "执行未确认"],
    failed: ["failed", "event", "签到失败"],
  });

  const { items, ...counts } = daily.checkinSummary;
  assert.deepEqual(counts, {
    expected: 10,
    automaticExpected: 9,
    observed: 5,
    completed: 2,
    failed: 2,
    unconfirmed: 1,
    notNeeded: 4,
    notObserved: 1,
  });
  assert.equal(
    counts.expected,
    counts.completed + counts.failed + counts.unconfirmed + counts.notNeeded + counts.notObserved,
  );
  assert.deepEqual(
    items.map((r) => [r.accountId, r.state, r.confirmed]).sort(),
    [
      ["failed", "failed", false],
      ["login", "action_required", false],
      ["marked", "done", true],
      ["site-status", "done", true],
      ["uncertain", "pending", false],
    ],
  );
  const marked = items.find((r) => r.accountId === "marked");
  assert.equal(marked.method, "人工标记");
  assert.equal(marked.latestResult, "已签到");
  assert.equal(marked.confirmedAt, "2026-11-06T03:00:00.000Z");
  assert.equal(items.find((r) => r.accountId === "site-status").method, "站点状态");

  assert.deepEqual(daily.interventions, [
    {
      id: "checkin:login:2026-11-06:login",
      siteId: store.require("account", "login").siteId,
      accountId: "login",
      businessDate: "2026-11-06",
      kind: "checkin_login",
      title: "login · login 账号：需登录",
      state: "open",
      action: "review_checkin",
    },
  ]);

  const windows = (id) => store.require("account", id).healthWindows?.checkin?.reason;
  assert.equal(windows("threshold"), undefined);
  assert.equal(windows("disallowed"), undefined);
  assert.equal(windows("failed"), "website");
  assert.equal(windows("login"), "invalid");
});

test("a delegated check-in account reports for its beneficiary on every entrance", async (t) => {
  const f = await fixture(t);
  const token = issueToken(f.store, "ingest", { sourceId: "all-api-hub" });
  const worker = hub(f, "worker", { role: "checkin" });
  const api = hub(f, "api", { checkinAccountId: worker.id, checkin: { enabled: false } });
  await report(f, token, "api", "未执行", { reason: "auto_checkin_disabled", occurredAt: "2026-11-06T03:00:00.000Z" });
  await report(f, token, "worker", "成功", { reward: "5 quota" });

  const daily = dailyResources(f.resources, NOON);
  const status = stateOf(daily, "api");
  assert.equal(status.state, "done");
  assert.equal(status.label, "已自动签到");
  assert.equal(status.method, "自动签到");
  assert.ok(!daily.accounts.some((a) => a.id === "worker"));
  const row = daily.checkinSummary.items.find((r) => r.accountId === "api");
  assert.equal(row.executorAccountId, "worker");
  assert.equal(row.rewardText, "5 quota");

  const data = f.resources.snapshot();
  const site = f.resources.detail(api.siteId, data, checkinStates(f.store, data, NOON));
  assert.deepEqual(site.accounts[0].checkinToday, status);
  assert.deepEqual(site.accounts[0].checkinAccount.checkinToday, status);
  assert.deepEqual(
    f.resources.detail(api.siteId, data).accounts[0].checkinToday,
    checkinStates(f.store, data).of(data.accounts.find((a) => a.id === "api")).status,
  );
});

test("a UTC business-day site is judged by its own current day", async (t) => {
  const f = await fixture(t);
  const token = issueToken(f.store, "ingest", { sourceId: "all-api-hub" });
  hub(f, "fengwind");
  await report(f, token, "fengwind", "成功", { occurredAt: "2026-11-05T16:30:00.000Z", timezone: "UTC" });

  const dawn = dailyResources(f.resources, DAWN);
  assert.equal(dawn.date, "2026-11-06");
  const early = stateOf(dawn, "fengwind");
  assert.deepEqual([early.state, early.businessDate, early.timezone], ["done", "2026-11-05", "UTC"]);
  assert.equal(dawn.checkinSummary.completed, 1);
  assert.equal(dawn.checkinSummary.items[0].businessDate, "2026-11-05");

  const noon = dailyResources(f.resources, NOON);
  const later = stateOf(noon, "fengwind");
  assert.deepEqual([later.state, later.businessDate], ["pending", "2026-11-06"]);
  assert.equal(noon.checkinSummary.notObserved, 1);
  assert.equal(noon.checkinSummary.completed, 0);
});

test("site payloads and the overview expose the same check-in status", async (t) => {
  const f = await fixture(t);
  const token = issueToken(f.store, "ingest", { sourceId: "all-api-hub" });
  const now = new Date().toISOString();
  const marked = hub(f, "marked", {
    observation: { observedAt: now },
    checkin: { enabled: false, isCheckedInToday: true },
  });
  hub(f, "worker", { role: "checkin" });
  const api = hub(f, "api", { checkinAccountId: "worker" });
  await report(f, token, "worker", "需人工操作", { reason: "manual_verification_required", occurredAt: now });

  const overview = (await f.call("GET", "/api/v2/overview")).json();
  for (const account of [marked, api]) {
    const site = (await f.call("GET", `/api/v2/sites/${account.siteId}`)).json();
    assert.deepEqual(site.accounts[0].checkinToday, stateOf(overview.daily, account.id));
  }
  assert.equal(stateOf(overview.daily, "marked").basis, "manual_mark");
  assert.equal(stateOf(overview.daily, "api").state, "action_required");
  assert.equal(overview.daily.interventions[0].kind, "checkin_human_required");
  const listed = (await f.call("GET", "/api/v2/sites?limit=200")).json().items;
  const apiSite = listed.find((s) => s.id === api.siteId);
  assert.equal(apiSite.accounts[0].checkinAccount.checkinToday.label, "需要人工验证");

  const mcp = await f.app.inject({
    method: "POST",
    url: "/mcp",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      authorization: `Bearer ${issueToken(f.store, "read")}`,
    },
    payload: {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "resource_get_site", arguments: { id: api.siteId } },
    },
  });
  assert.equal(mcp.statusCode, 200, mcp.body);
  assert.ok(!mcp.json().result.isError, mcp.body);
  assert.equal(
    mcp.json().result.structuredContent.result.accounts[0].checkinToday.state,
    "action_required",
  );
});
