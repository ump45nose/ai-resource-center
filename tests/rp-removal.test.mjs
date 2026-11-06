import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app.mjs";
import { issueToken } from "../server/auth.mjs";
import { digest } from "../server/canonical.mjs";
import { archiveLabels, isRemoved } from "../server/channel-rules.mjs";
import { bookmarkPlan } from "../server/bookmarks.mjs";
import {
  migrateRpRemoval,
  revertRpRemoval,
  rpRemovalKey,
} from "../server/migrations.mjs";
import { Store } from "../server/store.mjs";
import { fixture } from "./helpers.mjs";

// Verbatim copy of bookmarkPlan from before RP channels left the center.
function legacyBookmarkPlan(resources) {
  const usageLabels = {
    general: "通用",
    image: "生图",
    video: "视频",
    rp: "酒馆",
  };
  const sites = [];
  let cursor = "0";
  do {
    const page = resources.sites({ cursor, limit: 200 });
    sites.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  const folders = [
    ...Object.entries(usageLabels).map(([usage, name]) => ({
      path: [name],
      items: sites.filter((s) =>
        s.channels.some((c) => c.usage === usage && !c.archiveReasons.length) ||
        (usage === "general" && !s.channels.length && s.accounts.length),
      ),
    })),
    ...Object.entries(archiveLabels).map(([reason, name]) => ({
      path: ["归档", name],
      items: sites.filter((s) =>
        s.channels.some((c) => c.archiveReasons.includes(reason)),
      ),
    })),
  ].map((folder) => ({
    path: folder.path,
    items: folder.items.map((s) => ({
      siteId: s.id,
      title: s.name,
      url: s.websiteUrl,
    })),
  }));
  return {
    schemaVersion: 3,
    rootTitle: "公益站",
    generatedAt: new Date().toISOString(),
    folders,
    sites: sites.map((s) => ({
      id: s.id,
      urls: [
        ...new Set([
          s.websiteUrl,
          ...(s.aliases || []),
          ...s.channels.map((c) => c.baseUrl),
        ]),
      ],
    })),
  };
}

const withoutTime = ({ generatedAt, ...plan }) => plan;

const hubObservation = (externalId, siteName) => ({
  source: "all-api-hub",
  externalId,
  name: "Login",
  siteName,
  siteUrl: "https://hub.test",
  enabled: true,
  checkin: { enabled: true, customUrl: null },
  present: true,
  observedAt: new Date(Date.now() - 60000).toISOString(),
});

function rp(store, site, account, extra = {}) {
  return store.put("channel", {
    siteId: site.id,
    accountId: account.id,
    name: `${site.name} RP`,
    baseUrl: `${site.url}/v1`,
    protocol: "OpenAI",
    category: "rp",
    usage: "rp",
    tags: ["no_probe", "no_code"],
    capabilities: ["text"],
    models: ["rp-model"],
    headers: [],
    enabled: true,
    management: { state: "active" },
    ...extra,
  });
}

function seed(f) {
  const { store, resources } = f;
  const site = (name, url, extra = {}) =>
    store.put("site", { ...resources.site({ name, url }), ...extra });
  const account = (s, extra = {}) =>
    store.put("account", {
      siteId: s.id,
      name: `${s.name} account`,
      balance: 5,
      unit: "credits",
      quota: "long",
      benefit: {},
      ...extra,
    });
  const alone = site("Alpha RP", "https://rp-only.test");
  const aloneAccount = account(alone);
  const hub = site("Beta RP Hub", "https://rp-hub.test");
  const hubAccount = account(hub, {
    sourceObservation: hubObservation("hub-beta", "Beta RP Hub"),
  });
  const mixed = site("Gamma Mixed", "https://mixed.test", {
    pinned: true,
    aliases: ["https://mixed-alias.test"],
  });
  const mixedAccount = account(mixed);
  const general = resources.channel({
    siteId: mixed.id,
    accountId: mixedAccount.id,
    name: "Gamma general",
    baseUrl: "https://mixed.test/v1",
    models: ["model-A"],
    enabled: true,
  });
  const archived = site("Delta Archived", "https://rp-archived.test");
  const archivedAccount = account(archived);
  const welfare = site("Welfare", "https://welfare.test");
  const executor = account(welfare, {
    role: "checkin",
    sourceObservation: hubObservation("personal-checkin-x", "Welfare"),
  });
  const delegated = site("Epsilon Delegate", "https://rp-delegate.test");
  const delegatedAccount = account(delegated, { checkinAccountId: executor.id });
  const channels = {
    alone: rp(store, alone, aloneAccount),
    hub: rp(store, hub, hubAccount),
    mixed: rp(store, mixed, mixedAccount, {
      baseUrl: "https://mixed-rp.test/v1",
    }),
    mixedArchived: rp(store, mixed, mixedAccount, {
      baseUrl: "https://mixed-rp-old.test/v1",
      enabled: false,
      archiveReason: "balance",
      availability: "无余额无签到",
      management: { state: "maintenance" },
    }),
    archived: rp(store, archived, archivedAccount, {
      enabled: false,
      archiveReason: "website",
      availability: "网站打不开",
      management: { state: "closed" },
    }),
    delegated: rp(store, delegated, delegatedAccount),
  };
  return {
    sites: { alone, hub, mixed, archived, welfare, delegated },
    accounts: { hubAccount, delegatedAccount, executor },
    general,
    channels,
  };
}

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

const revisions = (d, target) =>
  Object.fromEntries(
    d.entries(target).map((e) => [e.subject, digest(e.payload)]),
  );

test("RP channels leave every view while the mirrored bookmark tree stays byte-identical", async (t) => {
  const f = await fixture(t);
  const d = f.app.services.distribution;
  const source = newApiSource(f);
  const s = seed(f);
  f.store.put("channel", {
    ...f.store.require("channel", s.channels.mixed.id),
    gateway: { sourceId: source.id, channelId: 7 },
  });
  const { previewId } = await d.preview("chrome-bookmarks");
  d.confirm("chrome-bookmarks", previewId);
  const token = issueToken(f.store, "connector", {
    target: "chrome-bookmarks",
    sourceId: "all-api-hub",
  });
  const claim = async () =>
    (await f.call("GET", "/api/v2/connector/jobs", undefined, token)).json()
      .items;
  const [job] = await claim();
  const receipt = await f.call(
    "POST",
    "/api/v2/connector/receipts",
    {
      id: job.id,
      lease: job.lease,
      state: "applied",
      remoteId: "root",
      snapshot: { rootId: "root", count: 1, folders: [] },
    },
    token,
  );
  assert.equal(receipt.statusCode, 200, receipt.body);

  const before = withoutTime(bookmarkPlan(f.resources));
  assert.deepEqual(before, withoutTime(legacyBookmarkPlan(f.resources)));
  const folder = (plan, ...path) =>
    plan.folders
      .find((x) => x.path.join("/") === path.join("/"))
      .items.map((i) => i.siteId);
  assert.deepEqual(folder(before, "酒馆"), [
    s.sites.mixed.id,
    s.sites.alone.id,
    s.sites.hub.id,
    s.sites.delegated.id,
  ]);
  assert.deepEqual(folder(before, "归档", "网站打不开"), [s.sites.archived.id]);
  assert.deepEqual(folder(before, "归档", "无余额无签到"), [s.sites.mixed.id]);
  const bookmarkRevision = digest(d.entries("chrome-bookmarks")[0].payload);
  assert.equal(bookmarkRevision, job.revision);
  const newApi = revisions(d, "newapi"),
    notion = revisions(d, "notion");
  assert.deepEqual(Object.keys(d.entries("newapi")[0].payload).sort(), [
    "accountId", "baseUrl", "channelId", "connectionVersion",
    "credentialFingerprint", "credentialHeadersId", "credentialId",
    "enabled", "headerValues", "models", "name", "nativeCredentialRef",
    "order", "protocol", "routing", "siteId", "tags", "usage",
  ]);
  const accounts = f.store.list("account");
  const rows = (table) =>
    f.store.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n;
  const counts = ["events", "calls", "actions"].map(rows);

  const record = migrateRpRemoval(f.store);
  assert.ok(record);
  assert.deepEqual(
    Object.keys(record.removed.channels).sort(),
    Object.values(s.channels)
      .map((c) => c.id)
      .sort(),
  );
  assert.deepEqual(
    Object.keys(record.removed.sites).sort(),
    [s.sites.alone.id, s.sites.archived.id].sort(),
  );
  const after = withoutTime(bookmarkPlan(f.resources));
  assert.deepEqual(after, before);
  assert.equal(
    JSON.stringify(after),
    JSON.stringify(before),
    "byte-identical plan",
  );
  assert.equal(
    digest(d.entries("chrome-bookmarks")[0].payload),
    bookmarkRevision,
  );
  d.reconcile();
  const bookmarkJobs = f.store
    .list("delivery")
    .filter((j) => j.target === "chrome-bookmarks");
  assert.equal(bookmarkJobs.length, 1);
  assert.equal(bookmarkJobs[0].state, "applied");
  assert.deepEqual(await claim(), []);

  for (const c of Object.values(s.channels)) {
    const stored = f.store.require("channel", c.id);
    assert.ok(isRemoved(stored));
    assert.equal(stored.enabled, false);
    assert.equal(stored.removal.kind, "rp");
    assert.equal(stored.version, c.version + 1);
  }
  assert.deepEqual(record.removed.channels[s.channels.archived.id], {
    enabled: false,
    availability: "网站打不开",
    management: { state: "closed" },
  });
  assert.equal(f.store.require("site", s.sites.alone.id).removed, true);
  assert.equal(f.store.require("site", s.sites.archived.id).removed, true);
  assert.deepEqual(f.store.list("account"), accounts);
  assert.deepEqual(["events", "calls"].map(rows), counts.slice(0, 2));
  assert.ok(rows("actions") > counts[2]);

  const rpIds = new Set(Object.values(s.channels).map((c) => c.id));
  const leaks = (value) =>
    [...rpIds].filter((id) => JSON.stringify(value).includes(id));
  const listed = (await f.call("GET", "/api/v2/sites?limit=200")).json();
  assert.deepEqual(leaks(listed), []);
  const shown = new Map(listed.items.map((x) => [x.id, x]));
  assert.ok(!shown.has(s.sites.alone.id));
  assert.ok(!shown.has(s.sites.archived.id));
  assert.deepEqual(shown.get(s.sites.hub.id).channels, []);
  assert.deepEqual(
    shown.get(s.sites.hub.id).accounts.map((a) => a.id),
    [s.accounts.hubAccount.id],
  );
  assert.deepEqual(
    shown.get(s.sites.mixed.id).channels.map((c) => c.id),
    [s.general.id],
  );
  const delegate = shown.get(s.sites.delegated.id).accounts[0];
  assert.equal(delegate.checkinAccount.id, s.accounts.executor.id);
  for (const url of [
    "/api/v2/overview",
    "/api/v2/models?limit=200",
    "/api/v2/attention",
    "/api/v2/checkins",
    `/api/v2/sites/${s.sites.mixed.id}`,
  ]) {
    const r = await f.call("GET", url);
    assert.equal(r.statusCode, 200, `${url}: ${r.body}`);
    assert.deepEqual(leaks(r.json()), [], url);
  }
  const overview = (await f.call("GET", "/api/v2/overview")).json();
  assert.deepEqual(Object.keys(overview.channels), ["general", "media", "client"]);
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
      params: { name: "resource_list_sites", arguments: { limit: 200 } },
    },
  });
  assert.equal(mcp.statusCode, 200, mcp.body);
  assert.equal(mcp.json().result.isError, undefined, mcp.body);
  assert.deepEqual(leaks(mcp.json()), []);

  const newApiAfter = revisions(d, "newapi");
  assert.ok(!(s.channels.mixed.id in newApi));
  assert.deepEqual(newApiAfter, newApi);
  const notionAfter = revisions(d, "notion");
  assert.equal(notionAfter[f.site.id], notion[f.site.id]);
  assert.ok(!(s.sites.alone.id in notionAfter));
  assert.ok(!(s.sites.archived.id in notionAfter));
  assert.notEqual(notionAfter[s.sites.mixed.id], notion[s.sites.mixed.id]);
  assert.deepEqual(leaks(d.entries("notion")), []);

  assert.equal(migrateRpRemoval(f.store), null);
  assert.deepEqual(f.store.setting(rpRemovalKey), record);

  const revived = f.resources.site(
    { name: "Alpha RP", url: "https://rp-only.test" },
    "all-api-hub",
  );
  assert.equal(revived.removed, undefined);
  assert.equal(revived.removal, undefined);
  assert.deepEqual(withoutTime(bookmarkPlan(f.resources)), before);
  const mixed = f.store.require("site", s.sites.mixed.id);
  f.resources.update("site", mixed.id, mixed.version, { name: "Gamma Renamed" });
  const renamed = bookmarkPlan(f.resources).folders;
  const title = (path) =>
    renamed
      .find((x) => x.path.join("/") === path)
      .items.find((i) => i.siteId === mixed.id).title;
  assert.equal(title("通用"), "Gamma Renamed");
  assert.equal(title("酒馆"), "Gamma Mixed");
  assert.equal(title("归档/无余额无签到"), "Gamma Mixed");
});

