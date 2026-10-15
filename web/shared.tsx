import { useEffect, useState } from "react";
import { Plus, Trash2, Copy, Braces, Table2 } from "lucide-react";
import { useStore } from "./store";
import { Drawer, Btn, Field, inputCls, ApplyBadge, Badge } from "./ui";
import type { Channel, Header } from "./data";

export function HeaderEditor({
  headers,
  onChange,
}: {
  headers: Header[];
  onChange: (h: Header[]) => void;
}) {
  const [json, setJson] = useState(false);
  const obj = Object.fromEntries(
    headers.filter((h) => h.name).map((h) => [h.name, h.value]),
  );
  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-medium text-zinc-600">
          请求头（不含认证）
        </span>
        <div className="flex gap-1">
          <Btn
            size="sm"
            kind={json ? "ghost" : "default"}
            onClick={() => setJson(false)}
          >
            <Table2 size={13} />
            表格
          </Btn>
          <Btn
            size="sm"
            kind={json ? "default" : "ghost"}
            onClick={() => setJson(true)}
          >
            <Braces size={13} />
            JSON
          </Btn>
        </div>
      </div>
      {json ? (
        <pre className="overflow-x-auto rounded-md bg-zinc-50 p-3 font-mono text-xs text-zinc-800 ring-1 ring-zinc-200">
          {JSON.stringify(obj, null, 2)}
        </pre>
      ) : (
        <div className="rounded-md ring-1 ring-zinc-200">
          <div className="grid grid-cols-[1fr_1fr_32px] gap-2 border-b border-zinc-200 bg-zinc-50 px-2 py-1.5 text-xs text-zinc-500">
            <span>名称</span>
            <span>值</span>
            <span />
          </div>
          {headers.map((h, i) => (
            <div
              key={i}
              className="grid grid-cols-[1fr_1fr_32px] items-center gap-2 border-b border-zinc-100 px-2 py-1.5 last:border-0"
            >
              <input
                className={inputCls + " font-mono text-xs"}
                value={h.name}
                placeholder="Header-Name"
                onChange={(e) =>
                  onChange(
                    headers.map((x, j) =>
                      j === i ? { ...x, name: e.target.value } : x,
                    ),
                  )
                }
              />
              <input
                className={inputCls + " font-mono text-xs"}
                value={h.value}
                placeholder="value"
                onChange={(e) =>
                  onChange(
                    headers.map((x, j) =>
                      j === i ? { ...x, value: e.target.value } : x,
                    ),
                  )
                }
              />
              <button
                aria-label="删除行"
                className="rounded p-1 text-zinc-500 hover:bg-red-50 hover:text-red-600"
                onClick={() => onChange(headers.filter((_, j) => j !== i))}
              >
                <Trash2 size={14} strokeWidth={1.75} />
              </button>
            </div>
          ))}
          <div className="px-2 py-1.5">
            <Btn
              size="sm"
              kind="ghost"
              onClick={() => onChange([...headers, { name: "", value: "" }])}
            >
              <Plus size={13} />
              添加行
            </Btn>
          </div>
        </div>
      )}
    </div>
  );
}

