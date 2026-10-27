import { canonicalApi } from "./domain.mjs";
import {
  isRemoved,
  usageOf,
  legacyTags,
  capabilitiesOf,
} from "./channel-rules.mjs";
import { hubKeyId, seedHubKeys } from "./hub-keys.mjs";

const dedupe = (rows, key) => [
  ...new Map(rows.map((row) => [key(row), row])).values(),
];
const origin = (url) => new URL(url).origin;
const active = (c) =>
  !isRemoved(c) && !c.internal && !c.mergedInto && !c.sourceOnly;

// Rewrite object references, not event identifiers or task contents.
function references(value, from, to, field = "") {
  if (Array.isArray(value))
    return value.map((v) => references(v, from, to, field));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, v]) => [
        key,
        references(v, from, to, key),
      ]),
    );
  return /(?:Id|Ids)$/.test(field) && value === from ? to : value;
}

function rebind(store, kind, from, to) {
  for (const row of store.db
    .prepare("SELECT kind,id,data,version FROM entities")
    .all()) {
    if (row.kind === kind && row.id === from) continue;
    const before = JSON.parse(row.data),
      after = references(before, from, to);
    if (JSON.stringify(before) !== JSON.stringify(after))
      store.put(row.kind, { ...after, id: row.id, version: row.version });
  }
  store.db
    .prepare("UPDATE refs SET id=? WHERE kind=? AND id=?")
    .run(to, kind, from);
  if (kind === "channel")
    store.db
      .prepare("UPDATE calls SET channel_id=? WHERE channel_id=?")
      .run(to, from);
  if (kind === "account")
    store.db
      .prepare("UPDATE events SET account_id=? WHERE account_id=?")
      .run(to, from);
  store.db.prepare("UPDATE actions SET target=? WHERE target=?").run(to, from);
  for (const auth of store.db
    .prepare("SELECT token_hash,scope FROM auth")
    .all()) {
    const after = references(JSON.parse(auth.scope), from, to);
    store.db
      .prepare("UPDATE auth SET scope=? WHERE token_hash=?")
      .run(JSON.stringify(after), auth.token_hash);
  }
}

function mergeAccount(store, from, to) {
  if (from === to) return;
  const old = store.require("account", from),
    keep = store.require("account", to);
  const latest = [keep, old]
    .filter((a) => a.balance != null)
    .sort(
      (a, b) => Date.parse(b.confirmedAt || 0) - Date.parse(a.confirmedAt || 0),
    )[0];
  rebind(store, "account", from, to);
  store.put("account", {
    ...keep,
    ...(!keep.sourceObservation && old.sourceObservation
      ? { sourceObservation: old.sourceObservation }
      : {}),
    ...(!keep.keySync && old.keySync ? { keySync: old.keySync } : {}),
    ...(latest
      ? {
          balance: latest.balance,
          unit: latest.unit,
          confirmedAt: latest.confirmedAt,
        }
      : {}),
    hubKeys: dedupe(
      [...(old.hubKeys || []), ...(keep.hubKeys || [])],
      hubKeyId,
    ),
    mergedFrom: [...new Set([...(keep.mergedFrom || []), from])],
  });
  store.put("account", { ...old, mergedInto: to, version: old.version + 1 });
}

function mergeChannel(store, from, to, mergePool = false) {
  if (from === to) return;
  let old = store.require("channel", from),
    keep = store.require("channel", to);
  if (mergePool && old.accountId !== keep.accountId)
    mergeAccount(store, old.accountId, keep.accountId);
  rebind(store, "channel", from, to);
  keep = store.require("channel", to);
  const relatedGateways = dedupe(
    [
      ...(keep.relatedGateways || []),
      ...(old.relatedGateways || []),
      ...(old.gateway ? [old.gateway] : []),
    ],
    (g) => `${g.sourceId}:${g.channelId ?? g.provider}`,
  ).filter((g) => JSON.stringify(g) !== JSON.stringify(keep.gateway));
  store.put("channel", {
    ...keep,
    ...(!keep.credentialId && old.credentialId
      ? {
          credentialId: old.credentialId,
          credentialHeadersId: old.credentialHeadersId,
          hubObservation: old.hubObservation,
        }
      : {}),
    relatedGateways,
    mergedFrom: [...new Set([...(keep.mergedFrom || []), from])],
    version: keep.version + 1,
  });
  store.put("channel", {
    ...old,
    mergedInto: to,
    enabled: false,
    availability: "已移除",
    management: { ...old.management, state: "removed" },
    version: old.version + 1,
  });
}

