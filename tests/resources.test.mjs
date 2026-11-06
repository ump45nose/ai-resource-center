import test from "node:test";
import assert from "node:assert/strict";
import { issueToken } from "../server/auth.mjs";
import { ingestRpCalls } from "../server/rp-calls.mjs";
import { recordCall } from "../server/ingest.mjs";
import { listCheckins } from "../server/checkins.mjs";
import { digest } from "../server/canonical.mjs";
import { fixture } from "./helpers.mjs";

test("nested transactions join the outer one and roll back together", async (t) => {
  const { store } = await fixture(t);
  const probes = () => store.list("probe").map((p) => p.id);
  assert.throws(
    () =>
      store.transaction(() => {
        store.put("probe", { id: "outer" });
        store.transaction(() => {
          store.put("probe", { id: "inner" });
          throw new Error("inner failed");
        });
      }),
    /inner failed/,
  );
  assert.deepEqual(probes(), []);
  assert.throws(
    () =>
      store.transaction(() => {
        store.put("probe", { id: "outer" });
        try {
          store.transaction(() => {
            store.put("probe", { id: "inner" });
            throw new Error("swallowed");
          });
        } catch {}
      }),
    /swallowed/,
  );
  assert.deepEqual(probes(), []);
  store.transaction(() => {
    store.put("probe", { id: "outer" });
    store.transaction(() => store.put("probe", { id: "inner" }));
  });
  assert.deepEqual(probes(), ["outer", "inner"]);
  assert.equal(store.db.isTransaction, false);
});

test("a rejected channel update leaves no partial writes", async (t) => {
  const f = await fixture(t);
  const other = f.resources.site({ name: "Other", url: "https://other.test" });
  f.store.put("account", { id: "foreign", siteId: other.id, name: "Foreign" });
  const { version } = f.store.require("channel", f.channel.id);
  const r = await f.call("PATCH", `/api/v2/channels/${f.channel.id}`, {
    version,
    changes: { accountId: "foreign" },
  });
  assert.equal(r.statusCode, 400, r.body);
  assert.equal(f.store.require("account", "account").managedCredentials, undefined);
  assert.equal(f.store.require("channel", f.channel.id).version, version);
});

test("RP calls from a token without channel scope are refused or acknowledged", async (t) => {
  const f = await fixture(t);
  const c = f.store.put("channel", {
    ...f.store.require("channel", f.channel.id),
    category: "rp",
    usage: "rp",
  });
  const token = issueToken(f.store, "rp", { sourceId: "sillytavern" });
  const event = {
    eventId: "scoped",
    channelId: c.id,
    baseUrl: c.baseUrl,
    protocol: c.protocol,
    model: "model-A",
    occurredAt: new Date().toISOString(),
    origin: "live",
    result: "success",
  };
  const send = (events, bearer = token) =>
    f.call("POST", "/api/v1/rp/calls", { device: "fn:test", events }, bearer);
  const denied = await send([event]);
  assert.equal(denied.statusCode, 403, denied.body);
  assert.equal(denied.json().message, "RP 连接未授权");
  const { channelId, ...unbound } = event;
  const ack = await send([{ ...unbound, eventId: "unbound" }]);
  assert.equal(ack.statusCode, 200, ack.body);
  assert.deepEqual(ack.json().acknowledgedIds, ["unbound"]);
  const connections = await f.call("GET", "/api/v1/rp/connections", undefined, token);
  assert.deepEqual(connections.json(), []);
  assert.equal((await send([event], issueToken(f.store, "read"))).statusCode, 403);
  const direct = ingestRpCalls(
    { store: f.store, recompute() {} },
    { call() {} },
    { role: "rp", scope: {} },
    { device: "fn:test", events: [{ ...unbound, eventId: "direct" }] },
  );
  assert.deepEqual(direct.acknowledgedIds, ["direct"]);
});

test("hub credentials reuse a stored key by fingerprint", async (t) => {
  const f = await fixture(t);
  const ingest = issueToken(f.store, "ingest", { sourceId: "all-api-hub" });
  const inventory = await f.call(
    "POST",
    "/api/v2/ingest/inventory",
    {
      eventId: "inventory",
      occurredAt: "2026-11-06T01:00:00.000Z",
      deviceId: "device",
      accounts: [
        {
          id: "hub-account",
          name: "Hub",
          site: { name: "Hub", url: "https://hub.test" },
          observedAt: "2026-11-06T01:00:00.000Z",
          balance: 1,
          unit: "USD",
          enabled: true,
          siteType: "new-api",
          checkin: { enabled: false },
        },
      ],
    },
    ingest,
  );
  assert.equal(inventory.statusCode, 200, inventory.body);
  const deliver = async (eventId, occurredAt, key) => {
    const r = await f.call(
      "POST",
      "/api/v2/ingest/credentials",
      {
        eventId,
        occurredAt,
        accountId: "hub-account",
        complete: true,
        credentials: [
          {
            id: "key",
            name: "Key",
            baseUrl: "https://hub.test/v1",
            protocol: "OpenAI",
            key,
            enabled: true,
            models: ["model-A"],
            secretState: "present",
          },
        ],
      },
      ingest,
    );
    assert.equal(r.statusCode, 200, r.body);
    const id = f.store.ref("all-api-hub", "account", "hub-account");
    return f.store.require("account", id).hubKeys[0].credentialId;
  };
  const credentials = () =>
    f.store.db.prepare("SELECT count(*) n FROM credentials").get().n;
  const first = await deliver("first", "2026-11-06T02:00:00.000Z", "sk-hub-one");
  const stored = credentials();
  assert.equal(
    await deliver("again", "2026-11-06T03:00:00.000Z", "sk-hub-one"),
    first,
  );
  assert.equal(credentials(), stored);
  const rotated = await deliver("rotated", "2026-11-06T04:00:00.000Z", "sk-hub-two");
  assert.notEqual(rotated, first);
  assert.equal(f.store.reveal(rotated), "sk-hub-two");
});

