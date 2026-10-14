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
} from "../ui";
import { ChannelDrawer, ConflictDrawer } from "../shared";
import { catLabel, type Site, type Channel } from "../data";
import RpView from "./Rp";
import ClientView from "./Client";
import { NewConnection } from "../NewConnection";

const tabs = [
  ["all", "全部"],
  ["general", "通用"],
  ["media", "生图视频"],
  ["rp", "RP"],
  ["client", "客户端绑定（Code）"],
  ["issue", "待处理"],
] as const;

export function isIssue(site: Site, chans: Channel[]) {
  return (
    !!site.issue ||
    chans.some((c) =>
      ["failed", "conflict", "diff", "pending"].includes(c.apply),
    )
  );
}

export default function Resources() {
  const { s, sub, go, query, setQuery } = useStore();
  const [newOpen, setNewOpen] = useState(false);
  const [proto, setProto] = useState("");
  const [prob, setProb] = useState("");
  const [open, setOpen] = useState<Record<string, boolean>>({ s1: true });
  const [edit, setEdit] = useState<string | null>(null);
  const [conf, setConf] = useState<string | null>(null);
  const q = query.trim().toLowerCase();
  const chansOf = (id: string) => s.channels.filter((c) => c.siteId === id);
  const sites = s.sites.filter((x) => {
    const cs = chansOf(x.id);
    if (
      sub === "issue"
        ? !isIssue(x, cs)
        : sub !== "all" && !x.categories?.includes(sub as any)
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
                  : s.sites.filter((x) => x.categories?.includes(k)).length;
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
      {sub === "rp" ? (
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
                      <div className="font-medium text-zinc-900">{x.name}</div>
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
                        <Badge tone="ok">正常</Badge>
                      )}
                      {cs
                        .filter((c) => c.apply !== "synced")
                        .map((c) => (
                          <ApplyBadge key={c.id} a={c.apply} cat={c.category} />
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
    </div>
  );
}
