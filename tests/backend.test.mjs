import test from "node:test";
import assert from "node:assert/strict";
import { issueToken } from "../server/auth.mjs";
import { entitlement, eligible } from "../server/resources.mjs";
import { nextReset } from "../server/domain.mjs";
import { fixture } from "./helpers.mjs";

test("authentication, source-scoped credentials and OpenAPI", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.app.inject({ url: "/api/v2/sites" })).statusCode, 401);
  const read = issueToken(f.store, "read");
  assert.equal(
    (
      await f.call(
        "PATCH",
        `/api/v2/sites/${f.site.id}`,
        { version: 1, changes: { name: "Forbidden" } },
        read,
      )
    ).statusCode,
    403,
  );
  const spec = (await f.app.inject({ url: "/openapi.json" })).json();
  assert.equal(spec.openapi, "3.1.1");
  assert.ok(spec.paths["/api/v2/cron/runs/prepare"]);
  assert.ok(spec.paths["/api/v2/sources/{id}/check"]);
  const sites = (await f.call("GET", "/api/v2/sites")).json();
  assert.equal(sites.items[0].channels[0].purpose, "general");
  assert.ok(!JSON.stringify(sites).includes("sk-fixture-private"));
});

test("legacy All API Hub outbox: dedupe and preserve newer/manual data", async (t) => {
  const f = await fixture(t);
  const ingestToken = issueToken(f.store, "ingest", { source: "all-api-hub" });
  const e = {
    eventId: "checkin-1",
    kind: "checkin",
    accountId: "upstream-account",
    name: "Login",
    occurredAt: "2026-10-21T02:00:00.000Z",
    site: { name: "Fixture", url: "https://upstream.test" },
    balance: 20,
    unit: "USD",
    result: "成功",
  };
  for (let i = 0; i < 2; i++) {
    const r = await f.call(
      "POST",
      "/api/v1/ingest",
      { events: [e] },
      ingestToken,
    );
    assert.equal(r.statusCode, 200, r.body);
    assert.deepEqual(r.json().acknowledgedIds, ["checkin-1"]);
  }
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM events").get().n, 1);
  const id = f.store.ref("all-api-hub", "account", "upstream-account");
  const a = f.store.require("account", id);
  f.store.put("account", {
    ...a,
    quota: "daily",
    benefit: { tz: "Asia/Shanghai", resetAt: "00:00" },
  });
  const r = await f.call(
    "POST",
    "/api/v1/ingest",
    {
      events: [
        {
          ...e,
          eventId: "older",
          kind: "account",
          result: undefined,
          balance: 1,
          occurredAt: "2026-10-20T02:00:00.000Z",
        },
      ],
    },
    ingestToken,
  );
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(f.store.require("account", id).balance, 20);
  assert.equal(f.store.require("account", id).quota, "daily");
  assert.equal(
    f.store.ref("spoofed-source", "account", "upstream-account"),
    undefined,
  );
});

test("source preview, synchronization, preserved purpose and request idempotency", async (t) => {
  const f = await fixture(t);
  f.sources.save({
    name: "Gateway",
    kind: "newapi",
    url: "https://gateway.test",
  });
  const source = f.sources.list().find((s) => s.kind === "newapi");
  f.sources.update(source.id, {
    credentialId: f.store.secret("gateway-admin-secret"),
  });
  f.net.remote.set(5, {
    id: 5,
    name: "Imported",
    base_url: "https://other.test",
    models: "model-A",
    type: 1,
    status: 1,
    group: "default",
  });
  const p = await f.call("POST", `/api/v2/sources/${source.id}/preview`, {
    requestId: "preview",
  });
  await f.app.services.operations.drain();
  assert.equal(f.store.list("channel").length, 1);
  assert.equal(f.store.require("operation", p.json().id).result.total, 1);
  const payload = { requestId: "sync-1", scope: "all" };
  const r = await f.call("POST", `/api/v2/sources/${source.id}/sync`, payload);
  assert.equal(r.statusCode, 202, r.body);
  assert.equal(
    (await f.call("POST", `/api/v2/sources/${source.id}/sync`, payload)).json()
      .id,
    r.json().id,
  );
  assert.equal(
    (
      await f.call("POST", `/api/v2/sources/${source.id}/sync`, {
        ...payload,
        scope: "calls",
      })
    ).statusCode,
    409,
  );
  await f.app.services.operations.drain();
  const id = f.store.ref(source.id, "channel", "5"),
    imported = f.store.require("channel", id);
  f.store.put("channel", { ...imported, category: "rp", note: "manual note" });
  await f.sources.sync(source.id);
  assert.equal(f.store.list("channel").length, 2);
  assert.equal(f.store.require("channel", id).category, "rp");
  assert.equal(f.store.require("channel", id).note, "manual note");
  f.sources.update(source.id, { version: "v1.0.0-rc.45" });
  assert.equal(f.sources.list().find((s) => s.id === source.id).version, 1);
  assert.equal(
    f.sources.save({ name: "Updated source" }, source.id, 1).version,
    2,
  );
  assert.ok(
    f.sources.list().find((s) => s.id === source.id).lastChanges.channels
      .length,
  );
});

