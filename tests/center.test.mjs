import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app.mjs";
import { evaluate, headers, dayKey } from "../server/domain.mjs";
import { clientConfig } from "../server/exports.mjs";
async function fixture(
  t,
  fetcher = () => {
    throw new Error("Unexpected external request");
  },
) {
  const dir = mkdtempSync(join(tmpdir(), "arc-test-"));
  const runtime = await createApp({
    dir,
    password: "test",
    serveWeb: false,
    fetcher,
  });
  t.after(async () => {
    await runtime.app.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const login = await runtime.app.inject({
    method: "POST",
    url: "/api/v1/session",
    payload: { password: "test" },
  });
  return {
    ...runtime,
    cookie: login.cookies[0].name + "=" + login.cookies[0].value,
  };
}
const event = {
  eventId: "daily-1",
  kind: "checkin",
  accountId: "a-source",
  site: { name: "Example", url: "https://api.example.com" },
  name: "main",
  occurredAt: "2026-10-14T15:59:59.000Z",
  timezone: "Asia/Shanghai",
  result: "成功",
};
test("ingest role deduplicates, cannot read data, and source observations preserve local entitlement rules", async (t) => {
  const { app, cookie, store, center } = await fixture(t);
  const token = (
    await app.inject({
      method: "POST",
      url: "/api/v1/access-tokens",
      headers: { cookie },
      payload: { role: "ingest" },
    })
  ).json().token;
  const auth = { authorization: "Bearer " + token };
  for (let n = 0; n < 2; n++)
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/ingest",
          headers: auth,
          payload: { events: [event] },
        })
      ).statusCode,
      200,
    );
  assert.equal(store.db.prepare("SELECT count(*) n FROM events").get().n, 1);
  const a = store.list("account")[0];
  store.put("account", {
    ...a,
    benefit: { ...a.benefit, threshold: "余额 < 5", drops: "10:00、19:00" },
  });
  center.ingest("all-api-hub", [
    { ...event, eventId: "observation", kind: "account", balance: 7 },
  ]);
  assert.equal(store.get("account", a.id).benefit.threshold, "余额 < 5");
  assert.equal(center.state().accounts[0].balance, 7);
  assert.equal(
    (await app.inject({ url: "/api/v1/state", headers: auth })).statusCode,
    403,
  );
  assert.equal(
    center.state().accounts[0].checkin["2026-10-14"].reward,
    undefined,
  );
});
test("invalid batch rolls back and business date follows reset timezone", async (t) => {
  const { center, store } = await fixture(t);
  assert.throws(() =>
    center.ingest("all-api-hub", [
      event,
      { ...event, eventId: "bad", occurredAt: "wrong" },
    ]),
  );
  assert.equal(store.list("account").length, 0);
  assert.equal(dayKey("2026-10-14T16:00:00Z", "Asia/Shanghai"), "2026-10-15");
  assert.equal(dayKey("2026-10-14T16:00:00Z", "UTC"), "2026-10-14");
});
test("site aggregation and multiple models do not duplicate account balance; historical import produces no rating samples", async (t) => {
  const { center, store } = await fixture(t);
  const rows = ["a", "b"].map((id) => ({
    sourceId: id,
    accountSourceId: "shared",
    site: { name: "Same", url: "https://same.example.com/" },
    name: id,
    baseUrl: "https://same.example.com/v1",
    models: ["one", "two"],
    key: "fake-secret",
    category: "rp",
  }));
  center.importRows(rows, "file", [{ index: 0 }, { index: 1 }]);
  const s = center.state();
  assert.equal(s.sites.length, 1);
  assert.equal(s.accounts.length, 1);
  assert.equal(s.channels.length, 2);
  assert.equal(s.channels[0].samples, 0);
  assert.ok(!JSON.stringify(s).includes("fake-secret"));
  assert.ok(
    !store.db
      .prepare("SELECT value FROM credentials")
      .get()
      .value.includes("fake-secret"),
  );
});
test("RP editing and manual registration have zero upstream requests and version conflicts retain saved content", async (t) => {
  const { app, cookie, center } = await fixture(t);
  const c = center.createChannel({
    site: { name: "RP", url: "https://rp.example.com" },
    name: "RP",
    baseUrl: "https://rp.example.com/v1",
    models: ["kimi"],
    key: "private-rp",
    category: "rp",
    enabled: true,
  });
  let r = await app.inject({
    method: "PATCH",
    url: "/api/v1/channels/" + c.id,
    headers: { cookie },
    payload: {
      expectedVersion: c.version,
      patch: { note: "人工固定", order: 1 },
    },
  });
  assert.equal(r.statusCode, 200);
  r = await app.inject({
    method: "PATCH",
    url: "/api/v1/channels/" + c.id,
    headers: { cookie },
    payload: { expectedVersion: c.version, patch: { note: "stale" } },
  });
  assert.equal(r.statusCode, 409);
  assert.equal(center.state().channels[0].note, "人工固定");
  const a = center.state().accounts[0];
  r = await app.inject({
    method: "POST",
    url: `/api/v1/accounts/${a.id}/checkins`,
    headers: { cookie },
    payload: { result: "成功" },
  });
  assert.equal(r.statusCode, 200);
  assert.equal(center.state().accounts.length, 1);
});
const now = new Date("2026-10-14T10:00:00Z"),
  rules = { days: 7, samples: 30, good: 98, warn: 95 };
