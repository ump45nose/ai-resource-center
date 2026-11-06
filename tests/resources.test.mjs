import test from "node:test";
import assert from "node:assert/strict";
import { issueToken } from "../server/auth.mjs";
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

test("inputs cannot create, move or revive channels in the RP usage", async (t) => {
  const f = await fixture(t);
  const data = {
    siteId: f.site.id,
    accountId: f.account.id,
    name: "RP",
    baseUrl: "https://upstream.test/v1",
  };
  for (const extra of [{ usage: "rp" }, { purpose: "rp" }]) {
    const r = await f.call("POST", "/api/v2/channels", {
      data: { ...data, ...extra },
    });
    assert.equal(r.statusCode, 400, r.body);
  }
  assert.throws(() => f.resources.channel({ ...data, purpose: "rp" }), {
    code: "rp_out_of_center",
  });
  const { version } = f.store.require("channel", f.channel.id);
  for (const changes of [{ usage: "rp" }, { purpose: "rp" }]) {
    const r = await f.call("PATCH", `/api/v2/channels/${f.channel.id}`, {
      version,
      changes,
    });
    assert.equal(r.statusCode, 400, r.body);
  }
  const legacy = f.store.put("channel", {
    ...f.store.require("channel", f.channel.id),
    usage: "rp",
    category: "rp",
    enabled: false,
    availability: "已移除",
    management: { state: "removed" },
  });
  const revive = await f.call(
    "POST",
    `/api/v2/channels/${legacy.id}/lifecycle`,
    { version: legacy.version, action: "archive", reason: "call" },
  );
  assert.equal(revive.statusCode, 409, revive.body);
  assert.equal(revive.json().code, "rp_out_of_center");
  assert.deepEqual(f.store.require("channel", legacy.id), legacy);
  const note = await f.call("PATCH", `/api/v2/channels/${legacy.id}`, {
    version: legacy.version,
    changes: { note: "kept in SillyTavern" },
  });
  assert.equal(note.statusCode, 200, note.body);
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
