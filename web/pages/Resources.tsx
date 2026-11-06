import { useState } from "react";
import { ChevronRight, Search, Pencil, GitCompare, Power } from "lucide-react";
import { useStore } from "../store";
import {
  Badge,
  Btn,
  Section,
  Url,
  chanStatus,
  PageHead,
  ApplyBadge,
  inputCls,
  Empty,
  Drawer,
  Field,
} from "../ui";
import { ChannelDrawer, ConflictDrawer, ConfigDrawer } from "../shared";
import { catLabel, type Site, type Channel } from "../data";
import RpView from "./Rp";
import ClientView from "./Client";
import { NewConnection } from "../NewConnection";
import {
  exceptionGroups,
  exceptionSites,
  resourceGroup,
} from "../resourceGroups";
import Exceptions from "./Exceptions";

const tabs = [
  ["all", "全部"],
  ["general", "通用"],
  ["media", "生图视频"],
  ["rp", "RP"],
  ["client", "客户端绑定（Code）"],
  ["issue", "待处理"],
] as const;
const imageOrder = {
  success: 0,
  pending: 1,
  failure: 2,
  unknown: 3,
  skipped: 4,
};

export function isIssue(site: Site, chans: Channel[]) {
  return (
    !!site.issue ||
    chans.some((c) =>
      ["failed", "conflict", "diff", "pending"].includes(c.apply),
    )
  );
}

