import { useStore } from "../store";
import { Empty, inputCls, Section, Url } from "../ui";
import { exceptionSites } from "../resourceGroups";

export default function Exceptions({
  group,
  label,
}: {
  group: string;
  label: string;
}) {
  const { s, query, setQuery } = useStore();
  const q = query.trim().toLowerCase();
  const rows = exceptionSites(s.sites, s.channels, group).filter((row) =>
    [
      ...row.sites.flatMap((site) => [site.name, site.url]),
      ...row.channels.flatMap((c) => [c.name, c.baseUrl, c.note, ...c.models]),
    ]
      .join(" ")
      .toLowerCase()
      .includes(q),
  );
  return (
    <>
      <input
        className={inputCls + " mb-3 max-w-lg"}
        placeholder="搜索站点、网址、备注"
        aria-label="搜索异常清单"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <Section title={`${label} · ${rows.length} 个站点`}>
        <div className="hidden gap-5 border-b bg-zinc-50 px-4 py-2 text-xs text-zinc-500 lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,2fr)]">
          <span>站点与签到</span>
          <span>API 地址</span>
          <span>问题与备注</span>
        </div>
        {rows.length === 0 && <Empty>没有匹配的站点</Empty>}
        {rows.map((row) => {
          const urls = [...new Set(row.channels.map((c) => c.baseUrl))];
          const checkins = [
            ...new Set(
              row.sites.flatMap((site) =>
                site.checkinUrl ? [site.checkinUrl] : [],
              ),
            ),
          ];
          const notes = [
            ...new Set(row.channels.map((c) => c.note).filter(Boolean)),
          ];
          const models = [...new Set(row.channels.flatMap((c) => c.models))];
          return (
            <article
              key={row.sites[0].id}
              className="grid gap-3 border-b border-zinc-100 px-4 py-4 text-sm last:border-0 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,2fr)] lg:gap-5"
            >
              <div className="min-w-0 space-y-1">
                {row.sites.map((site) => (
                  <div key={site.id}>
                    <Url href={site.url} />
                  </div>
                ))}
                {checkins.map((url) => (
                  <div key={url} className="text-xs">
                    <span className="text-zinc-500">签到：</span>
                    <Url href={url} />
                  </div>
                ))}
              </div>
              <div className="min-w-0 space-y-1">
                {urls.map((url) => (
                  <div key={url}>
                    <Url href={url} />
                  </div>
                ))}
                {models.length > 0 && (
                  <details className="pt-1 text-xs text-zinc-500">
                    <summary className="cursor-pointer">模型</summary>
                    <div className="mt-1 break-words">{models.join("、")}</div>
                  </details>
                )}
              </div>
              <div className="min-w-0 space-y-2 whitespace-pre-line break-words text-zinc-700">
                {notes.length ? (
                  notes.map((note) => <p key={note}>{note}</p>)
                ) : (
                  <p>{label}</p>
                )}
              </div>
            </article>
          );
        })}
      </Section>
    </>
  );
}
