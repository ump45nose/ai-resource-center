import { usageLabels, tagLabels, archiveLabels } from "./channel-rules.mjs";
import { Problem } from "./errors.mjs";
const text = (value) => ({
  rich_text: value ? [{ text: { content: String(value).slice(0, 1900) } }] : [],
});
const schema = {
  中心标识: { rich_text: {} },
  网站: { url: {} },
  签到入口: { url: {} },
  用途: { rich_text: {} },
  限制: { rich_text: {} },
  归档原因: { rich_text: {} },
  已生效模型: { rich_text: {} },
  余额与签到: { rich_text: {} },
};
export class NotionMirror {
  constructor(store, fetcher) {
    Object.assign(this, { store, fetch: fetcher });
  }
  async request(t, path, method = "GET", body) {
    if (!t.credentialId) throw new Problem(409, "请先保存 Notion 集成凭据");
    const response = await this.fetch(`https://api.notion.com/v1${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.store.reveal(t.credentialId)}`,
        "Notion-Version": "2025-09-03",
        "Content-Type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(20000),
      redirect: "error",
    });
    if (!response.ok) throw new Problem(502, `Notion HTTP ${response.status}`);
    return response.json();
  }
  async inspect(t) {
    let dataSourceId = t.dataSourceId;
    if (!dataSourceId) {
      if (!t.databaseId)
        throw new Problem(409, "请选择原有 API 清单的数据库或数据源标识");
      const db = await this.request(t, `/databases/${t.databaseId}`);
      if (db.data_sources?.length !== 1)
        throw new Problem(
          409,
          "数据库包含多个数据源，请指定需要同步的数据源标识",
        );
      dataSourceId = db.data_sources[0].id;
    }
    const ds = await this.request(t, `/data_sources/${dataSourceId}`);
    const titleProperty = Object.keys(ds.properties).find(
      (k) => ds.properties[k].type === "title",
    );
    if (!titleProperty) throw new Problem(409, "Notion 清单缺少标题字段");
    for (const [name, definition] of Object.entries(schema))
      if (
        ds.properties[name] &&
        ds.properties[name].type !== Object.keys(definition)[0]
      )
        throw new Problem(409, `Notion 字段类型不匹配：${name}`);
    return { dataSourceId, titleProperty };
  }
  project(site) {
    const cs = site.channels;
    return {
      siteId: site.id,
      title: site.name,
      url: site.websiteUrl,
      aliases: site.aliases || [],
      checkinUrl: site.checkinUrl || null,
      usages: [...new Set(cs.map((c) => usageLabels[c.usage]))].join("、"),
      tags: [
        ...new Set(cs.flatMap((c) => c.tags.map((t) => tagLabels[t]))),
      ].join("、"),
      archives: [
        ...new Set(
          cs.flatMap((c) => c.archiveReasons.map((r) => archiveLabels[r])),
        ),
      ].join("、"),
      models: [
        ...new Set(
          cs
            .filter(
              (c) =>
                c.enabled &&
                !c.archiveReasons.length &&
                !c.recovery?.pending &&
                !["paused", "closed", "maintenance"].includes(
                  c.management?.state,
                ) &&
                c.runtimeEnabled !== false,
            )
            .flatMap((c) => c.models),
        ),
      ].join("、"),
      summary: site.accounts
        .map(
          (a) =>
            `${a.name}：${a.balance == null ? "余额未知" : a.balance + " " + a.unit}；${a.checkins?.[0]?.result || "尚无签到记录"}`,
        )
        .join("\n"),
    };
  }
  async pages(t) {
    const pages = [];
    let cursor;
    do {
      const page = await this.request(
        t,
        `/data_sources/${t.dataSourceId}/query`,
        "POST",
        { page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) },
      );
      pages.push(...page.results);
      cursor = page.has_more ? page.next_cursor : null;
    } while (cursor);
    return pages;
  }
  match(pages, p) {
    const origin = (url) => {
      try {
        return new URL(url).origin;
      } catch {
        return null;
      }
    };
    const matches = pages.filter((page) =>
      Object.entries(page.properties || {}).some(
        ([name, prop]) =>
          prop.type === "url" &&
          !/签到|check.?in/i.test(name) &&
          prop.url &&
          [p.url, ...(p.aliases || [])].some(
            (url) => origin(prop.url) === origin(url),
          ),
      ),
    );
    if (matches.length > 1)
      throw new Problem(
        409,
        `Notion 中 ${p.title} 对应多个网址条目，请先确认保留哪条`,
      );
    return matches[0] || null;
  }
  async apply(config, j) {
    const t = { ...config, ...(await this.inspect(config)) },
      ds = await this.request(t, `/data_sources/${t.dataSourceId}`);
    const missing = Object.fromEntries(
      Object.entries(schema).filter(([k]) => !ds.properties[k]),
    );
    if (Object.keys(missing).length)
      await this.request(t, `/data_sources/${t.dataSourceId}`, "PATCH", {
        properties: missing,
      });
    const link = this.store.get("targetLink", `notion:${j.subject}`),
      p = j.payload;
    let remoteId = link?.remoteId;
    if (!remoteId) {
      const result = await this.request(
        t,
        `/data_sources/${t.dataSourceId}/query`,
        "POST",
        { filter: { property: "中心标识", rich_text: { equals: j.subject } } },
      );
      if (result.results.length > 1)
        throw new Problem(409, "Notion 中同一中心标识存在多行，请先确认");
      remoteId = result.results[0]?.id;
    }
    const properties = {
      [t.titleProperty]: {
        title: [{ text: { content: p.title.slice(0, 1900) } }],
      },
      中心标识: text(j.subject),
      网站: { url: p.url },
      签到入口: { url: p.checkinUrl },
      用途: text(p.usages),
      限制: text(p.tags),
      归档原因: text(p.archives),
      已生效模型: text(p.models),
      余额与签到: text(p.summary),
    };
    const page = remoteId
      ? await this.request(t, `/pages/${remoteId}`, "PATCH", { properties })
      : await this.request(t, "/pages", "POST", {
          parent: { type: "data_source_id", data_source_id: t.dataSourceId },
          properties,
        });
    const read = await this.request(t, `/pages/${page.id}`);
    if (
      read.properties["中心标识"]?.rich_text
        ?.map((r) => r.plain_text || r.text?.content || "")
        .join("") !== j.subject
    )
      throw new Problem(502, "Notion 回读未确认");
    return { remoteId: page.id, snapshot: p };
  }
}
