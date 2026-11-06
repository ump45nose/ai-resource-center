import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app.mjs";
import { issueToken } from "../server/auth.mjs";
import { hash, Store } from "../server/store.mjs";
import { canonical, digest, same } from "../server/canonical.mjs";
import {
  newApiType,
  channelType,
  headerOverride,
} from "../server/newapi-channel.mjs";
import { fixture } from "./helpers.mjs";

// Verbatim copies of the implementations replaced by server/canonical.mjs.
const legacyCanonical = {
  operations: (value) =>
    JSON.stringify(value, function (_key, item) {
      return item && typeof item === "object" && !Array.isArray(item)
        ? Object.fromEntries(
            Object.entries(item).sort(([a], [b]) => a.localeCompare(b)),
          )
        : item;
    }),
  distribution: (x) =>
    JSON.stringify(x, (_k, v) =>
      v && typeof v === "object" && !Array.isArray(v)
        ? Object.fromEntries(
            Object.entries(v).sort(([a], [b]) => a.localeCompare(b)),
          )
        : v,
    ),
};
const legacyType = (protocol, remote) =>
  remote &&
  (remote.type === 14
    ? "Anthropic"
    : remote.type === 24
      ? "Gemini"
      : "OpenAI") === (protocol === "OpenAI Responses" ? "OpenAI" : protocol)
    ? remote.type
    : protocol === "Anthropic"
      ? 14
      : protocol === "Gemini"
        ? 24
        : 1;

function newApiSource(f) {
  const source = f.sources.save({
    name: "Gateway",
    kind: "newapi",
    url: "https://gateway.test",
  });
  f.sources.update(source.id, {
    credentialId: f.store.secret("gateway-admin"),
  });
  return source;
}

async function adopt(f, target) {
  const d = f.app.services.distribution;
  const { previewId } = await d.preview(target);
  d.confirm(target, previewId);
}

async function newApiDistribution(f, channel = {}) {
  const source = newApiSource(f);
  f.store.put("channel", {
    ...f.store.require("channel", f.channel.id),
    ...channel,
  });
  await adopt(f, "newapi");
  await f.app.services.distribution.tick();
  const job = f.store.list("delivery").find((j) => j.target === "newapi");
  assert.equal(job.state, "applied", job.reason);
  const link = f.store.require("targetLink", `newapi:${f.channel.id}`);
  return { source, job, remote: f.net.remote.get(link.remoteId) };
}

async function claim(f, token) {
  const r = await f.call("GET", "/api/v2/connector/jobs", undefined, token);
  assert.equal(r.statusCode, 200, r.body);
  return r.json().items;
}

async function receipt(f, token, body) {
  const r = await f.call("POST", "/api/v2/connector/receipts", body, token);
  assert.equal(r.statusCode, 200, r.body);
  return r.json();
}

const bookmarkToken = (f) =>
  issueToken(f.store, "connector", {
    target: "chrome-bookmarks",
    sourceId: "all-api-hub",
  });

const pause = () => new Promise((resolve) => setTimeout(resolve, 5));