function mergeSite(store, from, to) {
  const old = store.require("site", from),
    keep = store.require("site", to);
  rebind(store, "site", from, to);
  store.put("site", {
    ...keep,
    aliases: [
      ...new Set([...(keep.aliases || []), old.url, ...(old.aliases || [])]),
    ].filter((u) => u !== keep.url),
    sources: [...new Set([...(keep.sources || []), ...(old.sources || [])])],
    checkinUrl: keep.checkinUrl || old.checkinUrl,
    mergedFrom: [...new Set([...(keep.mergedFrom || []), from])],
    version: keep.version + 1,
  });
  store.put("site", {
    ...old,
    mergedInto: to,
    removed: true,
    version: old.version + 1,
  });
}

const curatedFields = [
  "name",
  "category",
  "baseUrl",
  "protocol",
  "authType",
  "models",
  "enabled",
  "mode",
  "priority",
  "weight",
  "group",
  "headers",
  "client",
  "bindings",
  "note",
  "availability",
  "callIssue",
  "apply",
  "applyMsg",
  "nativePassthrough",
  "nativeAudit",
  "imageAudit",
  "videoAudit",
  "piAudit",
];
function restoreCurated(store, id, legacy) {
  const current = store.require("channel", id),
    result = { ...current };
  for (const field of curatedFields) {
    if (Object.hasOwn(legacy, field)) result[field] = legacy[field];
    else delete result[field];
  }
  // A new source key can fill an empty slot, but cannot replace the curated key.
  result.credentialId = legacy.credentialId || current.credentialId;
  result.credentialState =
    legacy.credentialState ||
    (result.credentialId ? "present" : current.credentialState);
  result.tags = legacy.tags ?? legacyTags(legacy);
  result.usage = usageOf(legacy);
  result.capabilities = capabilitiesOf(legacy);
  result.management = {
    ...current.management,
    state: isRemoved(legacy)
      ? "removed"
      : legacy.availability?.includes("维护") ||
          legacy.availability?.includes("调用")
        ? "maintenance"
        : legacy.availability?.includes("网站")
          ? "closed"
          : "active",
  };
  result.version = current.version + 1;
  store.put("channel", result);
}

