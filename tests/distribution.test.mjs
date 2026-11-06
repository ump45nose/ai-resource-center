import test from "node:test";
import assert from "node:assert/strict";
import { issueToken } from "../server/auth.mjs";
import { Problem } from "../server/errors.mjs";
import { hash } from "../server/store.mjs";
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
  rpSync: (x) =>
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

function rpChannel(f) {
  return f.store.put("channel", {
    ...f.store.require("channel", f.channel.id),
    usage: "rp",
    category: "rp",
  });
}

const tavernToken = (f, c) =>
  issueToken(f.store, "connector", {
    target: "sillytavern",
    sourceId: "sillytavern",
    channelIds: [c.id],
  });

function hubAccount(f) {
  return f.store.put("account", {
    ...f.store.require("account", f.account.id),
    enabled: true,
    checkinEnabled: true,
    sourceObservation: {
      source: "all-api-hub",
      externalId: "hub-1",
      name: "Login",
      siteName: "Fixture",
      siteUrl: "https://upstream.test",
      enabled: true,
      checkin: { enabled: true },
      present: true,
      observedAt: new Date(Date.now() - 60000).toISOString(),
    },
  });
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
  rpChannel(f);
  await adopt(f, "sillytavern");
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
  const c = rpChannel(f);
  await adopt(f, "sillytavern");
  const token = tavernToken(f, c);
  const [job] = await claim(f, token);
  assert.equal(job.payload.credential, "sk-fixture-private");
  const managed = {
    name: c.name,
    baseUrl: c.baseUrl,
    protocol: c.protocol,
    models: c.models,
    enabled: true,
    order: 0,
    credentialFingerprint: job.payload.credentialFingerprint,
  };
  await receipt(f, token, {
    id: job.id,
    lease: job.lease,
    state: "applied",
    remoteId: "profile-1",
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
  const link = f.store.require("targetLink", `sillytavern:${c.id}`);
  assert.equal(link.state, "applied");
  assert.equal(link.remoteId, "profile-1");
  assert.deepEqual(link.snapshot, { ...managed, nested: { keep: 1 } });
  assert.deepEqual(
    f.store.require("delivery", job.id).receipt.snapshot,
    link.snapshot,
  );
});

test("RP connector receipts drop secrets before comparing and saving", async (t) => {
  const f = await fixture(t);
  const scope = {
    sourceId: "sillytavern",
    rpInstanceId: "instance",
    rpUserId: "user",
  };
  const rp = issueToken(f.store, "rp", { ...scope, rpRegistration: true });
  const local = {
    name: "RP",
    baseUrl: "https://rp.test",
    protocol: "OpenAI",
    selectedModel: "",
    order: 0,
    enabled: true,
    note: "",
    credentialFingerprint: null,
  };
  const inventory = await f.call(
    "POST",
    "/api/v2/rp/inventory",
    {
      eventId: "inventory-1",
      profiles: [{ nativeConnectionId: "native-1", snapshot: local }],
    },
    rp,
  );
  assert.equal(inventory.statusCode, 200, inventory.body);
  const token = issueToken(f.store, "connector", {
    ...scope,
    target: "sillytavern",
  });
  const secrets = {
    credential: "sk-rp-secret",
    headers: { "x-relay-auth": "rp-header-secret" },
  };
  let [job] = await claim(f, token);
  assert.deepEqual(
    await receipt(f, token, {
      id: job.id,
      lease: job.lease,
      state: "applied",
      snapshot: { ...local, ...secrets },
    }),
    { acknowledged: true, id: job.id, state: "applied" },
  );
  const b = f.store.list("rpConnection")[0];
  f.store.put("rpConnection", { ...b, name: "Center name" });
  [job] = await claim(f, token);
  await receipt(f, token, {
    id: job.id,
    lease: job.lease,
    state: "conflict",
    snapshot: { ...local, name: "Local name", ...secrets },
  });
  const conflict = f.store.require("rpConnection", b.id).conflict;
  assert.deepEqual(conflict.local, { ...local, name: "Local name" });
  const rows = f.store.db
    .prepare("SELECT data FROM entities")
    .all()
    .map((r) => r.data)
    .join("\n");
  assert.ok(!rows.includes("sk-rp-secret"));
  assert.ok(!rows.includes("rp-header-secret"));
});

test("adopting a connector's configuration is all-or-nothing", async (t) => {
  const f = await fixture(t);
  const c = rpChannel(f);
  const d = f.app.services.distribution;
  await adopt(f, "sillytavern");
  const token = tavernToken(f, c);
  const [job] = await claim(f, token);
  await receipt(f, token, {
    id: job.id,
    lease: job.lease,
    state: "conflict",
    snapshot: {
      name: "Local",
      baseUrl: "not a url",
      protocol: "OpenAI",
      models: ["model-B"],
      order: 1,
      enabled: true,
      credential: "sk-fixture-private",
    },
    reason: "酒馆配置已改变",
  });
  const linkId = `sillytavern:${c.id}`;
  const link = f.store.require("targetLink", linkId),
    delivery = f.store.require("delivery", job.id),
    channel = f.store.require("channel", c.id);
  assert.equal(link.state, "conflict");
  assert.equal(delivery.state, "conflict");
  assert.equal(link.conflictSnapshot.credential, undefined);
  await assert.rejects(d.resolve(job.id, "target"), /Invalid URL/);
  assert.deepEqual(f.store.require("targetLink", linkId), link);
  assert.deepEqual(f.store.require("delivery", job.id), delivery);
  assert.deepEqual(f.store.require("channel", c.id), channel);
  f.store.put("targetLink", {
    ...link,
    conflictSnapshot: {
      ...link.conflictSnapshot,
      baseUrl: "https://local.test/v1",
    },
  });
  assert.deepEqual(await d.resolve(job.id, "target"), { resolved: true });
  const adopted = f.store.require("channel", c.id);
  assert.equal(adopted.name, "Local");
  assert.equal(adopted.baseUrl, "https://local.test");
  assert.deepEqual(adopted.models, ["model-B"]);
  assert.equal(f.store.require("targetLink", linkId).state, "applied");
  assert.equal(f.store.require("delivery", job.id).state, "superseded");
});

test("All API Hub observations compare reported managed fields only", async (t) => {
  const f = await fixture(t);
  const d = f.app.services.distribution;
  hubAccount(f);
  await adopt(f, "all-api-hub");
  const token = issueToken(f.store, "connector", {
    target: "all-api-hub",
    sourceId: "all-api-hub",
  });
  const [job] = await claim(f, token);
  assert.equal(job.payload.automaticExecutionEnabled, true);
  assert.equal(job.payload.disabled, false);
  // The plugin applied every field but reports only the ones it stores natively.
  await receipt(f, token, {
    id: job.id,
    lease: job.lease,
    state: "applied",
    remoteId: "hub-1",
    snapshot: { name: "Fixture", checkinUrl: null },
  });
  const linkId = `all-api-hub:${f.account.id}`;
  let seconds = 0;
  const observe = (changes = {}) => {
    const a = f.store.require("account", f.account.id);
    f.store.put("account", {
      ...a,
      sourceObservation: {
        ...a.sourceObservation,
        ...changes,
        observedAt: new Date(Date.now() + ++seconds * 1000).toISOString(),
      },
    });
    d.reconcile("all-api-hub");
    return [
      f.store.require("targetLink", linkId).state,
      f.store.require("delivery", job.id).state,
    ];
  };
  assert.deepEqual(observe(), ["applied", "applied"]);
  f.store.put("targetLink", {
    ...f.store.require("targetLink", linkId),
    snapshot: {
      name: "Fixture",
      checkinUrl: null,
      automaticExecutionEnabled: null,
      disabled: null,
    },
  });
  assert.deepEqual(observe(), ["applied", "applied"]);
  assert.deepEqual(observe({ checkin: { enabled: false } }), [
    "conflict",
    "conflict",
  ]);
  assert.equal(
    f.store.require("targetLink", linkId).conflictSnapshot
      .automaticExecutionEnabled,
    false,
  );
});

test("a failed adoption leaves the hub link, job and center data unchanged", async (t) => {
  const f = await fixture(t);
  const d = f.app.services.distribution;
  hubAccount(f);
  await adopt(f, "all-api-hub");
  await adopt(f, "chrome-bookmarks");
  const token = issueToken(f.store, "connector", {
    target: "all-api-hub",
    sourceId: "all-api-hub",
  });
  const [job] = await claim(f, token);
  await receipt(f, token, {
    id: job.id,
    lease: job.lease,
    state: "applied",
    remoteId: "hub-1",
    snapshot: {
      name: "Fixture",
      checkinUrl: null,
      automaticExecutionEnabled: true,
      disabled: false,
    },
  });
  const a = f.store.require("account", f.account.id);
  f.store.put("account", {
    ...a,
    sourceObservation: {
      ...a.sourceObservation,
      siteName: "Renamed",
      checkin: { enabled: false },
      observedAt: new Date(Date.now() + 1000).toISOString(),
    },
  });
  d.reconcile("all-api-hub");
  const linkId = `all-api-hub:${f.account.id}`;
  const link = f.store.require("targetLink", linkId),
    delivery = f.store.require("delivery", job.id);
  assert.equal(link.state, "conflict");
  assert.equal(delivery.state, "conflict");
  const update = f.resources.update;
  f.resources.update = function (kind, ...rest) {
    if (kind === "account")
      throw new Problem(
        409,
        "资料已被修改，请读取最新版本",
        undefined,
        "version_conflict",
      );
    return update.call(this, kind, ...rest);
  };
  await assert.rejects(d.resolve(job.id, "target"), { statusCode: 409 });
  assert.equal(f.store.require("site", f.site.id).name, "Fixture");
  assert.deepEqual(f.store.require("targetLink", linkId), link);
  assert.deepEqual(f.store.require("delivery", job.id), delivery);
  f.resources.update = update;
  assert.deepEqual(await d.resolve(job.id, "target"), { resolved: true });
  assert.equal(f.store.require("site", f.site.id).name, "Renamed");
  assert.equal(f.store.require("account", f.account.id).checkinEnabled, false);
  assert.equal(f.store.require("targetLink", linkId).state, "applied");
  assert.equal(f.store.require("delivery", job.id).state, "superseded");
});
