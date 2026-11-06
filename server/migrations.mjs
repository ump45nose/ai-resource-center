import {
  capabilitiesOf,
  legacyTags,
  isRemoved,
  usageOf,
} from "./channel-rules.mjs";

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