test("scan distinguishes website failure and protects the same no-probe credential", async (t) => {
  const f = await fixture(t);
  const rpSite = f.resources.site({
    name: "RP",
    url: "https://rp.test",
    aliases: ["https://rp-api.test"],
  });
  f.store.put("account", { id: "rp-account", siteId: rpSite.id, name: "RP" });
  const rp = f.resources.channel({
    siteId: rpSite.id,
    accountId: "rp-account",
    name: "RP",
    purpose: "rp",
    tags: ["no_probe"],
    baseUrl: "https://rp.test",
  });
  const duplicate = f.resources.channel({
    siteId: rpSite.id,
    accountId: "rp-account",
    name: "Alias",
    baseUrl: "https://rp-api.test",
    credentialId: f.store.secret("shared-rp-key"),
  });
  f.store.put("channel", {
    ...rp,
    credentialId: f.store.secret("shared-rp-key"),
  });
  const result = await f.call("POST", "/api/v2/scans", {
    requestId: "scan-all",
  });
  await f.app.services.operations.drain();
  const op = f.store.require("operation", result.json().id);
  assert.equal(op.state, "succeeded", JSON.stringify(op));
  assert.equal(op.result.excluded.length, 2);
  assert.equal(op.result.sites[0].website.status, "http_error");
  assert.equal(
    f.store.require("channel", f.channel.id).credentialState,
    "present",
  );
  const o = f.store.require("offering", `${f.channel.id}:model-A`);
  assert.equal(o.catalog.present, true);
  assert.equal(o.verification, undefined);
  assert.equal(o.stationMetrics.successRate, 99);
  assert.ok(
    !f.net.requests.some(
      (r) => r.url.includes("rp.test") || r.url.includes("rp-api.test"),
    ),
  );
  assert.equal(eligible(f.store, rp), false);
  assert.equal(eligible(f.store, duplicate), false);
  const publicResult = (await f.call("GET", `/api/v2/operations/${op.id}`))
    .body;
  assert.ok(!publicResult.includes("sk-fixture-private"));
});

test("versions, batching and site merge retain separate account balances", async (t) => {
  const f = await fixture(t);
  const a = await f.call("PATCH", `/api/v2/sites/${f.site.id}`, {
    version: 1,
    changes: { name: "Updated" },
  });
  assert.equal(a.statusCode, 200);
  assert.equal(
    (
      await f.call("PATCH", `/api/v2/sites/${f.site.id}`, {
        version: 1,
        changes: { name: "Lost update" },
      })
    ).statusCode,
    409,
  );
  const other = f.resources.site({ name: "Alias", url: "https://alias.test" });
  f.store.put("account", {
    id: "separate",
    siteId: other.id,
    name: "Separate",
    balance: 8,
  });
  const preview = (
    await f.call("POST", "/api/v2/changes/preview", {
      action: "merge_sites",
      ids: [other.id],
      targetId: f.site.id,
    })
  ).json();
  assert.equal(
    (
      await f.call("POST", `/api/v2/changes/${preview.previewId}/apply`, {
        requestId: "merge",
      })
    ).statusCode,
    200,
  );
  assert.equal(f.store.require("account", "separate").balance, 8);
  assert.equal(f.store.require("account", "account").balance, 100);
  assert.equal(f.store.require("account", "separate").siteId, f.site.id);
  assert.equal(f.resources.sites({}).items.length, 1);
});