// The fixture account linked to native All API Hub account hub-1. The center
// keeps its own site name and check-in entry, which must never be pushed.
async function hubSetup(f) {
  const site = f.store.require("site", f.site.id);
  f.store.put("site", {
    ...site,
    checkinUrl: "https://center.test/checkin",
    version: site.version + 1,
  });
  f.store.ref("all-api-hub", "account", "hub-1", f.account.id);
  const ingest = issueToken(f.store, "ingest", { sourceId: "all-api-hub" });
  const state = {
    siteName: "Hub Fixture",
    customUrl: "https://upstream.test/custom-checkin",
    enabled: true,
    checkin: true,
  };
  let n = 0;
  const inventory = async (changes = {}) => {
    Object.assign(state, changes);
    await pause();
    const at = new Date().toISOString();
    const checkin = { enabled: state.checkin };
    if (state.customUrl !== undefined) checkin.customUrl = state.customUrl;
    const r = await f.call(
      "POST",
      "/api/v2/ingest/inventory",
      {
        eventId: `inventory-${++n}`,
        occurredAt: at,
        deviceId: "device",
        accounts: [
          {
            id: "hub-1",
            name: "Login",
            site: { name: state.siteName, url: "https://upstream.test" },
            observedAt: at,
            balance: null,
            unit: "credits",
            enabled: state.enabled,
            siteType: "new-api",
            checkin,
          },
        ],
      },
      ingest,
    );
    assert.equal(r.statusCode, 200, r.body);
  };
  await inventory();
  const token = issueToken(f.store, "connector", {
    target: "all-api-hub",
    sourceId: "all-api-hub",
  });
  const d = f.app.services.distribution;
  const jobs = () =>
    f.store.list("delivery").filter((j) => j.target === "all-api-hub");
  const account = (changes) => {
    const a = f.store.require("account", f.account.id);
    f.store.put("account", { ...a, ...changes });
    d.reconcile("all-api-hub");
  };
  const apply = async (job, snapshot, state = "applied") => {
    await pause();
    return receipt(f, token, {
      id: job.id,
      lease: job.lease,
      state,
      remoteId: "hub-1",
      snapshot,
    });
  };
  const link = () => f.store.get("targetLink", `all-api-hub:${f.account.id}`);
  return { d, token, inventory, jobs, account, apply, link, state };
}

test("shared canonical JSON reproduces every replaced implementation", async (t) => {
  const samples = [
    undefined,
    null,
    0,
    -0,
    12.5,
    NaN,
    Infinity,
    "",
    "text",
    true,
    [],
    {},
    [undefined, null, () => 1, Symbol("s"), NaN, -0],
    {
      b: 1,
      a: { d: [3, { z: undefined, y: null, x: [{ q: 1, p: 2 }] }], c: "é" },
    },
    { 10: 1, 9: 2, b: 3, B: 4, a_b: 5, "a-b": 6, é: 7, e: 8, Z: 9, "": 10 },
    { at: new Date(0), custom: { toJSON: () => ({ y: 1, x: 2 }) }, fn() {} },
    JSON.parse('{"__proto__":{"b":1,"a":2},"constructor":{"d":1,"c":2}}'),
    Object.assign(Object.create(null), { b: 1, a: 2 }),
    new Map([["a", 1]]),
    { sourceId: "source", scope: "all", previewId: undefined },
    {
      destination: {
        id: "source",
        url: "https://gateway.test",
        userId: undefined,
        version: 2,
        credentialId: "credential",
      },
      config: 3,
      entries: [
        {
          subject: "channel",
          payload: {
            models: ["b", "a"],
            routing: { priority: null, weight: null, reasons: [] },
            headerValues: [{ name: "x-b", value: "1" }],
          },
        },
      ],
    },
    ["binding", "https://rp.test", "OpenAI", null],
    { userId: "user", sourceId: "source", instanceId: "instance" },
  ];
  for (const sample of samples) {
    for (const [name, old] of Object.entries(legacyCanonical))
      assert.equal(canonical(sample), old(sample), name);
    if (canonical(sample) !== undefined)
      assert.equal(digest(sample), hash(legacyCanonical.distribution(sample)));
  }
  assert.equal(
    canonical({ b: [{ d: 1, c: undefined }], a: null }),
    '{"a":null,"b":[{"d":1}]}',
  );
  assert.equal(same({ a: 1, b: [2] }, { b: [2], a: 1 }), true);
  assert.equal(same({ a: null }, {}), false);
  const f = await fixture(t);
  await adopt(f, "chrome-bookmarks");
  const [job] = f.store.list("delivery");
  assert.equal(job.revision, hash(legacyCanonical.distribution(job.payload)));
  const input = { scope: { z: 1, a: [{ d: 1, c: 2 }] }, ids: ["b", "a"] };
  f.app.services.operations.start("scan", { requestId: "canonical", ...input });
  assert.equal(
    f.store.db
      .prepare("SELECT input FROM requests WHERE request_id='canonical'")
      .get().input,
    legacyCanonical.operations(input),
  );
});

