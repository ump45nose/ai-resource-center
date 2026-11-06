import {
  capabilitiesOf,
  legacyTags,
  isRemoved,
  isInternal,
  isRp,
  rpRemoved,
  rpRemovalReason,
  archiveOf,
  usageOf,
} from "./channel-rules.mjs";

// Queries repeat these expressions verbatim; SQLite only uses an expression index on an exact match.
export function migrateIndexes(store) {
  store.db.exec(`
    CREATE INDEX IF NOT EXISTS events_date ON events(business_date);
    CREATE INDEX IF NOT EXISTS calls_channel_result ON calls(channel_id,result,occurred_at);
    CREATE INDEX IF NOT EXISTS entities_delivery ON entities(json_extract(data,'$.target'),json_extract(data,'$.revision')) WHERE kind='delivery';
    CREATE INDEX IF NOT EXISTS entities_operation_state ON entities(json_extract(data,'$.state')) WHERE kind='operation';
  `);
}

export const rpRemovalKey = "migration:rp-out-of-center-v1";
const removalFields = {
  channel: ["enabled", "availability", "management", "recoveryPolicy"],
  site: ["removed"],
};
const pick = (value, keys) =>
  Object.fromEntries(
    keys.filter((k) => Object.hasOwn(value, k)).map((k) => [k, value[k]]),
  );

// Runs once, the first time RP channels are found. Removed channels keep their
// last bookmark contribution so the mirrored Chrome tree does not change.
export function migrateRpRemoval(store) {
  if (store.setting(rpRemovalKey)) return null;
  const sites = store.list("site"),
    channels = store.list("channel");
  const targets = channels.filter((c) => isRp(c) && !isRemoved(c));
  if (!targets.length) return null;
  return store.transaction(() => {
    const at = new Date().toISOString(),
      removal = { kind: "rp", reason: rpRemovalReason, at };
    const shown = (c) => !isRemoved(c) && !isInternal(c);
    const bookmarks = { channels: {}, sites: {} };
    for (const c of targets) {
      const site = sites.find((s) => s.id === c.siteId);
      if (!shown(c) || !site || site.removed || site.resourceExcluded) continue;
      bookmarks.channels[c.id] = {
        siteId: site.id,
        baseUrl: c.baseUrl,
        archiveReasons: archiveOf(c, site),
      };
      bookmarks.sites[site.id] ??= {
        title: site.name,
        url: site.url,
        urls: [
          ...new Set([
            site.url,
            ...(site.aliases || []),
            ...channels
              .filter((x) => x.siteId === site.id && shown(x))
              .map((x) => x.baseUrl),
          ]),
        ],
      };
    }
    const hub =
      store.setting("target:all-api-hub")?.sourceId || "all-api-hub";
    const accounts = store.list("account").filter((a) => !a.mergedInto);
    const linked = (a) =>
      !!a &&
      (a.sourceObservation?.source === hub
        ? a.sourceObservation.present !== false
        : a.source === hub);
    const keep = (siteId) =>
      channels.some((c) => c.siteId === siteId && !isRp(c) && shown(c)) ||
      accounts.some(
        (a) =>
          a.siteId === siteId &&
          (linked(a) ||
            linked(accounts.find((x) => x.id === a.checkinAccountId))),
      );
    const removed = { channels: {}, sites: {} };
    const remove = (kind, value, changes) => {
      removed[`${kind}s`][value.id] = pick(value, removalFields[kind]);
      store.put(kind, {
        ...value,
        ...changes,
        removal,
        version: value.version + 1,
      });
      store.action(value.id, {
        kind,
        fields: [...removalFields[kind], "removal"],
        result: "removed",
        reason: rpRemovalReason,
      });
    };
    for (const c of targets)
      remove("channel", c, {
        enabled: false,
        availability: "已移除",
        management: { ...c.management, state: "removed" },
        recoveryPolicy: { ...c.recoveryPolicy, enabled: false },
      });
    for (const id of new Set(targets.map((c) => c.siteId))) {
      const site = store.get("site", id);
      if (site && !site.removed && !keep(id))
        remove("site", site, { removed: true });
    }
    const deliveries = store
      .list("delivery")
      .filter(
        (j) =>
          j.target === "sillytavern" &&
          !["applied", "superseded"].includes(j.state),
      );
    for (const j of deliveries)
      store.put("delivery", {
        ...j,
        state: "superseded",
        supersededAt: at,
        reason: rpRemovalReason,
      });
    const record = {
      at,
      reason: rpRemovalReason,
      removed,
      bookmarks,
      supersededDeliveries: deliveries.map((j) => j.id),
    };
    store.setting(rpRemovalKey, record);
    return record;
  });
}