// Preview and apply use the same transaction. Preview rolls back all writes.
export function consolidateResources(store, legacy, apply = false) {
  const marker = "consolidation:legacy-20261021-final";
  if (store.setting(marker))
    return { alreadyApplied: true, ...store.setting(marker) };
  const authority = new Map(
    legacy
      .prepare("SELECT id,data FROM entities WHERE kind='channel'")
      .all()
      .map((r) => [r.id, JSON.parse(r.data)]),
  );
  const authoritySites = new Set(
    legacy
      .prepare("SELECT id FROM entities WHERE kind='site'")
      .all()
      .map((r) => r.id),
  );
  const report = {
    sites: [],
    channels: [],
    emptyRecords: [],
    excluded: [],
    restored: [],
  };
  store.db.exec("BEGIN IMMEDIATE");
  try {
    if (!store.setting("migration:hub-account-keys-v1")) seedHubKeys(store);
    const byOrigin = new Map();
    for (const s of store.list("site").filter((s) => !s.mergedInto)) {
      const key = origin(s.url);
      if (!byOrigin.has(key)) byOrigin.set(key, []);
      byOrigin.get(key).push(s);
    }
    const originalChannels = store.list("channel");
    for (const [url, sites] of byOrigin) {
      if (sites.length < 2) continue;
      const rank = (s) =>
        Number(authoritySites.has(s.id)) * 10 +
        originalChannels.filter(
          (c) => c.siteId === s.id && authority.has(c.id) && active(c),
        ).length *
          100;
      sites.sort((a, b) => rank(b) - rank(a));
      for (const drop of sites.slice(1)) {
        mergeSite(store, drop.id, sites[0].id);
        report.sites.push({ url, from: drop.id, to: sites[0].id });
      }
    }
    for (const c of store
      .list("channel")
      .filter((c) => c.hubPlaceholder && !c.sourceOnly)) {
      store.put("channel", {
        ...c,
        sourceOnly: true,
        enabled: false,
        availability: "已移除",
        management: { ...c.management, state: "removed" },
        version: c.version + 1,
      });
      report.emptyRecords.push({ name: c.name, id: c.id });
    }
    const affected = new Set();
    // Source keys belonging to an existing curated account enrich that account.
    for (const c of store
      .list("channel")
      .filter(
        (c) => c.source === "all-api-hub" && !c.hubPlaceholder && !c.mergedInto,
      )) {
      const choices = store
        .list("channel")
        .filter(
          (x) =>
            x.accountId === c.accountId &&
            authority.has(x.id) &&
            !x.mergedInto &&
            !x.sourceOnly,
        );
      if (!choices.length) continue;
      choices.sort((a, b) => Number(active(b)) - Number(active(a)));
      const keep = choices[0];
      mergeChannel(store, c.id, keep.id);
      affected.add(keep.id);
      report.channels.push({
        site: store.require("site", keep.siteId).url,
        from: c.id,
        to: keep.id,
        reason: "插件 key 重复生成渠道",
      });
    }
    // Same key + endpoint + protocol + usage is one connection, regardless of gateway.
    const grouped = new Map();
    for (const c of store.list("channel").filter(active)) {
      if (!c.credentialId) continue;
      const fingerprint = store.db
        .prepare("SELECT fingerprint FROM credentials WHERE id=?")
        .get(c.credentialId)?.fingerprint;
      if (!fingerprint) continue;
      const key = JSON.stringify([
        c.siteId,
        canonicalApi(c.baseUrl, c.protocol),
        c.protocol,
        usageOf(c),
        fingerprint,
      ]);
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(c);
    }
    for (const group of grouped.values()) {
      if (group.length < 2) continue;
      const rank = (c) =>
        Number(authority.has(c.id)) * 10 +
        Number(c.gateway?.sourceId === "new-api") * 2;
      group.sort((a, b) => rank(b) - rank(a));
      const keep = group[0];
      for (const drop of group.slice(1)) {
        mergeChannel(store, drop.id, keep.id, true);
        affected.add(keep.id);
        report.channels.push({
          site: store.require("site", keep.siteId).url,
          from: drop.id,
          to: keep.id,
          reason: "同 key、入口、协议和用途",
        });
      }
    }
    for (const id of affected)
      if (authority.has(id)) {
        restoreCurated(store, id, authority.get(id));
        report.restored.push({ id, name: authority.get(id).name });
      }
    // This reviewed entry is a local gateway, not a public upstream resource.
    const mistaken = "e8575803-a181-4dc1-9e18-180e19e817a9";
    const c = store.get("channel", mistaken);
    if (c) {
      store.put("channel", {
        ...c,
        enabled: false,
        availability: "已移除",
        management: {
          ...c.management,
          state: "removed",
          reason: "本地 New API 网关误入公益站清单",
        },
        version: c.version + 1,
      });
      const site = store.require("site", c.siteId);
      store.put("site", {
        ...site,
        resourceExcluded: true,
        version: site.version + 1,
      });
      report.excluded.push({ id: c.id, name: c.name });
    }
    const at = new Date().toISOString();
    store.setting(marker, { at, report });
    if (apply) store.db.exec("COMMIT");
    else store.db.exec("ROLLBACK");
    return { applied: apply, at, ...report };
  } catch (error) {
    store.db.exec("ROLLBACK");
    throw error;
  }
}

// The retired duplicates retain keys that were omitted from their RP copies.
const legacyRpKeyLinks = [
  ["a5936660-f271-4a6c-acf7-dd7b80d36fd5", "3ed53610-0aa8-4767-926f-2e20684ea874"],
  ["56314e05-adc9-45a7-9fd7-84d4cd38ca1b", "b7252eaa-378c-4d2e-8d11-a565f1880a64"],
  ["619ea0c7-ccef-4c40-95d9-d84e9c0fb583", "dbcdcc45-4026-4ae4-b3d6-8265b3fe2a04"],
  ["1911fdfa-0887-434f-a740-faa71ab305e9", "aba76ec3-0284-4929-b9f4-351a1f7863bc"],
];

// Confirmed against the saved profiles and their proxy credentials on fn.
const legacyRpProfileLinks = [
  [
    "00e122d3-0856-4f5c-902a-9ba0a7efc0fe",
    "5224de61-10e2-4d8a-8299-3f1031b66940",
    "https://sunlea.de",
  ],
  [
    "560b243a-ef24-487c-903a-157ffadbe708",
    "9b0ffe56-621d-4f0b-ba41-05f1a6db54ca",
    "https://ruoyun.icu",
  ],
];