test("cron flow pins a target, records result once and applies New API with readback", async (t) => {
  const f = await fixture(t);
  const source = f.sources.save({
    name: "Gateway",
    kind: "newapi",
    url: "https://gateway.test",
  });
  f.sources.update(source.id, {
    credentialId: f.store.secret("gateway-admin"),
  });
  f.store.setting("maintenancePolicy", { enabled: true, autoApply: true });
  f.store.put("channel", {
    ...f.store.require("channel", f.channel.id),
    mode: "auto",
  });
  const cron = issueToken(f.store, "cron", { sourceId: "fn-cron" });
  const catalog = await f.call(
    "POST",
    "/api/v2/cron/tasks",
    {
      tasks: [
        {
          id: "task-1",
          name: "Real scheduled task",
          enabled: true,
          supportsRunConfig: true,
          supportsResult: true,
        },
      ],
    },
    cron,
  );
  assert.equal(catalog.statusCode, 200, catalog.body);
  const evaluation = await f.call("POST", "/api/v2/evaluations", {
    requestId: "eval-1",
    channelId: f.channel.id,
    modelId: "model-A",
    taskRef: { source: "fn-cron", id: "task-1" },
  });
  await f.app.services.operations.drain();
  assert.equal(
    f.store.require("operation", evaluation.json().id).state,
    "waiting",
  );
  const body = { taskId: "task-1", runId: "run-1" };
  const prepared = await f.call(
    "POST",
    "/api/v2/cron/runs/prepare",
    body,
    cron,
  );
  assert.equal(prepared.statusCode, 200, prepared.body);
  assert.equal(prepared.json().configuration.allowFallback, false);
  assert.ok(prepared.json().configuration.apiKey.endsWith("-100"));
  const repeat = await f.call("POST", "/api/v2/cron/runs/prepare", body, cron);
  assert.equal(
    repeat.json().configuration.apiKey,
    prepared.json().configuration.apiKey,
  );
  assert.equal(f.net.tokens.length, 1);
  const receipt = {
    runId: "run-1",
    actualChannelId: f.channel.id,
    actualModelId: "model-A",
    result: "success",
    acceptance: "passed",
    capabilityClass: "strong",
    occurredAt: new Date().toISOString(),
  };
  assert.equal(
    (await f.call("POST", "/api/v2/ingest/task-results", receipt, cron))
      .statusCode,
    409,
    "A successful client receipt cannot pass without gateway request facts",
  );
  f.net.logs.push({
    id: 1,
    type: 2,
    channel: 100,
    token_id: f.net.tokens[0].id,
    model_name: prepared.json().configuration.modelId,
    created_at: Math.floor(Date.now() / 1000),
    request_id: "fixture-cron-request",
    other: "{}",
  });
  const verifiedReceipt = await f.call(
    "POST",
    "/api/v2/ingest/task-results",
    receipt,
    cron,
  );
  assert.equal(
    verifiedReceipt.statusCode,
    200,
    verifiedReceipt.body +
      JSON.stringify(
        f.store.db.prepare("SELECT token_id,model,channel_id FROM calls").all(),
      ),
  );
  assert.equal(
    (await f.call("POST", "/api/v2/ingest/task-results", receipt, cron))
      .statusCode,
    200,
  );
  await f.app.services.operations.drain();
  const o = f.store.require("offering", `${f.channel.id}:model-A`);
  assert.equal(
    o.apply.state,
    "synced",
    JSON.stringify(f.store.list("operation")),
  );
  assert.equal(o.capabilityClass, "strong");
  assert.equal(f.net.remote.get(o.gateway.channelId).models, "model-A");
  assert.equal(f.store.list("run").length, 1);
  assert.equal(
    f.store.db.prepare("SELECT COUNT(*) n FROM calls WHERE source='cron'").get()
      .n,
    0,
  );
});

test("paused tasks and fallback results cannot restore a model", async (t) => {
  const f = await fixture(t);
  f.store.put("task", {
    id: "cron:paused",
    source: "cron",
    externalId: "paused",
    enabled: false,
    supportsRunConfig: true,
    supportsResult: true,
  });
  const r = await f.call("POST", "/api/v2/evaluations", {
    requestId: "paused",
    channelId: f.channel.id,
    modelId: "model-A",
    taskRef: { source: "cron", id: "paused" },
  });
  await f.app.services.operations.drain();
  assert.equal(f.store.require("operation", r.json().id).state, "failed");
  assert.equal(f.store.require("task", "cron:paused").enabled, false);
  f.store.put("offering", {
    id: `${f.channel.id}:model-A`,
    channelId: f.channel.id,
    modelId: "model-A",
  });
  f.store.put("run", {
    id: "cron:run",
    source: "cron",
    externalId: "run",
    taskId: "paused",
    channelId: f.channel.id,
    modelId: "model-A",
    connectionVersion: 1,
  });
  await f.app.services.evaluations.result(
    {
      runId: "run",
      actualChannelId: "other",
      actualModelId: "model-A",
      usedFallback: true,
      result: "success",
      occurredAt: new Date().toISOString(),
    },
    "cron",
  );
  assert.equal(
    f.store.require("offering", `${f.channel.id}:model-A`).verification.result,
    "unconfirmed",
  );
  assert.equal(f.net.requests.length, 0);
});