export default function Resources() {
  const { s, act, sub, go, query, setQuery } = useStore();
  const [siteEdit, setSiteEdit] = useState<Site | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [proto, setProto] = useState("");
  const [prob, setProb] = useState("");
  const [open, setOpen] = useState<Record<string, boolean>>({ s1: true });
  const [edit, setEdit] = useState<string | null>(null);
  const [conf, setConf] = useState<string | null>(null);
  const q = query.trim().toLowerCase();
  const chansOf = (id: string) => s.channels.filter((c) => c.siteId === id);
  const exception = exceptionGroups.find((g) => g.id === sub);
  const imageTests = [
    ...new Map(
      s.evals
        .filter(
          (e) =>
            e.imageAudit &&
            s.channels.some(
              (c) => c.id === e.channelId && c.category === "media",
            ),
        )
        .map((e) => [e.channelId, e]),
    ).values(),
  ].sort(
    (a, b) =>
      imageOrder[a.imageAudit!.result] - imageOrder[b.imageAudit!.result],
  );
  const imageSites = new Map<
    string,
    { website: Site; tests: typeof imageTests }
  >();
  for (const e of imageTests) {
    const channel = s.channels.find((c) => c.id === e.channelId)!;
    const website = s.sites.find((site) => site.id === channel.siteId)!;
    const host = new URL(website.url).host;
    const group = imageSites.get(host) || { website, tests: [] };
    if (
      !group.tests.some(
        (test) =>
          e.imageAudit?.requestEvaluationId &&
          test.imageAudit?.requestEvaluationId ===
            e.imageAudit.requestEvaluationId,
      )
    )
      group.tests.push(e);
    imageSites.set(host, group);
  }
  const inCategory = (site: Site, category: string) =>
    chansOf(site.id).some(
      (c) => c.category === category && !resourceGroup(c, site),
    );
  const sites = s.sites.filter((x) => {
    const cs = chansOf(x.id);
    if (
      sub === "issue" ? !isIssue(x, cs) : sub !== "all" && !inCategory(x, sub)
    )
      return false;
    if (proto && !cs.some((c) => c.protocol === proto)) return false;
    if (prob === "yes" && !isIssue(x, cs)) return false;
    if (prob === "no" && isIssue(x, cs)) return false;
    if (
      q &&
      ![
        x.name,
        x.url,
        x.issue || "",
        ...cs.flatMap((c) => [c.name, ...c.models]),
      ]
        .join(" ")
        .toLowerCase()
        .includes(q)
    )
      return false;
    return true;
  });

  return (
    <div>
      <PageHead
        title="资源与连接"
        desc="每个站点一行；余额属于账号，渠道下只维护地址、协议、模型和绑定"
        extra={<Btn onClick={() => setNewOpen(true)}>添加连接</Btn>}
      />
      <div className="mb-4 -mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
        <div className="flex w-max gap-1 border-b border-zinc-200">
          {tabs.map(([k, l]) => {
            const n =
              k === "all"
                ? s.sites.length
                : k === "issue"
                  ? s.sites.filter((x) => isIssue(x, chansOf(x.id))).length
                  : s.sites.filter((x) => inCategory(x, k)).length;
            return (
              <button
                key={k}
                onClick={() => go("resources", k)}
                className={`-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm ${sub === k ? "border-blue-600 font-medium text-zinc-900" : "border-transparent text-zinc-500 hover:text-zinc-800"}`}
              >
                {l} <span className="tabular-nums text-zinc-400">{n}</span>
              </button>
            );
          })}
        </div>
      </div>
      <div className="mb-5 flex flex-wrap items-center gap-2">
        <span className="mr-1 text-xs text-zinc-500">异常清单</span>
        {exceptionGroups.map((g) => (
          <button
            key={g.id}
            onClick={() => go("resources", g.id)}
            className={`rounded-md border px-3 py-1.5 text-sm ${sub === g.id ? "border-blue-200 bg-blue-50 font-medium text-blue-700" : "border-zinc-200 bg-white text-zinc-600 hover:bg-zinc-50"}`}
          >
            {g.label}{" "}
            <span className="ml-1 tabular-nums">
              {exceptionSites(s.sites, s.channels, g.id).length}
            </span>
          </button>
        ))}
      </div>
      {sub === "media" && imageTests.length > 0 && (
        <div className="mb-5">
          <Section title="生图实测" desc="最近一次结果；点击图片查看原图">
            <div className="grid gap-4 p-4 md:grid-cols-2 xl:grid-cols-3">
              {[...imageSites.values()].map(({ website, tests }, siteIndex) => (
                <article
                  key={website.id}
                  className="min-w-0 rounded-md border border-zinc-200 p-3 text-sm"
                >
                  <Url href={website.url} />
                  {tests.map((e) => (
                    <div
                      key={e.id}
                      className="mt-2 border-t border-zinc-100 pt-2 first-of-type:border-0"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="break-words text-xs text-zinc-500">
                          {e.model}
                        </span>
                        <Badge
                          tone={
                            e.imageAudit?.result === "success"
                              ? "ok"
                              : e.imageAudit?.result === "failure"
                                ? "err"
                                : e.imageAudit?.result === "pending"
                                  ? "info"
                                  : "mute"
                          }
                          icon={null}
                        >
                          {e.imageAudit?.result === "success"
                            ? "已出图"
                            : e.imageAudit?.result === "failure"
                              ? "调用失败"
                              : e.imageAudit?.result === "pending"
                                ? "生成中"
                                : e.imageAudit?.result === "unknown"
                                  ? "结果未确认"
                                  : "未测试"}
                        </Badge>
                      </div>
                      {e.image && (
                        <a
                          href={`/api/v1/evaluations/${e.id}/image`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          <img
                            src={`/api/v1/evaluations/${e.id}/image`}
                            alt={`${website.name} 生图结果`}
                            loading={siteIndex < 3 ? "eager" : "lazy"}
                            className="mt-3 aspect-square w-full rounded object-contain bg-zinc-50"
                          />
                        </a>
                      )}
                      <p className="mt-2 break-words text-xs text-zinc-600">
                        {e.summary}
                      </p>
                    </div>
                  ))}
                </article>
              ))}
            </div>
          </Section>
        </div>
      )}
      {exception ? (
        <Exceptions group={exception.id} label={exception.label} />
      ) : sub === "rp" ? (
        <RpView />
      ) : sub === "client" ? (
        <ClientView />
      ) : (
        <>
          <div className="mb-3 grid gap-2 sm:grid-cols-[1fr_160px_160px]">
            <div className="relative">
              <Search
                size={15}
                className="absolute left-2.5 top-2 text-zinc-400"
              />
              <input
                className={inputCls + " pl-8"}
                placeholder="搜索站点、网址、渠道、模型"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <select
              className={inputCls}
              value={proto}
              onChange={(e) => setProto(e.target.value)}
            >
              <option value="">全部连接类型</option>
              {["OpenAI", "OpenAI Responses", "Anthropic", "Gemini"].map(
                (p) => (
                  <option key={p}>{p}</option>
                ),
              )}
            </select>
            <select
              className={inputCls}
              value={prob}
              onChange={(e) => setProb(e.target.value)}
            >
              <option value="">全部问题状态</option>
              <option value="yes">有问题</option>
              <option value="no">无问题</option>
            </select>
          </div>
          <Section title={`${sites.length} 个站点`}>
            <div className="hidden grid-cols-[20px_1.4fr_1.4fr_90px_1fr_1fr] gap-3 border-b border-zinc-200 bg-zinc-50 px-4 py-2 text-xs text-zinc-500 lg:grid">
              <span />
              <span>站点 / 网站</span>
              <span>签到入口</span>
              <span>用途</span>
              <span>账号余额</span>
              <span>状态</span>
            </div>
            {sites.length === 0 && (
              <Empty>没有匹配的站点，调整搜索或筛选</Empty>
            )}
            {sites.map((x) => {
              const cs = chansOf(x.id);
              const accts = s.accounts.filter((a) => a.siteId === x.id);
              const isOpen = open[x.id];
              return (
                <div
                  key={x.id}
                  className="border-b border-zinc-100 last:border-0"
                >
                  <div
                    onClick={() => setOpen({ ...open, [x.id]: !isOpen })}
                    className="grid cursor-pointer grid-cols-[20px_1fr] gap-x-3 gap-y-1 px-4 py-3 hover:bg-zinc-50 lg:grid-cols-[20px_1.4fr_1.4fr_90px_1fr_1fr] lg:items-center"
                  >
                    <ChevronRight
                      size={16}
                      className={`mt-0.5 text-zinc-400 transition lg:mt-0 ${isOpen ? "rotate-90" : ""}`}
                    />
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 font-medium text-zinc-900">
                        {x.name}
                        <button
                          aria-label={`编辑站点 ${x.name}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            setSiteEdit({ ...x });
                          }}
                        >
                          <Pencil size={12} />
                        </button>
                      </div>
                      <div className="text-xs">
                        <Url href={x.url} />
                      </div>
                    </div>
                    <div className="col-start-2 text-xs lg:col-start-auto">
                      {x.checkinUrl ? (
                        <span>
                          <span className="text-zinc-500 lg:hidden">
                            签到：
                          </span>
                          <Url href={x.checkinUrl} />
                        </span>
                      ) : (
                        <span className="text-zinc-500">同网站</span>
                      )}
                    </div>
                    <div className="col-start-2 text-xs text-zinc-600 lg:col-start-auto">
                      {x.categories?.map((c) => catLabel[c]).join("、") ||
                        "待关联"}
                    </div>
                    <div className="col-start-2 text-xs lg:col-start-auto">
                      {accts.map((a) => (
                        <div key={a.id} className="tabular-nums">
                          {a.balance == null ? (
                            <span className="text-amber-700">待确认</span>
                          ) : (
                            `${a.balance.toFixed(2)} ${a.unit}`
                          )}{" "}
                          <span className="text-zinc-500">
                            {a.quota === "daily" ? "当日" : "长期"} ·{" "}
                            {a.confirmedAt}
                          </span>
                        </div>
                      ))}
                    </div>
                    <div className="col-start-2 flex flex-wrap gap-1 lg:col-start-auto">
                      {x.issue ? (
                        <Badge tone={x.issue === "限流" ? "warn" : "err"}>
                          {x.issue}
                        </Badge>
                      ) : (
                        <Badge tone="info">未记录网站问题</Badge>
                      )}
                      {[
                        ...new Set(
                          cs
                            .filter((c) => c.apply !== "synced")
                            .map((c) => c.apply),
                        ),
                      ].map((a) => (
                        <ApplyBadge
                          key={a}
                          a={a}
                          cat={cs.find((c) => c.apply === a)!.category}
                        />
                      ))}
                    </div>
                  </div>
                  {isOpen && (
                    <div className="bg-zinc-50/70 px-4 pb-4 lg:pl-12">
                      {accts.map((a) => (
                        <div
                          key={a.id}
                          className="mt-2 rounded-md border border-zinc-200 bg-white"
                        >
                          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-zinc-100 px-3 py-2 text-xs">
                            <span className="font-medium text-zinc-900">
                              账号 {a.name}
                            </span>
                            <span>
                              余额{" "}
                              <b className="tabular-nums">
                                {a.balance == null
                                  ? "待确认"
                                  : `${a.balance.toFixed(2)} ${a.unit}`}
                              </b>
                              （{a.quota === "daily" ? "当日额度" : "长期额度"}
                              ）
                            </span>
                            <span className="text-zinc-500">
                              确认于 {a.confirmedAt}
                            </span>
                            {a.expires && (
                              <span className="text-amber-700">
                                到期 {a.expires}
                              </span>
                            )}
                          </div>
                          {cs
                            .filter((c) => c.accountId === a.id)
                            .map((c) => (
                              <ChannelRow
                                key={c.id}
                                c={c}
                                site={x}
                                onEdit={() => setEdit(c.id)}
                                onConflict={() => setConf(c.id)}
                              />
                            ))}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </Section>
        </>
      )}
      <Drawer
        open={!!siteEdit}
        onClose={() => setSiteEdit(null)}
        title="编辑站点"
        footer={
          <Btn
            kind="primary"
            onClick={() => {
              if (siteEdit)
                void act(
                  `/sites/${siteEdit.id}`,
                  {
                    name: siteEdit.name,
                    url: siteEdit.url,
                    checkinUrl: siteEdit.checkinUrl || null,
                    aliases: siteEdit.aliases || [],
                    siteDown: siteEdit.siteDown || false,
                    issue: siteEdit.issue || null,
                  },
                  "PATCH",
                ).then((r) => {
                  if (r) setSiteEdit(null);
                });
            }}
          >
            保存
          </Btn>
        }
      >
        {siteEdit && (
          <div className="grid gap-4">
            <Field label="名称">
              <input
                className={inputCls}
                value={siteEdit.name}
                onChange={(e) =>
                  setSiteEdit({ ...siteEdit, name: e.target.value })
                }
              />
            </Field>
            <Field label="网站地址">
              <input
                className={inputCls}
                value={siteEdit.url}
                onChange={(e) =>
                  setSiteEdit({ ...siteEdit, url: e.target.value })
                }
              />
            </Field>
            <Field label="签到入口">
              <input
                className={inputCls}
                value={siteEdit.checkinUrl || ""}
                onChange={(e) =>
                  setSiteEdit({ ...siteEdit, checkinUrl: e.target.value })
                }
              />
            </Field>
            <Field label="站点别名地址（每行一个）">
              <textarea
                className={inputCls}
                value={(siteEdit.aliases || []).join("\n")}
                onChange={(e) =>
                  setSiteEdit({
                    ...siteEdit,
                    aliases: e.target.value.split("\n").filter(Boolean),
                  })
                }
              />
            </Field>
            <Field label="网站问题（恢复后清空）">
              <input
                className={inputCls}
                value={siteEdit.issue || ""}
                onChange={(e) =>
                  setSiteEdit({
                    ...siteEdit,
                    issue: e.target.value,
                    siteDown: !!e.target.value,
                  })
                }
              />
            </Field>
          </div>
        )}
      </Drawer>
      <NewConnection
        open={newOpen}
        onClose={() => setNewOpen(false)}
        category={
          sub === "client" ? "client" : sub === "media" ? "media" : "general"
        }
      />
      <ChannelDrawer id={edit} onClose={() => setEdit(null)} />
      <ConflictDrawer id={conf} onClose={() => setConf(null)} />
    </div>
  );
}

function ChannelRow({
  c,
  site,
  onEdit,
  onConflict,
}: {
  c: Channel;
  site: Site;
  onEdit: () => void;
  onConflict: () => void;
}) {
  const { s, updChannel, toast, act } = useStore();
  const [configClient, setConfigClient] = useState("Magpie"),
    [configOpen, setConfigOpen] = useState(false);
  const st = chanStatus(
    c,
    site,
    s.accounts.find((a) => a.id === c.accountId),
    s.rules,
  );
  return (
    <div className="grid gap-2 border-b border-zinc-100 px-3 py-2.5 text-xs last:border-0 md:grid-cols-[1.2fr_1.6fr_1fr_auto] md:items-center">
      <div>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-sm font-medium text-zinc-900">{c.name}</span>
          <Badge tone={st.tone} icon={st.icon}>
            {st.label}
          </Badge>
        </div>
        <div className="mt-0.5 font-mono text-zinc-500">
          {c.protocol} · {c.baseUrl}
        </div>
      </div>
      <div>
        <div className="flex flex-wrap gap-1">
          {c.models.map((m) => (
            <span
              key={m}
              className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-zinc-700"
            >
              {m}
            </span>
          ))}
        </div>
        {c.category === "general" && (
          <div className="mt-1 text-blue-700">
            {c.models.filter((m) => /gpt|deepseek/i.test(m)).length > 0 &&
              "GPT / DeepSeek 建议用于 Code。"}
            {c.models.filter((m) => /claude|kimi/i.test(m)).length > 0 &&
              "Claude / Kimi 建议用于 RP；选择后迁移。"}
          </div>
        )}
        <div className="mt-1 text-zinc-500">
          凭据{" "}
          <span
            className={`font-mono ${c.keyMask === "未填写" ? "text-red-600" : ""}`}
          >
            {c.keyMask}
          </span>{" "}
          · 绑定 {c.bindings.join("、") || "无"}
        </div>
      </div>
      <div className="text-zinc-600">
        <div>
          {c.mode === "auto" ? "自动管理" : "人工管理"} · 评价{" "}
          {c.rating || "未评"} · v{c.version}
        </div>
        <div className="mt-1 flex flex-wrap gap-1">
          <ApplyBadge a={c.apply} cat={c.category} />
        </div>
        {c.applyMsg && c.apply !== "synced" && (
          <div
            className={`mt-1 ${c.apply === "failed" ? "text-red-700" : "text-amber-700"}`}
          >
            {c.applyMsg}
          </div>
        )}
      </div>
      <div className="flex flex-wrap gap-1 md:justify-end">
        {c.category !== "rp" && (
          <>
            <select
              className="h-7 max-w-32 rounded border text-xs"
              value={configClient}
              onChange={(e) => setConfigClient(e.target.value)}
            >
              {[
                "Magpie",
                "Claude Code",
                "Codex",
                "OpenCode",
                "Hermes Chat",
                "Hermes Cron",
              ].map((x) => (
                <option key={x}>{x}</option>
              ))}
            </select>
            <Btn
              size="sm"
              disabled={["general", "media"].includes(c.category) && !c.gateway}
              onClick={() => setConfigOpen(true)}
            >
              生成配置
            </Btn>
          </>
        )}

        {c.apply === "conflict" && (
          <Btn size="sm" kind="danger" onClick={onConflict}>
            <GitCompare size={13} />
            处理冲突
          </Btn>
        )}
        {c.gateway && c.category !== "rp" && (
          <Btn size="sm" onClick={() => act(`/channels/${c.id}/apply`, {})}>
            应用网关
          </Btn>
        )}
        {c.apply === "diff" && (
          <>
            <Btn size="sm" onClick={() => act(`/channels/${c.id}/adopt`, {})}>
              采用外部配置
            </Btn>
            <Btn
              size="sm"
              onClick={() => act(`/channels/${c.id}/apply`, { force: true })}
            >
              恢复中心规则
            </Btn>
          </>
        )}
        {c.availability && (
          <Btn
            size="sm"
            onClick={() => act(`/channels/${c.id}/clear-issue`, {})}
          >
            人工确认恢复
          </Btn>
        )}
        <Btn
          size="sm"
          onClick={() => {
            if (!c.enabled && c.keyMask === "未填写")
              return toast("缺 key，请先在编辑中填写凭据", "err");
            void updChannel(c.id, { enabled: !c.enabled });
          }}
        >
          <Power size={13} />
          {c.enabled ? "暂停" : "启用"}
        </Btn>
        <Btn size="sm" onClick={onEdit}>
          <Pencil size={13} />
          编辑
        </Btn>
      </div>
      {configOpen && (
        <ConfigDrawer
          id={c.id}
          client={configClient}
          title="客户端配置"
          onClose={() => setConfigOpen(false)}
        />
      )}
      {(s.identities || [])
        .filter((i) => i.channelId === c.id)
        .map((i) => (
          <div key={i.id} className="text-xs text-zinc-600">
            {i.application} ·{" "}
            {i.state === "verified"
              ? "真实任务已确认"
              : "配置已生成，待客户端确认"}{" "}
            {i.state !== "verified" && (
              <Btn
                size="sm"
                onClick={() => {
                  const summary = window.prompt("真实任务结果摘要");
                  if (summary)
                    void act(`/identities/${encodeURIComponent(i.id)}/verify`, {
                      summary,
                    });
                }}
              >
                登记实际生效
              </Btn>
            )}
          </div>
        ))}
    </div>
  );
}