function recoverLegacyRpKeys(store, legacy) {
  const recovered = [];
  for (const [id, sourceId] of legacyRpKeyLinks) {
    const current = store.require("channel", id);
    if (current.credentialId || current.nativeCredentialRef) continue;
    const row = legacy
      .prepare("SELECT data FROM entities WHERE kind='channel' AND id=?")
      .get(sourceId);
    const original = JSON.parse(row.data);
    if (
      usageOf(current) !== "rp" ||
      new URL(current.baseUrl).origin !== new URL(original.baseUrl).origin
    )
      throw new Error("酒馆凭据恢复的站点或用途不匹配");
    const credential = legacy
      .prepare("SELECT * FROM credentials WHERE id=?")
      .get(original.credentialId);
    if (!credential) throw new Error("旧版重复渠道的凭据不存在");
    store.db
      .prepare("INSERT OR REPLACE INTO credentials(id,value,fingerprint) VALUES(?,?,?)")
      .run(credential.id, credential.value, credential.fingerprint);
    const at = new Date().toISOString();
    store.put("channel", {
      ...current,
      credentialId: credential.id,
      credentialRecovery: {
        source: "legacy-final-20261021-111818",
        channelId: sourceId,
        at,
      },
      connectionVersion: (current.connectionVersion || 1) + 1,
      version: current.version + 1,
    });
    for (const o of store.list("offering").filter((o) => o.channelId === id))
      store.put("offering", { ...o, verification: null });
    store.action(id, { kind: "restore_rp_key", sourceChannelId: sourceId, at });
    recovered.push({ id, name: current.name, sourceChannelId: sourceId });
  }
  for (const [id, profileId, origin] of legacyRpProfileLinks) {
    const current = store.require("channel", id);
    if (current.credentialId || current.nativeCredentialRef) continue;
    if (usageOf(current) !== "rp" || new URL(current.baseUrl).origin !== origin)
      throw new Error("酒馆原生凭据恢复的站点或用途不匹配");
    const at = new Date().toISOString();
    store.put("channel", {
      ...current,
      nativeCredentialRef: { profileId, device: "fn:default-user" },
      credentialRecovery: { source: "sillytavern", profileId, at },
      connectionVersion: (current.connectionVersion || 1) + 1,
      version: current.version + 1,
    });
    for (const o of store.list("offering").filter((o) => o.channelId === id))
      store.put("offering", { ...o, verification: null });
    store.action(id, { kind: "restore_native_credential_ref", profileId, at });
    recovered.push({ id, name: current.name, sourceProfileId: profileId });
  }
  return recovered;
}

export function restoreLegacyRpCredentials(store, legacy, apply = false) {
  store.db.exec("BEGIN IMMEDIATE");
  try {
    const recovered = recoverLegacyRpKeys(store, legacy);
    store.db.exec(apply ? "COMMIT" : "ROLLBACK");
    return { applied: apply, recovered };
  } catch (error) {
    store.db.exec("ROLLBACK");
    throw error;
  }
}