test("the RP removal runs at startup, once, and reverts to the recorded state", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "arc-rp-"));
  let app;
  t.after(async () => {
    await app?.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const store = new Store(dir);
  const site = store.put("site", {
    name: "Only RP",
    url: "https://only-rp.test",
    sources: ["manual"],
  });
  const account = store.put("account", { siteId: site.id, name: "RP" });
  const channel = rp(store, site, account, {
    recoveryPolicy: { enabled: true },
  });
  const tavernJob = store.put("delivery", {
    target: "sillytavern",
    subject: channel.id,
    revision: "r",
    payload: {},
    state: "pending",
  });
  store.close();
  app = await createApp({ dir });
  const removed = app.services.store.require("channel", channel.id);
  assert.ok(isRemoved(removed));
  assert.equal(app.services.store.require("site", site.id).removed, true);
  const retired = app.services.store.require("delivery", tavernJob.id);
  assert.equal(retired.state, "superseded");
  assert.match(retired.reason, /酒馆/);
  assert.equal(migrateRpRemoval(app.services.store), null);
  await app.close();
  app = await createApp({ dir });
  const s = app.services.store;
  assert.deepEqual(s.require("channel", channel.id), removed);
  const restored = revertRpRemoval(s);
  assert.deepEqual(restored, { channels: [channel.id], sites: [site.id] });
  const back = s.require("channel", channel.id);
  assert.equal(back.removal, undefined);
  assert.equal(back.enabled, true);
  assert.equal(back.availability, undefined);
  assert.equal(back.management.state, "active");
  assert.deepEqual(back.recoveryPolicy, { enabled: true });
  assert.equal(s.require("site", site.id).removed, undefined);
  assert.equal(s.setting(rpRemovalKey), null);
  assert.ok(
    s.db
      .prepare("SELECT key FROM settings WHERE key LIKE ?")
      .get(`${rpRemovalKey}:reverted:%`),
  );
});
