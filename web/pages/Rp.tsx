import { useState } from "react";
import {
  GripVertical,
  ArrowUp,
  ArrowDown,
  Pause,
  Play,
  Pencil,
  Plus,
  GitCompare,
  PlugZap,
} from "lucide-react";
import { useStore } from "../store";
import { Badge, Btn, Section, ApplyBadge, inputCls, Url } from "../ui";
import { ChannelDrawer, ConflictDrawer } from "../shared";
import type { Channel } from "../data";
import { NewConnection } from "../NewConnection";
function RpNote({
  channel,
  save,
}: {
  channel: Channel;
  save: (note: string, version: number) => Promise<unknown>;
}) {
  const [note, setNote] = useState(channel.note),
    [version, setVersion] = useState(channel.version);
  return (
    <input
      className={inputCls + " mt-2 h-7 text-xs"}
      placeholder="备注"
      value={note}
      onFocus={() => {
        setNote(channel.note);
        setVersion(channel.version);
      }}
      onChange={(e) => setNote(e.target.value)}
      onBlur={() => {
        if (note !== channel.note) void save(note, version);
      }}
    />
  );
}

export default function RpView() {
  const { s, act, toast } = useStore();
  const [edit, setEdit] = useState<string | null>(null),
    [conf, setConf] = useState<string | null>(null),
    [drag, setDrag] = useState<string | null>(null);
  const list = s.channels
    .filter((c) => c.category === "rp")
    .sort((a, b) => a.order - b.order);
  const lastSave = s.received.sillyTavern || "尚未收到酒馆保存回执";
  const reorder = (ids: string[]) => void act("/channels/reorder", { ids });
  const move = (id: string, d: number) => {
    const ids = list.map((c) => c.id),
      i = ids.indexOf(id),
      j = i + d;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    reorder(ids);
  };
  const add = () => setEdit("new");
  const pending = list.filter(
    (c) => c.apply === "pending" || c.apply === "failed",
  );
  const current = list.find((c) => c.tavern?.current);
  const updChannel = (id: string, p: Partial<Channel>) =>
    void act(
      `/channels/${id}`,
      { expectedVersion: list.find((c) => c.id === id)!.version, patch: p },
      "PATCH",
    );
  const tavern = s.integrations.find((i) => i.kind === "sillytavern");
  const applyAll = () =>
    tavern
      ? window.open(tavern.url, "_blank", "noopener")
      : toast("请先在设置中配置酒馆入口", "err");

  return (
    <div className="grid gap-5 xl:grid-cols-[1fr_360px]">
      <Section
        title="RP 连接"
        desc={
          <span className="flex flex-wrap items-center gap-2">
            <Badge tone="info" icon={PlugZap}>
              酒馆直连 · 禁测活
            </Badge>
            独占资源；导入/保存不触发请求；角色卡与提示词不在此管理
          </span>
        }
        extra={
          <Btn size="sm" kind="primary" onClick={add}>
            <Plus size={13} />
            添加连接
          </Btn>
        }
      >
        <ul>
          {list.map((c, i) => (
            <li
              key={c.id}
              draggable
              onDragStart={() => setDrag(c.id)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => {
                if (!drag || drag === c.id) return;
                const ids = list.map((x) => x.id).filter((x) => x !== drag);
                ids.splice(ids.indexOf(c.id), 0, drag);
                reorder(ids);
                setDrag(null);
              }}
              className={`grid grid-cols-[24px_1fr] gap-3 border-b border-zinc-100 px-4 py-3 last:border-0 sm:grid-cols-[24px_28px_1fr_auto] ${drag === c.id ? "opacity-50" : ""} ${!c.enabled ? "bg-zinc-50" : ""}`}
            >
              <GripVertical
                size={16}
                className="mt-1 cursor-grab text-zinc-400"
              />
              <span className="hidden pt-0.5 text-sm tabular-nums text-zinc-400 sm:block">
                #{i + 1}
              </span>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span
                    className={`font-medium ${c.enabled ? "text-zinc-900" : "text-zinc-500 line-through"}`}
                  >
                    {c.name}
                  </span>
                  <ApplyBadge a={c.apply} cat="rp" />
                  {!c.enabled && <Badge>已暂停</Badge>}
                  <Badge
                    tone={
                      c.rating === "优"
                        ? "ok"
                        : c.rating === "差"
                          ? "err"
                          : "mute"
                    }
                    icon={null}
                  >
                    人工评价 {c.rating || "未评"}
                  </Badge>
                </div>
                <div className="mt-0.5 text-xs text-zinc-500">
                  <Url href={s.sites.find((x) => x.id === c.siteId)!.url} /> ·{" "}
                  <span className="font-mono">{c.models.join(", ")}</span> · v
                  {c.version}
                </div>
                <RpNote
                  channel={c}
                  save={(note, version) =>
                    act(
                      `/channels/${c.id}`,
                      { expectedVersion: version, patch: { note } },
                      "PATCH",
                    )
                  }
                />
                {c.applyMsg && c.apply !== "synced" && (
                  <div className="mt-1 text-xs text-amber-700">
                    {c.applyMsg}
                  </div>
                )}
              </div>
              <div className="col-start-2 flex flex-wrap items-start gap-1 sm:col-start-auto sm:justify-end">
                <select
                  aria-label="人工评价"
                  className="h-7 rounded-md border border-zinc-300 bg-white px-1 text-xs"
                  value={c.rating}
                  onChange={(e) => {
                    updChannel(c.id, {
                      rating: e.target.value as Channel["rating"],
                    });
                  }}
                >
                  <option value="">未评</option>
                  <option>优</option>
                  <option>良</option>
                  <option>差</option>
                </select>
                <Btn
                  size="sm"
                  kind="ghost"
                  onClick={() => move(c.id, -1)}
                  disabled={i === 0}
                >
                  <ArrowUp size={13} />
                </Btn>
                <Btn
                  size="sm"
                  kind="ghost"
                  onClick={() => move(c.id, 1)}
                  disabled={i === list.length - 1}
                >
                  <ArrowDown size={13} />
                </Btn>
                <Btn
                  size="sm"
                  onClick={() => {
                    updChannel(c.id, { enabled: !c.enabled });
                  }}
                >
                  {c.enabled ? (
                    <>
                      <Pause size={13} />
                      暂停
                    </>
                  ) : (
                    <>
                      <Play size={13} />
                      恢复
                    </>
                  )}
                </Btn>
                <Btn size="sm" onClick={() => setEdit(c.id)}>
                  <Pencil size={13} />
                  编辑
                </Btn>
                {c.apply === "conflict" && (
                  <Btn size="sm" kind="danger" onClick={() => setConf(c.id)}>
                    <GitCompare size={13} />
                    冲突
                  </Btn>
                )}
              </div>
            </li>
          ))}
        </ul>
      </Section>

      <div className="rounded-lg border border-zinc-300 bg-[#1f2126] text-zinc-200">
        <div className="flex items-center justify-between border-b border-zinc-700 px-4 py-2.5 text-xs">
          <span className="font-medium">酒馆同步 · API 连接</span>
          <span className="text-zinc-400">
            {s.received.sillyTavern ? "已有回执" : "待接入"}
          </span>
        </div>
        <div className="space-y-3 p-4 text-xs">
          <div>
            <div className="text-zinc-400">当前连接</div>
            <div className="mt-1 rounded bg-zinc-800 px-2 py-1.5 font-mono">
              {current
                ? `${current.name} · ${current.models[0]}`
                : "尚未确认当前连接"}
            </div>
          </div>
          <div>
            <div className="text-zinc-400">上次保存</div>
            <div className="mt-1">{lastSave}</div>
          </div>
          <div>
            <div className="text-zinc-400">
              中心变更差异（{pending.length}）
            </div>
            <ul className="mt-1 space-y-1">
              {pending.length === 0 && (
                <li className="text-zinc-500">与中心一致</li>
              )}
              {pending.map((c) => (
                <li key={c.id} className="rounded bg-zinc-800 px-2 py-1.5">
                  <span className="text-amber-300">~</span> {c.name}：
                  {c.applyMsg || `v${c.version - 1} → v${c.version}`}
                </li>
              ))}
              {list
                .filter((c) => c.apply === "conflict")
                .map((c) => (
                  <li
                    key={c.id}
                    className="rounded bg-red-950 px-2 py-1.5 text-red-200"
                  >
                    ! {c.name}：409 版本冲突，需先处理
                  </li>
                ))}
            </ul>
          </div>
          <button
            disabled={!pending.length}
            onClick={applyAll}
            className="h-8 w-full rounded-md bg-blue-600 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-40"
          >
            打开酒馆应用修改
          </button>
          <p className="text-zinc-500">
            应用只写入酒馆连接配置，不发出测试请求。
          </p>
        </div>
      </div>
      <NewConnection
        open={edit === "new"}
        category="rp"
        onClose={() => setEdit(null)}
      />
      <ChannelDrawer
        id={edit === "new" ? null : edit}
        onClose={() => setEdit(null)}
      />
      <ConflictDrawer id={conf} onClose={() => setConf(null)} />
    </div>
  );
}