test("batch pause and remove go through the channel lifecycle", async (t) => {
  const f = await fixture(t);
  const second = f.resources.channel({
    siteId: f.site.id,
    accountId: f.account.id,
    name: "Second",
    baseUrl: "https://upstream.test/v1",
    models: ["model-B"],
    enabled: true,
    recoveryPolicy: { enabled: true },
  });
  const apply = async (action, ids) => {
    const preview = await f.call("POST", "/api/v2/changes/preview", { action, ids });
    assert.equal(preview.statusCode, 200, preview.body);
    const r = await f.call(
      "POST",
      `/api/v2/changes/${preview.json().previewId}/apply`,
      { requestId: action },
    );
    assert.equal(r.statusCode, 200, r.body);
  };
  await apply("pause", [second.id]);
  const paused = f.store.require("channel", second.id);
  assert.equal(paused.management.state, "paused");
  assert.equal(paused.curation.authority, "center");
  await apply("remove", [f.channel.id, second.id]);
  for (const id of [f.channel.id, second.id]) {
    const c = f.store.require("channel", id);
    assert.equal(c.management.state, "removed");
    assert.equal(c.recoveryPolicy.enabled, false);
    assert.equal(c.enabled, false);
    assert.ok(c.curation.updatedAt);
  }
  const logged = f.store.db
    .prepare("SELECT target FROM actions")
    .all()
    .map((r) => r.target);
  assert.ok([f.channel.id, second.id].every((id) => logged.includes(id)));
});

test("channel views and model rows share the server availability rule", async (t) => {
  const f = await fixture(t);
  f.store.put("channel", {
    ...f.store.require("channel", f.channel.id),
    models: ["model-A", "model-B"],
    sourceObservation: { present: true, enabled: true, models: ["model-A"] },
    hubObservation: { present: false, models: ["model-H"] },
  });
  f.store.put("offering", {
    id: `${f.channel.id}:model-C`,
    channelId: f.channel.id,
    modelId: "model-C",
  });
  const channel = (name, models) =>
    f.resources.channel({
      siteId: f.site.id,
      accountId: f.account.id,
      name,
      baseUrl: "https://upstream.test/v1",
      models,
      enabled: true,
    });
  const paused = channel("Paused", ["model-P"]);
  f.store.put("channel", { ...paused, credentialId: f.store.secret("sk-paused") });
  const pause = await f.call("POST", `/api/v2/channels/${paused.id}/lifecycle`, {
    version: paused.version,
    action: "pause",
  });
  assert.equal(pause.statusCode, 200, pause.body);
  const keyless = channel("Keyless", ["model-K"]);
  const site = (await f.call("GET", `/api/v2/sites/${f.site.id}`)).json();
  const view = (id) => site.channels.find((c) => c.id === id);
  assert.deepEqual(view(f.channel.id).activeModels, ["model-A"]);
  assert.deepEqual(view(f.channel.id).knownModels, ["model-A", "model-B", "model-C"]);
  assert.deepEqual(view(paused.id).activeModels, []);
  assert.deepEqual(view(paused.id).knownModels, ["model-P"]);
  assert.deepEqual(view(keyless.id).activeModels, []);
  assert.deepEqual(view(keyless.id).knownModels, ["model-K"]);
  const listed = (await f.call("GET", "/api/v2/sites")).json().items[0];
  assert.deepEqual(
    listed.channels.find((c) => c.id === f.channel.id).activeModels,
    ["model-A"],
  );
  const rows = (await f.call("GET", "/api/v2/models?limit=200")).json().items;
  assert.deepEqual(
    Object.fromEntries(rows.map((r) => [`${r.channelId}:${r.modelId}`, r.active])),
    {
      [`${f.channel.id}:model-A`]: true,
      [`${f.channel.id}:model-B`]: false,
      [`${f.channel.id}:model-C`]: false,
      [`${paused.id}:model-P`]: false,
      [`${keyless.id}:model-K`]: false,
    },
  );
});