test("New API channel helpers keep the existing type and header rules", () => {
  for (const protocol of [
    "OpenAI",
    "OpenAI Responses",
    "Anthropic",
    "Gemini",
    "New API 类型 33",
    undefined,
  ])
    for (const remote of [
      null,
      undefined,
      {},
      { type: 1 },
      { type: 14 },
      { type: 24 },
      { type: 25 },
      { type: 43 },
      { type: "24" },
    ])
      assert.equal(
        channelType(protocol, remote),
        legacyType(protocol, remote),
        `${protocol} ${JSON.stringify(remote)}`,
      );
  assert.deepEqual(
    ["OpenAI", "OpenAI Responses", "Anthropic", "Gemini"].map(newApiType),
    [1, 1, 14, 24],
  );
  assert.equal(
    headerOverride([
      { name: "x-a", value: "1" },
      { name: "x-b", value: "2" },
    ]),
    '{"x-a":"1","x-b":"2"}',
  );
  assert.equal(headerOverride([]), "{}");
});

test("New API distribution creates a channel with the protocol's type", async (t) => {
  const f = await fixture(t);
  const { remote } = await newApiDistribution(f, {
    protocol: "Gemini",
    nativePassthrough: true,
  });
  assert.equal(remote.type, 24);
  assert.equal(remote.tag, `arc-managed-${f.channel.id}`);
  assert.equal(remote.setting, '{"pass_through_body_enabled":true}');
});

test("adopting an external New API edit updates the channel and link together", async (t) => {
  const f = await fixture(t);
  const d = f.app.services.distribution;
  const { source, job, remote } = await newApiDistribution(f);
  remote.name = "Edited in New API";
  await f.sources.inventory(f.sources.get(source.id));
  assert.equal(f.store.require("delivery", job.id).state, "conflict");
  assert.deepEqual(await d.resolve(job.id, "target"), { resolved: true });
  assert.equal(
    f.store.require("channel", f.channel.id).name,
    "Edited in New API",
  );
  const link = f.store.require("targetLink", `newapi:${f.channel.id}`);
  assert.equal(link.state, "applied");
  assert.equal(link.snapshot.name, "Edited in New API");
  assert.equal(f.store.require("delivery", job.id).state, "superseded");
});

test("gateway stages evaluation channels with the protocol's New API type", async (t) => {
  const f = await fixture(t);
  newApiSource(f);
  const gateway = f.app.services.gateway;
  const stage = async (protocol, extra = {}) => {
    const c = f.resources.channel({
      siteId: f.site.id,
      accountId: f.account.id,
      name: protocol,
      baseUrl: "https://upstream.test/v1",
      protocol,
      models: ["model-A"],
      enabled: true,
      ...extra,
    });
    f.store.put("channel", {
      ...c,
      credentialId: f.store.secret(`sk-${protocol}`),
    });
    const o = await gateway.stage({
      id: `${c.id}:model-A`,
      channelId: c.id,
      modelId: "model-A",
    });
    return { c, o, remote: f.net.remote.get(o.gateway.channelId) };
  };
  const openai = await stage("OpenAI");
  const anthropic = await stage("Anthropic");
  const gemini = await stage("Gemini", {
    nativePassthrough: true,
    headers: [{ name: "x-trace", value: "on" }],
  });
  assert.deepEqual(
    [openai, anthropic, gemini].map((x) => x.remote.type),
    [1, 14, 24],
  );
  assert.equal(gemini.remote.header_override, '{"x-trace":"on"}');
  assert.equal(gemini.remote.setting, '{"pass_through_body_enabled":true}');
  assert.equal(openai.remote.header_override, "{}");
  assert.equal(openai.remote.setting, undefined);
  const c = f.store.require("channel", openai.c.id);
  f.resources.update("channel", c.id, c.version, { protocol: "Gemini" });
  await gateway.stage(f.store.require("offering", openai.o.id));
  assert.equal(f.net.remote.get(openai.o.gateway.channelId).type, 24);
  assert.equal(f.store.require("offering", openai.o.id).applied.type, 24);
});