export function ChannelDrawer({
  id,
  onClose,
}: {
  id: string | null;
  onClose: () => void;
}) {
  const { s, saveChannel, act } = useStore();
  const c = s.channels.find((x) => x.id === id);
  const [f, setF] = useState<Channel | null>(null);
  const [key, setKey] = useState("");
  useEffect(() => {
    if (c && (!f || f.id !== c.id)) {
      setF(c);
      setKey("");
    }
  }, [c, f]);
  if (!c || !f) return null;
  const site = s.sites.find((x) => x.id === c.siteId)!;
  const acct = s.accounts.find((a) => a.id === c.accountId);
  const up = (p: Partial<Channel>) => setF({ ...f, ...p });
  const save = async () => {
    const fields = [
      "name",
      "baseUrl",
      "protocol",
      "models",
      "bindings",
      "enabled",
      "mode",
      "rating",
      "note",
      "headers",
      "category",
      "client",
      "authType",
    ] as const;
    const patch = Object.fromEntries(
      fields
        .filter((k) => JSON.stringify(f[k]) !== JSON.stringify(c[k]))
        .map((k) => [k, f[k]]),
    );
    if (key) patch.key = key;
    const saved = await saveChannel(c.id, patch, f.version);
    if (saved) {
      setF(saved);
      setKey("");
    }
  };
  return (
    <Drawer
      open
      onClose={onClose}
      title={`编辑渠道 · ${c.name}`}
      sub={
        <span className="flex flex-wrap items-center gap-2">
          {site.name} / {acct?.name} · 当前 v{c.version}{" "}
          <ApplyBadge a={c.apply} cat={f.category} />
        </span>
      }
      footer={
        <>
          <span className="mr-auto text-xs text-zinc-500">
            {f.category === "rp"
              ? "保存不触发请求，仅写入中心"
              : f.category === "client"
                ? "保存后需重新生成客户端配置"
                : "保存后在详情中应用网关配置"}
          </span>
          <Btn onClick={onClose}>关闭</Btn>
          <Btn kind="primary" onClick={save} disabled={c.apply === "saving"}>
            {c.apply === "saving" ? "保存中…" : "保存"}
          </Btn>
        </>
      }
    >
      {c.applyMsg && (
        <div
          className={`mb-4 rounded-md px-3 py-2 text-sm ${c.apply === "failed" ? "bg-red-50 text-red-800" : c.apply === "synced" ? "bg-emerald-50 text-emerald-800" : "bg-amber-50 text-amber-800"}`}
        >
          {c.applyMsg}
        </div>
      )}
      {!c.gateway && ["general", "media"].includes(c.category) && (
        <div className="mb-4 rounded border border-blue-200 bg-blue-50 p-3 text-sm">
          接入 fn 网关后，再为各应用生成独立调用身份。
          {s.integrations
            .filter((i) => i.kind === "newapi")
            .map((i) => (
              <Btn
                key={i.id}
                disabled={!c.hasKey || !c.models.length}
                onClick={() => {
                  void act(`/channels/${c.id}/connect-gateway`, {
                    sourceId: i.id,
                  }).then((r) => {
                    if (r) setF(r);
                  });
                }}
              >
                接入 {i.name}
              </Btn>
            ))}
        </div>
      )}
      <div className="grid gap-4">
        <Field label="用途">
          <select
            className={inputCls}
            value={f.category}
            onChange={(e) =>
              up({ category: e.target.value as Channel["category"] })
            }
          >
            {[
              ["general", "通用"],
              ["media", "生图视频"],
              ["rp", "RP"],
              ["client", "客户端绑定（Code）"],
            ].map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </select>
        </Field>
        {f.category === "rp" && c.gateway && (
          <div className="rounded bg-amber-50 p-3 text-sm text-amber-800">
            绑定应用：{c.bindings.join("、") || "无"}。保存 RP
            用途后需停用旧网关入口，避免网关测试。
          </div>
        )}
        {c.category === "rp" && c.gateway && (
          <Btn onClick={() => act(`/channels/${c.id}/apply`, {})}>
            停用旧网关入口（迁移 RP）
          </Btn>
        )}
        {f.category === "client" && (
          <Field label="限制客户端">
            <select
              className={inputCls}
              value={f.client || ""}
              onChange={(e) => up({ client: e.target.value })}
            >
              <option value="">请选择</option>
              {["Claude Code", "Codex", "OpenCode"].map((x) => (
                <option key={x}>{x}</option>
              ))}
            </select>
          </Field>
        )}
        <Field label="渠道名称">
          <input
            className={inputCls}
            value={f.name}
            onChange={(e) => up({ name: e.target.value })}
          />
        </Field>
        <div className="grid gap-4 sm:grid-cols-[1fr_160px]">
          <Field label="地址">
            <input
              className={inputCls + " font-mono text-xs"}
              value={f.baseUrl}
              onChange={(e) => up({ baseUrl: e.target.value })}
            />
          </Field>
          <Field label="协议">
            <select
              className={inputCls}
              value={f.protocol}
              onChange={(e) => up({ protocol: e.target.value })}
            >
              {["OpenAI", "OpenAI Responses", "Anthropic", "Gemini"].map(
                (p) => (
                  <option key={p}>{p}</option>
                ),
              )}
            </select>
          </Field>
        </div>
        {f.protocol === "Anthropic" && (
          <Field label="认证方式">
            <select
              className={inputCls}
              value={f.authType || "bearer"}
              onChange={(e) =>
                up({ authType: e.target.value as Channel["authType"] })
              }
            >
              <option value="bearer">Bearer Token</option>
              <option value="api_key">x-api-key</option>
            </select>
          </Field>
        )}
        <Field label="挑选的模型" hint="逗号分隔；只放实际要用的几个">
          <input
            className={inputCls + " font-mono text-xs"}
            value={f.models.join(", ")}
            onChange={(e) =>
              up({
                models: e.target.value
                  .split(",")
                  .map((x) => x.trim())
                  .filter(Boolean),
              })
            }
          />
        </Field>
        <Field
          label={`凭据（当前 ${c.keyMask}）`}
          hint="凭据加密存储；列表只显示掩码"
        >
          <input
            className={inputCls + " font-mono text-xs"}
            type="password"
            value={key}
            placeholder="粘贴新 key 以替换"
            onChange={(e) => setKey(e.target.value)}
          />
        </Field>
        <Field
          label="应用绑定"
          hint={
            f.category === "rp"
              ? "RP 资源独占酒馆"
              : f.category === "client"
                ? "仅限指定客户端"
                : "通用资源可被 Code、Hermes Chat/Cron 复用"
          }
        >
          <div className="flex flex-wrap gap-3 pt-1">
            {(f.category === "rp"
              ? ["酒馆"]
              : f.category === "client"
                ? [c.client || "Claude Code"]
                : ["Code", "Hermes Chat", "Hermes Cron"]
            ).map((b) => (
              <label key={b} className="flex items-center gap-1.5 text-sm">
                <input
                  type="checkbox"
                  checked={f.bindings.includes(b)}
                  onChange={(e) =>
                    up({
                      bindings: e.target.checked
                        ? [...f.bindings, b]
                        : f.bindings.filter((x) => x !== b),
                    })
                  }
                />
                {b}
              </label>
            ))}
          </div>
        </Field>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="人工启停">
            <select
              className={inputCls}
              value={f.enabled ? "1" : "0"}
              onChange={(e) => up({ enabled: e.target.value === "1" })}
            >
              <option value="1">启用</option>
              <option value="0">暂停</option>
            </select>
          </Field>
          <Field label="管理方式">
            <select
              className={inputCls}
              value={f.mode}
              disabled={f.category !== "general" && f.category !== "media"}
              onChange={(e) => up({ mode: e.target.value as Channel["mode"] })}
            >
              <option value="auto">自动</option>
              <option value="manual">人工</option>
            </select>
          </Field>
          <Field label="人工评价">
            <select
              className={inputCls}
              value={f.rating}
              onChange={(e) =>
                up({ rating: e.target.value as Channel["rating"] })
              }
            >
              <option value="">未评</option>
              <option>优</option>
              <option>良</option>
              <option>差</option>
            </select>
          </Field>
        </div>
        <Field label="备注">
          <textarea
            className={inputCls + " h-16 py-1.5"}
            value={f.note}
            onChange={(e) => up({ note: e.target.value })}
          />
        </Field>
        {f.category === "client" && (
          <HeaderEditor
            headers={f.headers}
            onChange={(h) => up({ headers: h })}
          />
        )}
      </div>
    </Drawer>
  );
}

export function ConflictDrawer({
  id,
  onClose,
}: {
  id: string | null;
  onClose: () => void;
}) {
  const { s, act } = useStore();
  const c = s.channels.find((x) => x.id === id);
  if (!c || !c.external) return null;
  const ext = c.external;
  const fields = (Object.keys(ext) as (keyof Channel)[]).filter(
    (k) => k !== "version",
  );
  const show = (v: unknown) => (Array.isArray(v) ? v.join(", ") : String(v));
  return (
    <Drawer
      open
      wide
      onClose={onClose}
      title={`处理冲突 · ${c.name}`}
      sub="409：外部（酒馆/网关）已有更新版本，中心编辑基于旧版本"
      footer={
        <>
          <Btn
            onClick={() => {
              void act(`/channels/${c.id}/resolve`, {
                choice: "external",
              }).then((r) => r && onClose());
            }}
          >
            采用外部配置
          </Btn>
          <Btn
            kind="primary"
            onClick={() => {
              void act(`/channels/${c.id}/resolve`, { choice: "center" }).then(
                (r) => r && onClose(),
              );
            }}
          >
            保留当前编辑
          </Btn>
        </>
      }
    >
      <div className="mb-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-800">
        酒馆已保存内容与中心配置不同。选择一侧后才能继续应用；未处理时保留两侧内容。
      </div>
      <div className="overflow-hidden rounded-md ring-1 ring-zinc-200">
        <div className="grid grid-cols-[100px_1fr_1fr] bg-zinc-50 text-xs font-medium text-zinc-600">
          <div className="px-3 py-2">字段</div>
          <div className="border-l border-zinc-200 px-3 py-2">
            外部 v{ext.version}
          </div>
          <div className="border-l border-zinc-200 px-3 py-2">
            中心当前 v{c.version}
          </div>
        </div>
        {fields.map((k) => (
          <div
            key={k}
            className="grid grid-cols-[100px_1fr_1fr] border-t border-zinc-200 text-sm"
          >
            <div className="px-3 py-2 text-zinc-600">
              {k === "models" ? "模型" : k === "baseUrl" ? "地址" : k}
            </div>
            <div className="break-all border-l border-zinc-200 bg-amber-50/60 px-3 py-2 font-mono text-xs">
              {show(ext[k])}
            </div>
            <div className="break-all border-l border-zinc-200 bg-blue-50/60 px-3 py-2 font-mono text-xs">
              {show(c[k])}
            </div>
          </div>
        ))}
      </div>
    </Drawer>
  );
}

export function ConfigDrawer({
  id,
  client,
  title,
  note,
  onClose,
  onDone,
  content: preparedContent,
  model,
}: {
  id: string | null;
  client: string;
  title: string;
  note?: string;
  onClose: () => void;
  onDone?: () => void;
  content?: string;
  model?: string;
}) {
  const { s, act, toast } = useStore();
  const c = s.channels.find((x) => x.id === id),
    [text, setText] = useState(preparedContent || "");
  useEffect(() => {
    if (!preparedContent && id)
      void act("/exports", { channelId: id, client, model }).then((r) => {
        if (r) setText(r.content);
      });
  }, [id, client, preparedContent, model]);
  if (!c) return null;
  return (
    <Drawer
      open
      onClose={onClose}
      title={title}
      sub={`${client} · ${c.protocol} · ${c.baseUrl}`}
      footer={
        <>
          <Btn onClick={onClose}>关闭</Btn>
          <Btn
            kind="primary"
            disabled={!text}
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(text);
                toast("配置已复制");
                onDone?.();
              } catch {
                toast("无法写入剪贴板，请手动复制配置", "err");
              }
            }}
          >
            <Copy size={14} />
            复制配置
          </Btn>
        </>
      }
    >
      {note && <Badge tone="warn">{note}</Badge>}
      <pre className="mt-3 overflow-x-auto whitespace-pre rounded-md bg-zinc-900 p-4 font-mono text-xs leading-relaxed text-zinc-100">
        {text || "正在生成配置…"}
      </pre>
      <p className="mt-3 text-xs text-zinc-500">
        生成配置不会启动客户端。请将凭据保存在目标客户端，真实任务成功后登记验证结果。
      </p>
    </Drawer>
  );
}
