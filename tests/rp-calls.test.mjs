import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApp } from "../server/app.mjs";
async function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), "arc-rp-calls-"));
  let outbound = 0;
  const rt = await createApp({
    dir,
    password: "test",
    serveWeb: false,
    fetcher: () => {
      outbound++;
      throw Error("No outbound allowed");
    },
  });
  t.after(async () => {
    await rt.app.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const login = await rt.app.inject({
    method: "POST",
    url: "/api/v1/session",
    payload: { password: "test" },
  });
  const cookie = `arc_session=${login.cookies[0].value}`;
  const c = rt.center.createChannel({
    site: { name: "RP", url: "https://rp.invalid" },
    name: "RP",
    category: "rp",
    baseUrl: "https://rp.invalid/v1",
    protocol: "OpenAI",
    models: ["selected-model"],
    key: "private",
    enabled: false,
    priority: 45,
  });
  rt.store.ref("sillytavern", "channel", "user:profile", c.id);
  rt.store.setting("sources", [
    {
      id: "sillytavern",
      name: "酒馆生产",
      kind: "sillytavern",
      url: "http://tavern.invalid",
    },
  ]);
  const grant = await rt.app.inject({
    method: "POST",
    url: "/api/v1/access-tokens",
    headers: { cookie },
    payload: { role: "rp", channelIds: [c.id] },
  });
  const send = (
    events,
    headers = { authorization: "Bearer " + grant.json().token },
  ) =>
    rt.app.inject({
      method: "POST",
      url: "/api/v1/rp/calls",
      headers,
      payload: { device: "fn:user", events },
    });
  const event = {
    eventId: "real",
    profileId: "profile",
    baseUrl: "https://rp.invalid/v1",
    protocol: "OpenAI",
    model: "actual-model",
    occurredAt: new Date().toISOString(),
    origin: "live",
    result: "pending",
    isStream: true,
  };
  return { ...rt, c, cookie, send, event, outbound: () => outbound };
}
test("RP pending and terminal facts are idempotent, use actual models and leave manual control intact", async (t) => {
  const f = await setup(t);
  assert.equal((await f.send([f.event])).statusCode, 200);
  const success = {
    ...f.event,
    result: "success",
    latency: 1800,
    ttft: 200,
    inputTokens: 12,
    outputTokens: 7,
    tokenBasis: "provider",
    streamStatus: "completed",
  };
  assert.equal((await f.send([success])).statusCode, 200);
  await f.send([f.event]);
  await f.send([success]);
  const rows = f.store.db.prepare("SELECT * FROM calls").all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].channel_id, f.c.id);
  assert.equal(rows[0].result, "success");
  assert.equal(rows[0].input_tokens, 12);
  assert.equal(rows[0].application, "酒馆 · fn:user");
  const c = f.store.get("channel", f.c.id);
  assert.equal(c.enabled, false);
  assert.equal(c.mode, "manual");
  assert.equal(c.priority, 45);
  assert.equal(c.samples, 1);
  assert.deepEqual(c.models, ["selected-model"]);
  assert.equal(f.outbound(), 0);
});
test("RP scope and metadata contract are enforced; address drift stays unlinked instead of being assigned to the old site", async (t) => {
  const f = await setup(t);
  const other = f.center.createChannel({
    site: { name: "other", url: "https://other.invalid" },
    name: "other",
    category: "general",
    models: ["m"],
  });
  assert.equal(
    (await f.send([{ ...f.event, channelId: other.id }])).statusCode,
    403,
  );
  assert.equal(
    (await f.send([{ ...f.event, messages: [{ content: "private" }] }]))
      .statusCode,
    400,
  );
  assert.equal(
    f.store.db.prepare("SELECT COUNT(*) AS n FROM calls").get().n,
    0,
  );
  assert.equal(
    (
      await f.send([
        {
          ...f.event,
          baseUrl: "https://changed.invalid/v1",
          result: "failure",
          errorType: "rate",
          statusCode: 429,
        },
      ])
    ).statusCode,
    200,
  );
  const row = f.store.db.prepare("SELECT * FROM calls").get();
  assert.equal(row.channel_id, "");
  assert.equal(row.error_type, "rate");
  assert.equal(f.store.get("channel", f.c.id).samples, 0);
  assert.equal(f.outbound(), 0);
});
test("historical results remain unknown, estimates stay separate, and live queries exclude history by default", async (t) => {
  const f = await setup(t);
  const history = {
    eventId: "history:one",
    model: "old-model",
    occurredAt: new Date().toISOString(),
    origin: "history",
    result: "unknown",
    latency: 2000,
    outputTokens: 38,
    tokenBasis: "local_estimate",
  };
  assert.equal((await f.send([history])).statusCode, 200);
  await f.send([history]);
  const report = async (q) =>
    (
      await f.app.inject({
        url: "/api/v1/calls?" + q,
        headers: { cookie: f.cookie },
      })
    ).json();
  assert.equal((await report("")).summary.total, 0);
  const h = await report("origin=history&groupBy=model");
  assert.equal(h.summary.total, 1);
  assert.equal(h.summary.unknown, 1);
  assert.equal(h.summary.outputTokens, null);
  assert.equal(h.summary.estimatedOutputTokens, 38);
  assert.equal(h.items[0].channel_id, "");
  assert.equal(h.groups[0].latency, 2000);
  assert.equal(f.store.get("channel", f.c.id).samples, 0);
  assert.equal(
    (await f.send([{ ...history, eventId: "bad-history", result: "success" }]))
      .statusCode,
    400,
  );
});
