import test from "node:test";
import assert from "node:assert/strict";
import { windowOpen } from "../server/domain.mjs";
import {
  defaults,
  entitlement,
  maintenanceStatus,
  modelPreference,
  policies,
} from "../server/maintenance-policy.mjs";
import { observeTaskHealth } from "../server/channel-health.mjs";
import { smokeSupported } from "../server/verification-task.mjs";
import { fixture } from "./helpers.mjs";

const shanghai = (hhmm) => new Date(`2026-11-06T${hhmm}:00+08:00`);

test("windowOpen applies same-day and overnight windows in the account timezone", () => {
  const tz = "Asia/Shanghai",
    day = [{ start: "09:00", end: "18:00" }],
    night = [{ start: "22:00", end: "02:00" }];
  assert.equal(windowOpen(day, tz, shanghai("08:59")), false);
  assert.equal(windowOpen(day, tz, shanghai("09:00")), true);
  assert.equal(windowOpen(day, tz, shanghai("17:59")), true);
  assert.equal(windowOpen(day, tz, shanghai("18:00")), false);
  assert.equal(windowOpen(day, "UTC", shanghai("09:00")), false);
  assert.equal(windowOpen(night, tz, shanghai("21:59")), false);
  assert.equal(windowOpen(night, tz, shanghai("22:00")), true);
  assert.equal(windowOpen(night, tz, shanghai("00:00")), true);
  assert.equal(windowOpen(night, tz, shanghai("01:59")), true);
  assert.equal(windowOpen(night, tz, shanghai("02:00")), false);
  assert.equal(
    windowOpen([{ start: "00:00", end: "00:30" }], tz, shanghai("00:10")),
    true,
  );
  assert.equal(windowOpen([], tz, shanghai("21:59")), true);
});

test("entitlement closes outside account windows in the account timezone", () => {
  const account = {
    status: "正常",
    balance: 10,
    quota: "long",
    benefit: {
      tz: "Asia/Kolkata",
      windows: [
        { start: "09:30", end: "18:00" },
        { start: "22:00", end: "01:15" },
      ],
    },
  };
  for (const [utc, open] of [
    ["03:59", false],
    ["04:00", true],
    ["12:29", true],
    ["12:30", false],
    ["16:29", false],
    ["16:30", true],
    ["19:44", true],
    ["19:45", false],
  ])
    assert.equal(
      entitlement(account, new Date(`2026-11-06T${utc}:00Z`)).reasons.includes(
        "窗口关闭",
      ),
      !open,
      utc,
    );
});

test("a closed window schedules the next check at its start", async (t) => {
  const f = await fixture(t);
  f.store.setting("maintenancePolicy", { enabled: true });
  f.store.put("account", {
    ...f.store.require("account", f.account.id),
    benefit: {
      tz: "Asia/Shanghai",
      windows: [{ start: "22:00", end: "02:00" }],
    },
  });
  const status = maintenanceStatus(
    f.store,
    f.store.require("channel", f.channel.id),
    { now: shanghai("12:00").getTime() },
  );
  assert.equal(status.nextCheckAt, shanghai("22:00").toISOString());
  assert.equal(status.waitingFor, "窗口关闭");
});

test("policies omit retired interval keys so the WebUI can save what it reads", async (t) => {
  const f = await fixture(t);
  assert.ok(!("syncMinutes" in defaults) && !("callsMinutes" in defaults));
  f.store.setting("maintenancePolicy", {
    ...defaults,
    syncMinutes: 10,
    callsMinutes: 1,
    maxCandidates: 4,
  });
  const summary = (await f.call("GET", "/api/v2/maintenance")).json();
  for (const p of [policies(f.store), summary.policy]) {
    assert.equal(Object.hasOwn(p, "syncMinutes"), false);
    assert.equal(Object.hasOwn(p, "callsMinutes"), false);
    assert.equal(p.maxCandidates, 4);
  }
  const read = await f.call("GET", "/api/v2/policies");
  assert.equal(read.statusCode, 200, read.body);
  const saved = await f.call("PATCH", "/api/v2/policies", {
    changes: read.json(),
  });
  assert.equal(saved.statusCode, 200, saved.body);
  assert.deepEqual(saved.json(), read.json());
  assert.equal(
    Object.hasOwn(f.store.setting("maintenancePolicy"), "syncMinutes"),
    false,
  );
});

test("scan progress counts a target skipped mid-scan as completed", async (t) => {
  const f = await fixture(t);
  const site = f.resources.site({ name: "Second", url: "https://second.test" });
  f.store.put("account", {
    id: "second",
    siteId: site.id,
    name: "Second",
    balance: 5,
  });
  const second = f.resources.channel({
    siteId: site.id,
    accountId: "second",
    name: "Second",
    baseUrl: "https://second.test/v1",
    models: ["model-A"],
    enabled: true,
  });
  f.store.put("channel", {
    ...second,
    credentialId: f.store.secret("sk-second-private"),
  });
  const updates = [];
  const scan = await f.app.services.scans.run({}, (update) => {
    if (!updates.length)
      f.store.put("channel", {
        ...f.store.require("channel", second.id),
        tags: ["no_probe"],
      });
    updates.push(update.result);
  });
  assert.equal(scan.sites.length, 1);
  assert.equal(updates[0].total, 2);
  assert.deepEqual(
    [updates.at(-1).completed, updates.at(-1).total],
    [2, 2],
    JSON.stringify(updates.map((u) => [u.completed, u.total])),
  );
  assert.ok(
    updates.every((u, i) => !i || u.completed >= updates[i - 1].completed),
  );
});

test("model preference and small-task support keep their rules", () => {
  assert.deepEqual(modelPreference("GPT-5.2", defaults), {
    proposedClass: "strong",
    rank: 0,
  });
  assert.deepEqual(modelPreference("minimax-m3", defaults), {
    proposedClass: "execution",
    rank: 1,
  });
  assert.equal(modelPreference("gpt-5-mini", defaults), null);
  assert.equal(modelPreference("claude-haiku-5", defaults), null);
  assert.equal(modelPreference("unknown-model", defaults), null);
  assert.equal(smokeSupported({ protocol: "OpenAI" }), true);
  assert.equal(smokeSupported({ protocol: "Anthropic" }), false);
  assert.equal(
    smokeSupported({ protocol: "OpenAI", tags: ["client_restricted"] }),
    false,
  );
  assert.equal(
    smokeSupported({ protocol: "OpenAI", category: "client", client: "cli" }),
    false,
  );
});

test("account bans count against task health; other account errors do not", async (t) => {
  const f = await fixture(t);
  f.store.setting("maintenancePolicy", { enabled: true });
  const offering = f.store.put("offering", {
    id: `${f.channel.id}:model-A`,
    channelId: f.channel.id,
    modelId: "model-A",
  });
  const fail = (operationId, reason) =>
    observeTaskHealth(f.store, offering, {
      result: "failure",
      errorType: "account",
      reason,
      operationId,
      at: new Date().toISOString(),
      connectionVersion: 1,
    });
  fail("verify", "账号需验证");
  assert.equal(f.store.require("offering", offering.id).health.blocked, undefined);
  fail("ban", "账号封禁");
  const health = f.store.require("offering", offering.id).health;
  assert.equal(health.blocked, true);
  assert.equal(health.failureType, "invalid");
});