test("connector receipts never persist plaintext keys or header values", async (t) => {
  const f = await fixture(t);
  await adopt(f, "chrome-bookmarks");
  const token = bookmarkToken(f);
  const [job] = await claim(f, token);
  assert.ok(!JSON.stringify(job).includes("sk-fixture-private"));
  const managed = { rootId: "root-1", count: 1, folders: [] };
  await receipt(f, token, {
    id: job.id,
    lease: job.lease,
    state: "applied",
    remoteId: "root-1",
    snapshot: {
      ...managed,
      credential: "sk-fixture-private",
      key: "sk-echoed-key",
      apiKey: "sk-api-key",
      headers: [{ name: "x-relay-auth", value: "header-secret" }],
      Authorization: "Bearer sk-bearer",
      nativeCredentialReference: { secretId: "native-secret-id" },
      nested: { token: "nested-token", password: "nested-password", keep: 1 },
    },
  });
  const rows = f.store.db
    .prepare("SELECT data FROM entities")
    .all()
    .map((r) => r.data)
    .join("\n");
  for (const secret of [
    "sk-fixture-private",
    "sk-echoed-key",
    "sk-api-key",
    "header-secret",
    "sk-bearer",
    "native-secret-id",
    "nested-token",
    "nested-password",
  ])
    assert.ok(!rows.includes(secret), `${secret} persisted`);
  const link = f.store.require("targetLink", "chrome-bookmarks:bookmarks");
  assert.equal(link.state, "applied");
  assert.equal(link.remoteId, "root-1");
  assert.deepEqual(link.snapshot, { ...managed, nested: { keep: 1 } });
  assert.deepEqual(
    f.store.require("delivery", job.id).receipt.snapshot,
    link.snapshot,
  );
});