// Restore the complete reviewed inventory, not only records touched by a merge.
export function restoreFinalResources(store, legacy, apply = false) {
  const source = "legacy-final-20261021-111818",
    at = new Date().toISOString();
  const read = (kind) =>
    legacy
      .prepare("SELECT id,data FROM entities WHERE kind=?")
      .all(kind)
      .map((r) => ({ ...JSON.parse(r.data), id: r.id }));
  const channels = read("channel"),
    sites = read("site"),
    accounts = read("account");
  const siteById = new Map(sites.map((s) => [s.id, s]));
  const canonical = (kind, id) => {
    let row = store.get(kind, id);
    while (row?.mergedInto) {
      id = row.mergedInto;
      row = store.get(kind, id);
    }
    return id;
  };
  const groups = {
    "归档-无余额无签到": "balance",
    "归档-网站或key失效": "invalid",
    "归档-调用不稳定": "unstable",
    "待复核-调用失败": "call",
    "暂停维护(模型不足或者服务维护)": "maintenance",
  };
  const report = {
    source,
    at,
    sites: sites.length,
    accounts: accounts.length,
    channels: channels.length,
    keys: 0,
    mergedChannels: 0,
    changed: [],
  };
  store.db.exec("BEGIN IMMEDIATE");
  try {
    for (const old of sites) {
      const current = store.get("site", old.id);
      store.put("site", {
        ...current,
        ...old,
        aliases: [
          ...new Set([...(old.aliases || []), ...(current?.aliases || [])]),
        ],
        sources: [
          ...new Set([...(old.sources || []), ...(current?.sources || [])]),
        ],
        curation: { source, at },
        version: (current?.version || 0) + 1,
      });
    }
    for (const old of accounts) {
      const current = store.get("account", old.id);
      store.put("account", {
        ...current,
        ...old,
        ...(current
          ? Object.fromEntries(
              [
                "balance",
                "unit",
                "confirmedAt",
                "observedAt",
                "sourceObservation",
                "hubKeys",
                "keySync",
                "mergedInto",
                "mergedFrom",
              ]
                .filter((k) => Object.hasOwn(current, k))
                .map((k) => [k, current[k]]),
            )
          : {}),
        siteId: canonical("site", old.siteId),
        curation: { source, at },
        version: (current?.version || 0) + 1,
      });
    }
    const credentialIds = new Set();
    for (const old of channels)
      for (const key of ["credentialId", "credentialHeadersId"])
        if (old[key]) credentialIds.add(old[key]);
    for (const id of credentialIds) {
      const row = legacy
        .prepare("SELECT * FROM credentials WHERE id=?")
        .get(id);
      if (!row) throw new Error("终版渠道凭据引用不存在，请核对配套快照");
      store.db
        .prepare(
          "INSERT OR REPLACE INTO credentials(id,value,fingerprint) VALUES(?,?,?)",
        )
        .run(row.id, row.value, row.fingerprint);
      report.keys++;
    }
    for (const old of channels) {
      const current = store.get("channel", old.id),
        keep = canonical("channel", old.id);
      // Explicitly reviewed missing-key repairs survive a later snapshot restore.
      // Raw source observations do not qualify as a selected credential.
      const restored = {
        ...old,
        ...(current?.credentialRecovery &&
        !old.credentialId &&
        canonicalApi(current.baseUrl, current.protocol) ===
          canonicalApi(old.baseUrl, old.protocol)
          ? {
              credentialId: current.credentialId,
              nativeCredentialRef:
                current.nativeCredentialRef ?? old.nativeCredentialRef,
              credentialRecovery: current.credentialRecovery,
            }
          : {}),
      };
      const merged = keep !== old.id;
      const archiveReason =
        !isRemoved(old) && siteById.get(old.siteId)?.siteDown
          ? "website"
          : groups[old.availability] || null;
      const state =
        isRemoved(old) || merged
          ? "removed"
          : archiveReason === "website" || archiveReason === "invalid"
            ? "closed"
            : ["call", "unstable", "maintenance"].includes(archiveReason)
              ? "maintenance"
              : "active";
      const changed = [
        "name",
        "baseUrl",
        "protocol",
        "client",
        "credentialId",
        "nativeCredentialRef",
        "models",
        "enabled",
        "availability",
        "note",
      ].filter(
        (k) => JSON.stringify(current?.[k]) !== JSON.stringify(restored[k]),
      );
      const connectionChanged = [
        "baseUrl",
        "protocol",
        "credentialId",
        "headers",
      ].some(
        (k) => JSON.stringify(current?.[k]) !== JSON.stringify(restored[k]),
      );
      store.put("channel", {
        ...restored,
        siteId: canonical("site", old.siteId),
        accountId: canonical("account", old.accountId),
        usage: usageOf(old),
        tags: old.tags ?? legacyTags(old),
        capabilities: capabilitiesOf(old),
        archiveReason,
        curation: { source, at },
        management: { ...old.management, state },
        ...(current
          ? Object.fromEntries(
              [
                "sourceObservation",
                "relatedGateways",
                "mergedFrom",
                "lastScanAt",
                "catalogObservation",
                "maintenance",
              ]
                .filter((k) => Object.hasOwn(current, k))
                .map((k) => [k, current[k]]),
            )
          : {}),
        ...(merged
          ? { mergedInto: keep, enabled: false, availability: "已移除" }
          : {}),
        connectionVersion:
          (current?.connectionVersion || 1) + Number(connectionChanged),
        version: (current?.version || 0) + 1,
      });
      if (merged) report.mergedChannels++;
      if (changed.length)
        report.changed.push({ id: old.id, name: old.name, fields: changed });
      if (connectionChanged)
        for (const o of store
          .list("offering")
          .filter((o) => o.channelId === old.id))
          store.put("offering", { ...o, verification: null });
    }
    report.recoveredRpCredentials = recoverLegacyRpKeys(store, legacy);
    for (const row of legacy.prepare("SELECT * FROM refs").all())
      if (
        ["site", "account", "channel"].includes(row.kind) &&
        !store.ref(row.source, row.kind, row.external_id)
      )
        store.ref(
          row.source,
          row.kind,
          row.external_id,
          canonical(row.kind, row.id),
        );
    store.setting("curation:legacy-final-20261021", {
      source,
      at,
      sites: report.sites,
      channels: report.channels,
    });
    store.action("curation:legacy-final-20261021", {
      kind: "restore_final_inventory",
      ...report,
    });
    if (apply) store.db.exec("COMMIT");
    else store.db.exec("ROLLBACK");
    return { applied: apply, ...report };
  } catch (error) {
    store.db.exec("ROLLBACK");
    throw error;
  }
}