// Earlier jobs also pushed name, address, check-in entry and enabled state;
// those fields now belong to the extension, so its values win.
export function migrateHubWriteBack(store) {
  const key = "migration:hub-checkin-writeback-v1";
  if (store.setting(key)) return null;
  return store.transaction(() => {
    const at = new Date().toISOString(),
      reason =
        "名称、地址、签到入口和停用状态以插件为准，中心只回写自动签到开关；旧任务按插件当前值处理";
    const links = store
      .list("targetLink")
      .filter((l) => l.target === "all-api-hub" && l.state === "conflict");
    for (const l of links)
      store.put("targetLink", {
        ...l,
        state: l.appliedAt ? "applied" : "adopted",
        conflictSnapshot: null,
      });
    const jobs = store
      .list("delivery")
      .filter(
        (j) =>
          j.target === "all-api-hub" &&
          !["applied", "superseded"].includes(j.state),
      );
    for (const j of jobs)
      store.put("delivery", {
        ...j,
        state: "superseded",
        supersededAt: at,
        reason,
      });
    const record = {
      at,
      conflicts: links.map((l) => ({
        id: l.id,
        conflictSnapshot: l.conflictSnapshot,
      })),
      deliveries: jobs.map((j) => ({ id: j.id, state: j.state })),
    };
    store.setting(key, record);
    return record;
  });
}

// Use only together with the release that still manages RP channels; this
// release would remove them again on its next start.
export function revertRpRemoval(store) {
  const record = store.setting(rpRemovalKey);
  if (!record) return null;
  return store.transaction(() => {
    const at = new Date().toISOString(),
      restored = { channels: [], sites: [] };
    for (const [kind, fields] of Object.entries(removalFields))
      for (const [id, previous] of Object.entries(record.removed[`${kind}s`])) {
        const value = store.get(kind, id);
        if (!rpRemoved(value)) continue;
        const next = { ...value, version: value.version + 1 };
        for (const key of [...fields, "removal"]) delete next[key];
        store.put(kind, { ...next, ...previous });
        store.action(id, {
          kind,
          fields: [...fields, "removal"],
          result: "restored",
          reason: "撤销 RP 移出中心",
        });
        restored[`${kind}s`].push(id);
      }
    store.setting(`${rpRemovalKey}:reverted:${at}`, {
      ...record,
      revertedAt: at,
      restored,
    });
    store.db.prepare("DELETE FROM settings WHERE key=?").run(rpRemovalKey);
    store.revision++;
    return restored;
  });
}

export function migrateUsage(store) {
  const key = "migration:channel-usage-v1";
  if (store.setting(key)) return;
  store.transaction(() => {
    for (const c of store.list("channel"))
      store.put("channel", { ...c, usage: usageOf(c) });
    store.setting(key, { at: new Date().toISOString() });
  });
}

export function migrateChannels(store) {
  const key = "migration:channel-tags-v1";
  store.transaction(() => {
    for (const site of store.list("site")) {
      if (site.websiteObservation || site.siteDown === undefined) continue;
      store.put("site", {
        ...site,
        websiteObservation: {
          status: site.siteDown ? "unreachable" : "reachable",
          observedAt: site.reachabilityObservedAt || null,
          source: "legacy",
        },
      });
    }
    if (store.setting(key)) return;
    const counts = { channels: 0, failed: 0, removed: 0, tagged: 0 };
    for (const c of store.list("channel")) {
      const tags = c.tags ?? legacyTags(c);
      const state = isRemoved(c)
        ? "removed"
        : c.management?.state ||
          (c.availability?.includes("维护") || c.availability?.includes("调用")
            ? "maintenance"
            : c.availability?.includes("网站")
              ? "closed"
              : "active");
      store.put("channel", {
        ...c,
        legacyCategory: c.legacyCategory || c.category || "general",
        tags,
        capabilities: capabilitiesOf(c),
        management: { ...c.management, state },
        tagHistory:
          c.tagHistory ||
          (tags.length
            ? [{ tags, source: "旧分组迁移", at: new Date().toISOString() }]
            : []),
      });
      counts.channels++;
      counts.failed += Number(!!c.availability && !isRemoved(c));
      counts.removed += Number(isRemoved(c));
      counts.tagged += Number(tags.length > 0);
    }
    const sources = (store.setting("sources") || []).map((s) => ({
      ...s,
      ...(typeof s.version === "string"
        ? { platformVersion: s.version, version: 1 }
        : { version: s.version || 1 }),
      ...(s.kind === "cpa" ? { enabled: false, syncEnabled: false } : {}),
      ...(s.kind === "newapi"
        ? {
            syncEnabled: s.syncEnabled ?? false,
            inventoryMinutes: s.inventoryMinutes || 10,
            callsMinutes: s.callsMinutes || 1,
          }
        : {}),
    }));
    store.setting("sources", sources);
    store.setting(key, { ...counts, at: new Date().toISOString() });
  });
}
