import { usageLabels, archiveLabels } from "./channel-rules.mjs";

export function bookmarkPlan(resources) {
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
