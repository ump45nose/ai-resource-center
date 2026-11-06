import { useState } from "react";
import {
  ArrowRight,
  ArrowUpRight,
  Archive,
  ChevronDown,
  ChevronRight,
  Globe2,
  Download,
  Copy,
} from "lucide-react";
import {
  Badge,
  Button,
  EmptyState,
  FilterSearch,
  SectionHeading,
  Segmented,
} from "../components";
import {
  amount,
  balances,
  channelStatus,
  hubCheckinStatus,
  hubCheckinUrl,
  siteCheckinAccounts,
  searchSites,
  tagLabels,
  usageLabels,
  archiveLabels,
  type ChannelUsage,
  type ArchiveReason,
  type Account,
  type Site,
} from "../data";
import { useWorkspace } from "../workspace";
import { api, copyText, errorText } from "../api";

function KeyCell({ site, onEdit }: { site: Site; onEdit: () => void }) {
  const { notify } = useWorkspace();
  const [copying, setCopying] = useState<string | null>(null);
  async function copy(id: string) {
    setCopying(id);
    try {
      const { key } = await api<{ key: string }>(
        `/channels/${id}/credential/copy`,
        "POST",
        {},
      );
      await copyText(key);
      notify("调用 key 已复制");
    } catch (error) {
      notify(errorText(error, "复制未完成"));
    } finally {
      setCopying(null);
    }
  }
  return (
    <div className="site-cell key-cell" aria-label={`${site.name} 调用 key`}>
      {site.channels.length ? (
        site.channels.map((channel) => (
          <div className="channel-key" key={channel.id}>
            {site.channels.length > 1 && (
              <span title={channel.name}>{channel.name}</span>
            )}
            {channel.credentialStatus === "present" ? (
              <button
                className="copy-key"
                onClick={() => copy(channel.id)}
                disabled={copying !== null}
                aria-label={`复制 key：${channel.name}`}
                aria-busy={copying === channel.id}
                title={`复制 ${channel.name} 当前选用的调用 key`}
              >
                <Copy size={13} />
                {copying === channel.id ? "复制中…" : "复制 key"}
              </button>
            ) : (
              <button
                className="hub-entry-button"
                aria-label={`补 key：${channel.name}`}
                onClick={onEdit}
              >
                补 key
              </button>
            )}
          </div>
        ))
      ) : (
        <button
          className="hub-entry-button"
          aria-label={`配置渠道：${site.name}`}
          onClick={onEdit}
        >
          配置渠道
        </button>
      )}
    </div>
  );
}