test("All API Hub receives only the stop and resume of automatic check-in", async (t) => {
  const f = await fixture(t);
  newApiSource(f);
  const hub = await hubSetup(f);
  const { d } = hub;
  const revisions = (target) =>
    Object.fromEntries(
      d.entries(target).map((e) => [e.subject, digest(e.payload)]),
    );
  const newApi = revisions("newapi");
  await adopt(f, "all-api-hub");
  assert.deepEqual(hub.jobs(), []);
  assert.deepEqual(await claim(f, hub.token), []);

  const site = f.store.require("site", f.site.id);
  f.resources.update("site", site.id, site.version, {
    name: "Center name",
    checkinUrl: "https://center.test/other",
  });
  const notion = revisions("notion");
  await hub.inventory({
    siteName: "Renamed in hub",
    customUrl: "https://upstream.test/new",
    enabled: false,
  });
  await hub.inventory({ siteName: "Renamed again" });
  d.reconcile("all-api-hub");
  assert.deepEqual(hub.jobs(), [], "names, entries and enabled state stay");
  assert.deepEqual(await claim(f, hub.token), []);

  hub.account({
    checkinArchive: { active: true, reason: "invalid", at: new Date().toISOString() },
  });
  let [job] = await claim(f, hub.token);
  const echoed = {
    name: "Renamed again",
    checkinUrl: "https://upstream.test/new",
    disabled: true,
  };
  assert.deepEqual(job.payload, {
    centerAccountId: f.account.id,
    externalId: "hub-1",
    siteId: f.site.id,
    automaticExecutionEnabled: false,
    reason: "archived",
    ...echoed,
  });
  assert.deepEqual(job.expected, {
    name: echoed.name,
    checkinUrl: echoed.checkinUrl,
    automaticExecutionEnabled: true,
    disabled: true,
  });
  assert.equal(job.force, false);
  assert.ok(!JSON.stringify(job).includes("center.test"));
  await hub.apply(job, { ...job.expected, automaticExecutionEnabled: false });
  assert.equal(f.store.require("delivery", job.id).state, "applied");
  assert.equal(hub.link().checkinHold.reason, "archived");

  const count = hub.jobs().length;
  for (const siteName of ["Renamed again", "Third name", "Third name"])
    await hub.inventory({ siteName, checkin: false });
  d.reconcile("all-api-hub");
  await claim(f, hub.token);
  assert.equal(hub.jobs().length, count, "no job from repeated inventories");
  assert.equal(f.store.require("delivery", job.id).state, "applied");
  assert.notEqual(hub.link().state, "conflict");
  assert.ok(!hub.jobs().some((j) => j.state === "conflict"));

  hub.account({
    checkinArchive: {
      active: false,
      reason: "invalid",
      recoveredAt: new Date().toISOString(),
    },
  });
  [job] = await claim(f, hub.token);
  assert.equal(job.payload.automaticExecutionEnabled, true);
  assert.equal(job.payload.reason, "restored");
  assert.equal(job.payload.name, "Third name");
  await hub.apply(job, { ...job.expected, automaticExecutionEnabled: true });
  assert.equal(hub.link().checkinHold, null);
  const settled = hub.jobs().length;
  await hub.inventory({ checkin: true });
  await hub.inventory({ checkin: false });
  d.reconcile("all-api-hub");
  assert.deepEqual(await claim(f, hub.token), []);
  assert.equal(hub.jobs().length, settled, "the extension's later choice stands");

  assert.deepEqual(revisions("newapi"), newApi);
  assert.deepEqual(revisions("notion"), notion);
  const view = (await f.call("GET", `/api/v2/sites/${f.site.id}`)).json()
    .accounts[0].integration;
  assert.deepEqual(view.extension, {
    name: "Third name",
    checkinUrl: "https://upstream.test/new",
    automaticExecutionEnabled: false,
    disabled: true,
  });
  assert.deepEqual(view.automaticCheckin, {
    automaticExecutionEnabled: null,
    reason: null,
  });
});

test("extension-side drift is resent with its current values, never raised as a conflict", async (t) => {
  const f = await fixture(t);
  const hub = await hubSetup(f);
  const { d } = hub;
  await adopt(f, "all-api-hub");
  const executor = f.store.require("account", f.account.id).sourceObservation;
  f.store.put("account", {
    id: "executor",
    siteId: f.site.id,
    name: "Executor",
    role: "checkin",
    sourceObservation: { ...executor, externalId: "hub-executor" },
  });
  hub.account({ checkinAccountId: "executor" });
  let [job] = await claim(f, hub.token);
  assert.equal(job.payload.reason, "delegated");
  // The extension's own baseline predates a rename made in the extension.
  const renamed = { ...job.expected, name: "Renamed in hub" };
  assert.equal((await hub.apply(job, renamed, "conflict")).state, "pending");
  const resent = f.store.require("delivery", job.id);
  assert.equal(resent.state, "pending");
  assert.equal(resent.force, true);
  assert.notEqual(hub.link().state, "conflict");
  assert.ok(!d.jobs({ target: "all-api-hub" }).some((j) => j.state === "conflict"));
  [job] = await claim(f, hub.token);
  assert.equal(job.force, true);
  assert.equal(job.payload.name, "Renamed in hub");
  assert.equal(job.payload.automaticExecutionEnabled, false);
  await hub.apply(job, { ...renamed, automaticExecutionEnabled: false });
  assert.equal(hub.link().checkinHold.reason, "delegated");

  hub.account({ checkinAccountId: null });
  [job] = await claim(f, hub.token);
  assert.equal(job.payload.reason, "restored");
  // Already switched back on in the extension: the resume is not needed.
  await hub.apply(job, { ...job.expected, automaticExecutionEnabled: true }, "conflict");
  assert.equal(f.store.require("delivery", job.id).state, "superseded");
  hub.account({});
  assert.equal(hub.link().checkinHold, null);
  assert.deepEqual(await claim(f, hub.token), []);

  // An older extension version reports no custom entry: wait until it is exact.
  await hub.inventory({ customUrl: undefined, checkin: true });
  hub.account({
    checkinArchive: { active: true, reason: "invalid", at: new Date().toISOString() },
  });
  assert.deepEqual(await claim(f, hub.token), []);
  const [waiting] = d.jobs({ target: "all-api-hub", subject: f.account.id });
  assert.equal(waiting.state, "waiting");
  assert.equal(waiting.retryable, false);
  assert.match(waiting.reason, /签到入口/);
  assert.equal(
    d.list().find((x) => x.id === "all-api-hub").counts.waiting,
    1,
  );
  await hub.inventory({ customUrl: null });
  [job] = await claim(f, hub.token);
  assert.equal(job.payload.automaticExecutionEnabled, false);
  assert.equal(job.payload.checkinUrl, null);

  // Removed from the extension: an older receipt is not taken as current.
  const removed = f.store.require("account", f.account.id);
  f.store.put("account", {
    ...removed,
    sourceObservation: { ...removed.sourceObservation, present: false },
  });
  assert.equal(
    d.hubCurrent(f.store.require("account", f.account.id), hub.link()),
    null,
  );
});