test("daily quota expiry and overnight windows remain availability, not quality", async (t) => {
  const f = await fixture(t);
  const a = {
    quota: "daily",
    balance: 10,
    validUntil: "2026-10-22T00:00:00Z",
    benefit: { tz: "UTC", windows: [{ start: "22:00", end: "02:00" }] },
  };
  assert.equal(
    entitlement(a, new Date("2026-10-21T23:00:00Z")).available,
    true,
  );
  assert.equal(
    entitlement(a, new Date("2026-10-22T01:00:00Z")).available,
    false,
  );
  assert.equal(
    nextReset("2026-10-21T15:59:00Z", "Asia/Shanghai", "00:00"),
    "2026-10-21T16:00:00.000Z",
  );
  f.store.put("offering", {
    id: "grade",
    channelId: f.channel.id,
    modelId: "model-A",
  });
  const { recordCall } = await import("../server/ingest.mjs");
  for (let i = 0; i < 30; i++)
    recordCall(
      f.store,
      "direct",
      i,
      f.channel.id,
      "model-A",
      new Date().toISOString(),
      "success",
    );
  for (const errorType of ["rate", "quota", "key", "account"])
    recordCall(
      f.store,
      "direct",
      errorType,
      f.channel.id,
      "model-A",
      new Date().toISOString(),
      "failure",
      { errorType },
    );
  const grade = f.app.services.gateway.grade(
    f.store.require("offering", "grade"),
  );
  assert.equal(grade.samples, 30);
  assert.equal(grade.successRate, 100);
  assert.equal(grade.priority, 200);
});

test("restart resumes reads and gateway readback without replaying generation", async (t) => {
  const f = await fixture(t);
  for (const kind of ["scan", "evaluate", "apply"]) {
    const op = f.app.services.operations.start(kind, { requestId: kind });
    f.app.services.operations.update(op.id, { state: "running" });
  }
  f.app.services.operations.recover();
  assert.equal(
    f.store.list("operation").find((o) => o.kind === "scan").state,
    "queued",
  );
  assert.equal(
    f.store.list("operation").find((o) => o.kind === "evaluate").state,
    "waiting",
  );
  assert.equal(
    f.store.list("operation").find((o) => o.kind === "apply").state,
    "queued",
  );
});

test("MCP uses the same resource service and limits read-only access", async (t) => {
  const f = await fixture(t);
  const headers = {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
  };
  const read = issueToken(f.store, "read");
  const req = (method, params, token = read) =>
    f.app.inject({
      method: "POST",
      url: "/mcp",
      headers: { ...headers, authorization: `Bearer ${token}` },
      payload: { jsonrpc: "2.0", id: 1, method, params },
    });
  const list = await req("tools/list", {});
  assert.equal(list.statusCode, 200, list.body);
  assert.ok(
    list.json().result.tools.some((t) => t.name === "resource_list_sites"),
  );
  assert.ok(
    !list.json().result.tools.some((t) => t.name === "resource_update_site"),
  );
  const result = await req("tools/call", {
    name: "resource_list_sites",
    arguments: {},
  });
  assert.equal(result.statusCode, 200, result.body);
  assert.equal(
    result.json().result.structuredContent.result.items[0].id,
    f.site.id,
  );
  assert.ok(!result.body.includes("sk-fixture-private"));
});

test("legacy RP passive events are acknowledged without any upstream requests", async (t) => {
  const f = await fixture(t);
  const c = f.store.require("channel", f.channel.id);
  f.store.put("channel", {
    ...c,
    category: "rp",
    usage: "rp",
    tags: ["no_probe", "no_code"],
  });
  const token = issueToken(f.store, "rp", {
    sourceId: "sillytavern",
    channelIds: [c.id],
  });
  const config = await f.call(
    "GET",
    `/api/v1/rp/${c.id}/config`,
    undefined,
    token,
  );
  assert.equal(config.statusCode, 200);
  assert.deepEqual(config.json().headers, []);
  const event = {
    eventId: "live-call",
    channelId: c.id,
    baseUrl: c.baseUrl,
    protocol: c.protocol,
    model: "model-A",
    occurredAt: new Date().toISOString(),
    origin: "live",
    result: "success",
  };
  for (let i = 0; i < 2; i++) {
    const r = await f.call(
      "POST",
      "/api/v1/rp/calls",
      { device: "fn:test", events: [event] },
      token,
    );
    assert.equal(r.statusCode, 200, r.body);
  }
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM calls").get().n, 1);
  assert.equal(f.net.requests.length, 0);
  assert.equal(
    (await f.call("POST", "/api/v2/scans", { requestId: "rp-scan" }))
      .statusCode,
    202,
  );
  await f.app.services.operations.drain();
  assert.equal(f.net.requests.length, 0);
});
