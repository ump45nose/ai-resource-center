import { usageLabels, archiveLabels } from "./channel-rules.mjs";
import { rpRemovalKey } from "./migrations.mjs";

// The browser connector deletes tracked bookmarks that leave the plan and moves
// unmanaged root folders aside, so the 酒馆 folder stays in the plan.
const folderNames = { ...usageLabels, rp: "酒馆" };

export function bookmarkPlan(resources) {
  const store = resources.store,
    visible = [];
  let cursor = "0";
  do {
    const page = resources.sites({ cursor, limit: 200 });
    visible.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  // RP channels left the center; their entries stay as they were when they left.
  const frozen = store.setting(rpRemovalKey)?.bookmarks || {
    channels: {},
    sites: {},
  };
  const rank = new Map(store.list("channel").map((c, i) => [c.id, i]));
  const stubs = Object.entries(frozen.channels).map(([id, c]) => ({
    ...c,
    id,
    usage: "rp",
    frozen: true,
  }));
  const shown = new Map(visible.map((s) => [s.id, s]));
  const sites = store
    .list("site")
    .filter(
      (s) =>
        shown.has(s.id) ||
        (frozen.sites[s.id] && !s.mergedInto && !s.resourceExcluded),
    )
    .map((s) => ({
      id: s.id,
      name: s.name,
      pinned: s.pinned,
      live: shown.get(s.id),
      frozen: frozen.sites[s.id],
      accounts: shown.get(s.id)?.accounts || [],
      channels: [
        ...(shown.get(s.id)?.channels || []),
        ...stubs.filter((c) => c.siteId === s.id),
      ].sort((a, b) => rank.get(a.id) - rank.get(b.id)),
    }))
    .sort(
      (a, b) =>
        Number(b.pinned || 0) - Number(a.pinned || 0) ||
        a.name.localeCompare(b.name),
    );
  const membership = (s, test) =>
    s.channels.some((c) => !c.frozen && test(c))
      ? "live"
      : s.channels.some((c) => c.frozen && test(c))
        ? "frozen"
        : null;
  const item = (s, how) =>
    how === "frozen"
      ? { siteId: s.id, title: s.frozen.title, url: s.frozen.url }
      : { siteId: s.id, title: s.live.name, url: s.live.websiteUrl };
  const folder = (path, member) => ({
    path,
    items: sites.flatMap((s) => {
      const how = member(s);
      return how ? [item(s, how)] : [];
    }),
  });
  return {
    schemaVersion: 3,
    rootTitle: "公益站",
    generatedAt: new Date().toISOString(),
    folders: [
      ...Object.entries(folderNames).map(([usage, name]) =>
        folder(
          [name],
          (s) =>
            membership(
              s,
              (c) => c.usage === usage && !c.archiveReasons.length,
            ) ||
            (usage === "general" && !s.channels.length && s.accounts.length
              ? "live"
              : null),
        ),
      ),
      ...Object.entries(archiveLabels).map(([reason, name]) =>
        folder(["归档", name], (s) =>
          membership(s, (c) => c.archiveReasons.includes(reason)),
        ),
      ),
    ],
    sites: sites.map((s) => ({
      id: s.id,
      urls: s.live
        ? [
            ...new Set([
              s.live.websiteUrl,
              ...(s.live.aliases || []),
              ...s.channels.map((c) => c.baseUrl),
            ]),
          ]
        : s.frozen.urls,
    })),
  };
}