test("old All API Hub conflicts are cleared at startup in favor of the extension", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "arc-hub-"));
  let app;
  t.after(async () => {
    await app?.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const store = new Store(dir);
  const at = new Date().toISOString();
  const site = store.put("site", {
    name: "Center",
    url: "https://upstream.test",
    sources: ["all-api-hub"],
  });
  const account = store.put("account", {
    siteId: site.id,
    name: "Login",
    sourceObservation: {
      source: "all-api-hub",
      externalId: "hub-1",
      siteName: "Hub name",
      enabled: true,
      checkin: { enabled: true, customUrl: null },
      present: true,
      observedAt: at,
    },
  });
  store.setting("target:all-api-hub", {
    enabled: true,
    adoptedAt: at,
    version: 2,
    managedSubjects: [account.id],
    baselineSubjects: [account.id],
  });
  const snapshot = {
    name: "Center",
    checkinUrl: null,
    automaticExecutionEnabled: true,
    disabled: false,
  };
  const conflict = store.put("delivery", {
    target: "all-api-hub",
    subject: account.id,
    revision: "old",
    payload: { centerAccountId: account.id, externalId: "hub-1", siteId: site.id, url: site.url, ...snapshot },
    state: "conflict",
    createdAt: at,
    attempts: 0,
  });
  store.put("targetLink", {
    id: `all-api-hub:${account.id}`,
    target: "all-api-hub",
    subject: account.id,
    state: "conflict",
    remoteId: "hub-1",
    snapshot,
    appliedAt: at,
    conflictSnapshot: { ...snapshot, name: "Hub name" },
  });
  store.close();
  app = await createApp({ dir });
  const s = app.services.store;
  const link = s.require("targetLink", `all-api-hub:${account.id}`);
  assert.equal(link.state, "applied");
  assert.equal(link.conflictSnapshot, null);
  const cleared = s.require("delivery", conflict.id);
  assert.equal(cleared.state, "superseded");
  assert.match(cleared.reason, /以插件为准/);
  assert.equal(s.require("site", site.id).name, "Center");
  const d = app.services.distribution;
  d.reconcile("all-api-hub");
  assert.deepEqual(
    s.list("delivery").filter((j) => j.state !== "superseded"),
    [],
  );
  assert.ok(!d.jobs({ target: "all-api-hub" }).some((j) => j.state === "conflict"));
  assert.equal(
    s.setting("migration:hub-checkin-writeback-v1").conflicts[0].id,
    link.id,
  );
});