test("cached channel views match a full re-read after writes, ties and rollbacks", async (t) => {
  const { store, resources, site, account, channel, app } = await fixture(t);
  const rp = resources.channel({
    siteId: site.id,
    accountId: account.id,
    name: "RP",
    baseUrl: "https://upstream.test/v1",
    models: ["model-B"],
    usage: "rp",
  });
  const { distribution } = app.services;
  // The pre-cache rules, recomputed from every stored row.
  const reread = (c) => {
    const [scan] = store
      .list("modelScan")
      .filter((s) => s.channelCatalogs?.some((r) => r.channelId === c.id))
      .sort((a, b) => b.scannedAt.localeCompare(a.scannedAt));
    const catalog = scan?.channelCatalogs.find((r) => r.channelId === c.id);
    const revisions = new Map(
      distribution
        .managedEntries("sillytavern")
        .map((e) => [e.subject, digest(e.payload)]),
    );
    const current = new Map(
      store
        .list("delivery")
        .filter(
          (j) =>
            j.target === "sillytavern" &&
            j.state !== "superseded" &&
            revisions.get(j.subject) === j.revision,
        )
        .map((j) => [j.subject, j.id]),
    );
    return {
      calls: {
        ...store.db
          .prepare(
            "SELECT count(*) total, sum(result='success') success, sum(result='failure') failure, max(occurred_at) lastAt FROM calls WHERE channel_id=?",
          )
          .get(c.id),
      },
      scan: scan
        ? {
            scannedAt: scan.scannedAt,
            catalogStatus: catalog.status,
            catalogModels: catalog.models || [],
            websiteStatus: scan.website?.status || null,
            metricCount: scan.metrics?.length || 0,
          }
        : null,
      evaluations: store
        .list("evaluation")
        .filter((e) => e.channelId === c.id)
        .map((e) => e.id),
      jobs: current.has(c.id) ? [current.get(c.id)] : [],
    };
  };
  const check = () => {
    for (const c of [channel, rp]) {
      const view = resources.publicChannel(store.require("channel", c.id));
      assert.deepEqual(
        {
          calls: view.calls,
          scan: view.scan,
          evaluations: view.historicalEvaluations.map((e) => e.id),
          jobs: view.synchronization.map((j) => j.id),
        },
        reread(c),
      );
    }
  };
  const scan = (id, scannedAt, channels) =>
    store.put("modelScan", {
      id,
      scannedAt,
      website: { status: "reachable" },
      metrics: [{ name: "model-A" }],
      channelCatalogs: channels.map((c) => ({
        channelId: c.id,
        status: "ok",
        models: [id],
      })),
    });
  check();
  recordCall(store, "rp", "a", channel.id, "model-A", "2026-11-01T00:00:00.000Z", "pending");
  check();
  recordCall(store, "rp", "a", channel.id, "model-A", "2026-11-01T00:00:00.000Z", "success");
  recordCall(store, "rp", "b", channel.id, "model-A", "2026-11-02T00:00:00.000Z", "failure");
  check();
  recordCall(store, "rp", "b", rp.id, "model-B", "2026-10-30T00:00:00.000Z", "success");
  check();
  scan("https://a.test", "2026-11-01T00:00:00.000Z", [channel, rp]);
  scan("https://b.test", "2026-11-01T00:00:00.000Z", [rp]);
  check();
  scan("https://a.test", "2026-11-02T00:00:00.000Z", [rp]);
  check();
  store.put("evaluation", { channelId: channel.id, model: "model-A", piAudit: { svg: "<svg/>" } });
  check();
  const revision = digest(
    distribution.managedEntries("sillytavern").find((e) => e.subject === rp.id).payload,
  );
  for (const [state, value] of [
    ["applied", revision],
    ["applied", "older"],
    ["applied", revision],
    ["superseded", revision],
  ])
    store.put("delivery", { target: "sillytavern", subject: rp.id, revision: value, state });
  check();
  assert.throws(
    () =>
      store.transaction(() => {
        recordCall(store, "rp", "c", channel.id, "model-A", "2026-11-03T00:00:00.000Z", "success");
        scan("https://c.test", "2026-11-03T00:00:00.000Z", [channel]);
        scan("https://a.test", "2026-11-04T00:00:00.000Z", [channel]);
        store.put("evaluation", { channelId: rp.id, model: "model-B" });
        store.put("delivery", { target: "sillytavern", subject: rp.id, revision, state: "applied" });
        check();
        throw new Error("rolled back");
      }),
    /rolled back/,
  );
  check();
  const event = store.db.prepare("INSERT INTO events VALUES(?,?,?,?,?)");
  for (const [id, date, kind] of [
    ["first-account", "2025-01-01", "account"],
    ["first-checkin", "2025-02-01", "checkin"],
    ["last-checkin", "2026-11-05", "checkin"],
    ["last-account", "2026-11-06", "account"],
  ])
    event.run(id, account.id, `${date}T01:00:00.000Z`, date, JSON.stringify({ kind, result: "成功" }));
  const bounds = store.db
    .prepare(
      "SELECT min(business_date) first,max(business_date) last FROM events WHERE json_extract(data,'$.kind')='checkin'",
    )
    .get();
  const { coverage } = listCheckins(store, {}, new Date("2026-11-06T04:00:00Z"));
  assert.deepEqual(
    [coverage.firstRecordedDate, coverage.lastRecordedDate],
    [bounds.first, bounds.last],
  );
});