function HubCheckinCell({
  accounts,
  site,
  onEdit,
}: {
  accounts: Account[];
  site: Site;
  onEdit: () => void;
}) {
  const automatic = site.accounts.find(
    (a) => a.benefit?.renewal === "automatic" && a.checkinEnabled === false,
  );
  if (!accounts.length && automatic)
    return (
      <div className="site-cell hub-cell">
        <Badge>无需签到</Badge>
        <small>
          每日自动刷新 {automatic.benefit?.dailyLimit ?? "待确认"}{" "}
          {automatic.unit || ""}
        </small>
      </div>
    );
  if (!accounts.length)
    return (
      <div className="site-cell hub-cell">
        {site.checkinUrl ? (
          <a
            className="checkin-link"
            href={site.checkinUrl}
            target="_blank"
            rel="noreferrer"
            aria-label={`${site.name}：未收录，进入签到页`}
          >
            <Badge>未收录</Badge>
            <ArrowUpRight size={12} />
          </a>
        ) : (
          <Badge>未收录</Badge>
        )}
      </div>
    );
  return (
    <div className="site-cell hub-cell">
      {accounts.map((account) => {
        const status = hubCheckinStatus(account);
        const url = hubCheckinUrl(site, account);
        const badge = <Badge tone={status.tone}>{status.label}</Badge>;
        return (
          <div
            className="hub-account-status"
            key={account.id}
            title={[account.name, status.detail, status.reason]
              .filter(Boolean)
              .join(" · ")}
          >
            {accounts.length > 1 && (
              <span className="hub-account-name">{account.name}</span>
            )}
            {url ? (
              <a
                className="checkin-link"
                href={url}
                target="_blank"
                rel="noreferrer"
                aria-label={`${account.name}：${status.label}，进入签到页`}
              >
                {badge}
                <ArrowUpRight size={12} />
              </a>
            ) : (
              badge
            )}
            <span className="hub-status-detail">{status.detail}</span>
            {url &&
              new URL(url).hostname !== new URL(site.websiteUrl).hostname && (
                <a
                  className="hub-site-link"
                  href={url}
                  target="_blank"
                  rel="noreferrer"
                  title={url}
                >
                  {new URL(url).hostname}
                </a>
              )}
            {!status.checkedIn && !url && (
              <button
                className="hub-entry-button"
                aria-label={`设置签到入口：${account.name}`}
                onClick={onEdit}
              >
                设置签到入口
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

export default function Sites() {
  const { sites, query, navigate, inspectSite, notify } = useWorkspace();
  const [usage, setUsage] = useState<ChannelUsage>("general");
  const [archived, setArchived] = useState(false);
  const [reason, setReason] = useState<ArchiveReason | "">("");
  const [localQuery, setLocalQuery] = useState("");
  const [expanded, setExpanded] = useState<string[]>([]);
  const [page, setPage] = useState(0);
  const archiveCount = sites.filter((s) =>
    s.channels.some((c) => c.archiveReasons.length),
  ).length;
  const rows = searchSites(
    searchSites(
      sites
        .map((s) => {
          const channels = s.channels.filter((c) =>
            archived
              ? reason
                ? c.archiveReasons.includes(reason)
                : c.archiveReasons.length > 0
              : c.usage === usage && !c.archiveReasons.length,
          );
          return {
            ...s,
            hubAccounts: siteCheckinAccounts({ ...s, channels }),
            channels,
            accountOnly: !s.channels.length,
            accounts: !s.channels.length
              ? s.accounts
              : s.accounts.filter((a) =>
                  channels.some((c) => c.accountId === a.id),
                ),
          };
        })
        .filter(
          (s) =>
            s.channels.length ||
            (!archived &&
              usage === "general" &&
              s.accountOnly &&
              s.accounts.length),
        ),
      query,
    ),
    localQuery,
  );
  const shown = rows.slice(page * 30, (page + 1) * 30);
  const goArchive = () => {
    setArchived(true);
    setReason("");
    setPage(0);
  };
  async function exportBookmarks() {
    try {
      const plan = await api<{
        folders: { path: string[]; items: { title: string; url: string }[] }[];
      }>("/bookmarks");
      const escape = (s: string) =>
        s.replace(
          /[&<>"']/g,
          (c) =>
            ({
              "&": "&amp;",
              "<": "&lt;",
              ">": "&gt;",
              '"': "&quot;",
              "'": "&#39;",
            })[c]!,
        );
      const links = (items: { title: string; url: string }[]) =>
        items
          .map((b) => `<DT><A HREF="${escape(b.url)}">${escape(b.title)}</A>`)
          .join("\n");
      const folder = (name: string, content: string) =>
        `<DT><H3>${escape(name)}</H3>\n<DL><p>\n${content}\n</DL><p>`;
      const html =
        '<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">\n<TITLE>公益站</TITLE>\n<DL><p>\n' +
        folder(
          "公益站",
          plan.folders
            .filter((f) => f.path.length === 1)
            .map((f) => folder(f.path[0], links(f.items)))
            .join("\n") +
            folder(
              "归档",
              plan.folders
                .filter((f) => f.path.length === 2)
                .map((f) => folder(f.path[1], links(f.items)))
                .join("\n"),
            ),
        ) +
        "\n</DL><p>";
      const url = URL.createObjectURL(
        new Blob([html], { type: "text/html;charset=utf-8" }),
      );
      const a = document.createElement("a");
      a.href = url;
      a.download = "公益站.html";
      a.click();
      URL.revokeObjectURL(url);
      notify("书签已导出，分类与当前资源一致");
    } catch (e) {
      notify(errorText(e, "导出失败"));
    }
  }
  const gatewayCount = sites
    .flatMap((s) => s.channels)
    .filter((c) => c.runtimeEnabled === true).length;
  return (
    <>
      <div className="summary-grid">
        <div className="summary-item">
          <span>
            我的站点
            <Globe2 size={16} />
          </span>
          <strong>
            {sites.length}
            <small> 个站点</small>
          </strong>
        </div>
        <button
          className="summary-item"
          aria-label={`网关已启用 ${gatewayCount} 条连接，查看接入与同步`}
          onClick={() => navigate("sources")}
        >
          <span>
            网关已启用
            <ArrowUpRight size={16} />
          </span>
          <strong>
            {gatewayCount}
            <small> 条连接</small>
          </strong>
        </button>
        <button
          className={`summary-item ${archived ? "selected" : ""}`}
          aria-label={`归档 ${archiveCount} 个站点，查看归档站点`}
          onClick={goArchive}
        >
          <span>
            归档
            <Archive size={16} />
          </span>
          <strong>
            {archiveCount}
            <small> 个站点</small>
          </strong>
        </button>
      </div>
      <section>
        <SectionHeading
          title={archived ? "归档站点" : "我的站点"}
          meta={`${rows.length} 个站点 · ${rows.reduce((n, s) => n + s.channels.length, 0)} 条渠道`}
          action={
            <div className="inline-tags">
              <Button variant="ghost" onClick={exportBookmarks}>
                <Download size={14} />
                导出书签
              </Button>
              <Button variant="ghost" onClick={() => navigate("sources")}>
                同步来源
                <ArrowRight size={14} />
              </Button>
            </div>
          }
        />
        <div className="filter-bar">
          <div className="resource-views">
            <Segmented
              label="渠道用途"
              value={archived ? "" : usage}
              onChange={(v) => {
                setUsage(v as ChannelUsage);
                setArchived(false);
                setPage(0);
              }}
              options={Object.entries(usageLabels).map(([value, label]) => ({
                value,
                label,
              }))}
            />
            <button
              className={`archive-view ${archived ? "active" : ""}`}
              aria-pressed={archived}
              onClick={goArchive}
            >
              <Archive size={14} />
              归档<span>{archiveCount}</span>
            </button>
          </div>
          <FilterSearch
            value={localQuery}
            onChange={(v) => {
              setLocalQuery(v);
              setPage(0);
            }}
            placeholder="筛选站点、网址或模型"
          />
        </div>
        {archived && (
          <div className="archive-filters" aria-label="归档问题类型">
            <button
              className={!reason ? "active" : ""}
              onClick={() => {
                setReason("");
                setPage(0);
              }}
            >
              全部归档
            </button>
            {Object.entries(archiveLabels).map(([value, label]) => (
              <button
                key={value}
                className={reason === value ? "active" : ""}
                onClick={() => {
                  setReason(value as ArchiveReason);
                  setPage(0);
                }}
              >
                {label}
                <strong>
                  {
                    sites.filter((s) =>
                      s.channels.some((c) =>
                        c.archiveReasons.includes(value as ArchiveReason),
                      ),
                    ).length
                  }
                </strong>
              </button>
            ))}
          </div>
        )}
        <div className="site-list">
          <div className="site-list-labels">
            <span>站点 / 来源</span>
            <span>模型 / 渠道</span>
            <span>账号余额</span>
            <span>Key</span>
            <span>All API Hub / 签到</span>
            <span>状态 / 限制</span>
            <span />
          </div>
          {shown.map((site) => {
            const models = [...new Set(site.channels.flatMap((c) => c.models))];
            const tags = [...new Set(site.channels.flatMap((c) => c.tags))];
            const reasons = [
              ...new Set(site.channels.flatMap((c) => c.archiveReasons)),
            ];
            const statuses = [
              ...new Map(
                site.channels.map((c) => {
                  const status = channelStatus(c);
                  return [status.label, status];
                }),
              ).values(),
            ];
            return (
              <article className="site-row" key={site.id}>
                <div className="site-row-main">
                  <div className="site-cell identity-cell">
                    <button
                      className="expand-button"
                      aria-label={`展开 ${site.name} 渠道`}
                      aria-expanded={expanded.includes(site.id)}
                      onClick={() =>
                        setExpanded(
                          expanded.includes(site.id)
                            ? expanded.filter((id) => id !== site.id)
                            : [...expanded, site.id],
                        )
                      }
                    >
                      {expanded.includes(site.id) ? (
                        <ChevronDown size={16} />
                      ) : (
                        <ChevronRight size={16} />
                      )}
                    </button>
                    <div>
                      <button
                        className="site-title"
                        onClick={() => inspectSite(site.id)}
                      >
                        {site.name}
                      </button>
                      <a
                        className="site-link"
                        href={site.websiteUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {site.websiteUrl.replace(/^https?:\/\//, "")}
                        <ArrowUpRight size={11} />
                      </a>
                      <div className="source-tags">
                        {site.sources
                          .filter(
                            (s) =>
                              !/\.xlsx?$|\.csv$|legacy|spreadsheet/i.test(s),
                          )
                          .map((s) => (
                            <span key={s}>{s}</span>
                          ))}
                      </div>
                    </div>
                  </div>
                  <div className="site-cell models-cell">
                    <strong>
                      {!site.channels.length
                        ? "尚未配置渠道"
                        : models.length
                          ? `${models.length} 个选定模型`
                          : "未取得模型"}
                    </strong>
                    <code>
                      {site.channels.length
                        ? models[0] || "尚未选定模型"
                        : "账号与签到资料已同步"}
                    </code>
                    <span>{site.channels.length} 条渠道</span>
                  </div>
                  <div className="site-cell balance-cell">
                    {balances(site.accounts).length ? (
                      balances(site.accounts).map((v) => (
                        <strong className="balance" key={v}>
                          {v}
                        </strong>
                      ))
                    ) : (
                      <span className="muted">未取得余额</span>
                    )}
                    {site.accounts.some(a => a.entitlement.balanceBasis === "fixed_daily") &&
                      <span className="muted">每日固定额度</span>}
                    {site.accounts.some(
                      (a) =>
                        a.balance != null &&
                        a.entitlement.balanceCurrent === false,
                    ) && <span className="muted">余额待刷新</span>}
                    <span className="muted">
                      {site.accounts.length} 个独立账号
                    </span>
                  </div>
                  <KeyCell site={site} onEdit={() => inspectSite(site.id)} />
                  <HubCheckinCell
                    accounts={site.hubAccounts}
                    site={site}
                    onEdit={() => inspectSite(site.id)}
                  />
                  <div className="site-cell state-cell">
                    {archived ? (
                      reasons.map((r) => (
                        <Badge key={r} tone="amber">
                          {archiveLabels[r]}
                        </Badge>
                      ))
                    ) : !site.channels.length ? (
                      <Badge tone="neutral">仅账号资料</Badge>
                    ) : (
                      statuses.map((status) => (
                        <Badge key={status.label} tone={status.tone}>
                          {status.label}
                        </Badge>
                      ))
                    )}
                    <div className="restriction-tags">
                      {tags.map((t) => (
                        <Badge
                          key={t}
                          tone={t === "no_probe" ? "clay" : "neutral"}
                        >
                          {tagLabels[t]}
                        </Badge>
                      ))}
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    className="row-detail"
                    aria-label={`编辑 ${site.name}`}
                    onClick={() => inspectSite(site.id)}
                  >
                    编辑
                  </Button>
                </div>
                {expanded.includes(site.id) && (
                  <div className="account-expansion">
                    {site.channels.map((c) => (
                      <div className="channel-inline" key={c.id}>
                        <button
                          className="table-title"
                          onClick={() => inspectSite(site.id)}
                        >
                          {c.name}
                        </button>
                        <span>{usageLabels[c.usage]} · New API</span>
                        <div className="inline-tags">
                          {c.runtimeIssue && (
                            <Badge tone="amber">{c.runtimeIssue.reason}</Badge>
                          )}
                          {c.tags.map((t) => (
                            <Badge key={t}>{tagLabels[t]}</Badge>
                          ))}
                        </div>
                        <Badge tone={channelStatus(c).tone}>
                          {channelStatus(c).label}
                        </Badge>
                      </div>
                    ))}
                    {site.accounts.map((a) => (
                      <div className="account-row" key={a.id}>
                        <strong>{a.name}</strong>
                        <span>{amount(a.balance, a.unit)}</span>
                        <span>
                          {a.checkins[0]
                            ? `${a.checkins[0].businessDate} · ${a.checkins[0].result}`
                            : "暂无签到记录"}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </article>
            );
          })}
          {!rows.length && (
            <EmptyState
              icon={archived ? Archive : Globe2}
              title={
                archived
                  ? "没有匹配的归档站点"
                  : `暂无${usageLabels[usage]}渠道`
              }
              description="可在渠道详情中修改用途分组。"
            />
          )}
        </div>
        {rows.length > 30 && (
          <div className="selection-bar">
            <span>
              第 {Math.min(page + 1, Math.ceil(rows.length / 30))} /{" "}
              {Math.ceil(rows.length / 30)} 页
            </span>
            <div className="inline-tags">
              <Button disabled={!page} onClick={() => setPage(page - 1)}>
                上一页
              </Button>
              <Button
                disabled={(page + 1) * 30 >= rows.length}
                onClick={() => setPage(page + 1)}
              >
                下一页
              </Button>
            </div>
          </div>
        )}
      </section>
    </>
  );
}