function sampleData() {
  const c = {
    id: "c",
    category: "general",
    enabled: true,
    credentialId: "secret",
    gateway: { sourceId: "new" },
    mode: "auto",
    models: ["m"],
    priority: 100,
    weight: 100,
    accountId: "a",
  };
  const a = {
    id: "a",
    quota: "daily",
    balance: 10,
    benefit: { tz: "Asia/Shanghai" },
    validUntil: "2026-10-14T16:00:00Z",
  };
  const calls = Array.from({ length: 30 }, (_, i) => ({
    channel_id: "c",
    model: "m",
    occurred_at: "2026-10-14T09:00:00Z",
    result: "success",
    ttft: 100 + i,
  }));
  return { c, a, calls };
}
test("eligibility, samples, and expiry determine priority without counting rate/quota/key/input errors as quality", () => {
  const { c, a, calls } = sampleData();
  let r = evaluate([c], [a], calls.slice(0, 29), rules, now)[0];
  assert.equal(r.priority, 100);
  r = evaluate(
    [c],
    [a],
    [
      ...calls,
      ...["rate", "quota", "key", "input"].map((error_type) => ({
        ...calls[0],
        result: "failure",
        error_type,
      })),
    ],
    rules,
    now,
  )[0];
  assert.equal(r.samples, 30);
  assert.equal(r.success, 100);
  assert.equal(r.priority, 400);
  assert.equal(
    evaluate([c], [a], calls, rules, new Date("2026-10-14T16:00:00Z"))[0]
      .priority,
    0,
  );
  assert.equal(
    evaluate([{ ...c, rating: "差" }], [a], calls, rules, now)[0].priority,
    0,
  );
  assert.equal(
    evaluate([{ ...c, mode: "manual" }], [a], calls, rules, now)[0].priority,
    100,
  );
});
test("media submission is pending; text weighting compares the same model and group only", () => {
  const { c, a, calls } = sampleData();
  const media = { ...c, category: "media" };
  const r = evaluate(
    [media],
    [a],
    [...calls.slice(0, 29), { ...calls[0], result: "pending" }],
    rules,
    now,
  )[0];
  assert.equal(r.samples, 29);
  const c2 = { ...c, id: "d", accountId: "a", group: "same" },
    c1 = { ...c, group: "same" };
  const all = [
    ...calls,
    ...calls.map((x) => ({ ...x, channel_id: "d", ttft: 300 })),
  ];
  const rs = evaluate([c1, c2], [a], all, rules, now);
  assert.ok(rs[0].weight > 100);
  assert.ok(rs[1].weight < 100);
  assert.equal(
    evaluate([c1, { ...c2, group: "other" }], [a], all, rules, now)[0].weight,
    100,
  );
});
test("headers normalize, reject authentication/control characters, and appear in generated target config", () => {
  const hs = headers([{ name: "X-Client", value: "claude-code" }]);
  assert.equal(hs[0].name, "x-client");
  assert.throws(() => headers([{ name: "Authorization", value: "x" }]));
  assert.throws(() => headers([{ name: "x", value: "a\r\nb" }]));
  assert.throws(() =>
    headers([
      { name: "x-client", value: "a" },
      { name: "X-Client", value: "b" },
    ]),
  );
  const cfg = JSON.parse(
    clientConfig(
      {
        id: "c",
        name: "c",
        protocol: "Anthropic",
        baseUrl: "https://example.com",
        models: ["m"],
        headers: hs,
      },
      "Claude Code",
      "infer-only",
    ),
  );
  assert.equal(cfg.env.ANTHROPIC_CUSTOM_HEADERS, "x-client: claude-code");
  assert.equal(cfg.env.ANTHROPIC_AUTH_TOKEN, "infer-only");
  assert.throws(() =>
    clientConfig(
      { models: ["m"], headers: [], protocol: "OpenAI" },
      "Claude Code",
      "x",
    ),
  );
});
test("gateway writes only changed configuration, reads back, and stops on external differences", async (t) => {
  let remote = {
      id: 1,
      name: "one",
      base_url: "https://up.example.com",
      models: "m",
      status: 1,
      priority: 100,
      weight: 100,
    },
    writes = 0;
  const fetcher = async (url, options) => {
    if (options.method === "PUT") {
      writes++;
      remote = { ...remote, ...JSON.parse(options.body) };
    }
    if (options.method === "POST") {
      writes++;
      remote.status = JSON.parse(options.body).status;
    }
    return new Response(JSON.stringify({ success: true, data: remote }), {
      status: 200,
    });
  };
  const { store, center, gateways } = await fixture(t, fetcher);
  store.setting("sources", [
    {
      id: "n",
      name: "New API",
      kind: "newapi",
      url: "https://gw.example.com",
      credentialId: store.secret("admin-only"),
    },
  ]);
  const c = center.createChannel({
    site: { name: "one", url: "https://up.example.com" },
    name: "one",
    baseUrl: "https://up.example.com",
    models: ["m"],
    key: "upstream",
    enabled: true,
  });
  store.put("channel", {
    ...store.get("channel", c.id),
    gateway: { sourceId: "n", channelId: 1 },
    applied: {
      name: "one",
      base_url: "https://up.example.com",
      models: ["m"],
      status: 1,
      priority: 100,
      weight: 100,
    },
    priority: 200,
  });
  await gateways.apply(c.id);
  assert.equal(center.state().channels[0].apply, "synced");
  assert.equal(remote.priority, 200);
  remote.weight = 90;
  await assert.rejects(gateways.apply(c.id), (e) => e.statusCode === 409);
  assert.equal(writes, 1);
  assert.equal(center.state().channels[0].apply, "diff");
});
