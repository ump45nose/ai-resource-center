import { useState } from "react";
import { FileCode2, CheckCheck, Save } from "lucide-react";
import { useStore } from "../store";
import { Badge, Btn, Field, inputCls, Url, ApplyBadge } from "../ui";
import { HeaderEditor, ConfigDrawer } from "../shared";
import type { Channel } from "../data";

function Card({ c }: { c: Channel }) {
  const { s, saveChannel, updChannel, toast, act } = useStore();
  const [h, setH] = useState(c.headers);
  const [key, setKey] = useState("");
  const [url, setUrl] = useState(c.baseUrl);
  const [cfg, setCfg] = useState(false);
  const site = s.sites.find((x) => x.id === c.siteId)!;
  const dirty =
    JSON.stringify(h) !== JSON.stringify(c.headers) || key || url !== c.baseUrl;
  const st =
    c.clientState === "verified" ? (
      <Badge tone="ok">已验证</Badge>
    ) : c.clientState === "awaiting" ? (
      <Badge tone="warn">待客户端确认</Badge>
    ) : (
      <Badge tone="mute">待生成配置</Badge>
    );
  return (
    <div className="rounded-lg border border-zinc-200 bg-white">
      <div className="flex flex-wrap items-start justify-between gap-2 border-b border-zinc-200 px-4 py-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold text-zinc-900">{c.client}</span>
            {st}
            <ApplyBadge a={c.apply} />
          </div>
          <div className="mt-0.5 text-xs text-zinc-500">
            {c.name} · <Url href={site.url} /> · v{c.version}
          </div>
        </div>
        <div className="flex flex-wrap gap-1">
          <Btn size="sm" onClick={() => setCfg(true)}>
            <FileCode2 size={13} />
            生成配置
          </Btn>
          <Btn
            size="sm"
            disabled={c.clientState !== "awaiting"}
            onClick={() => {
              const summary = window.prompt("实际任务结果摘要");
              if (summary) void act(`/channels/${c.id}/verify`, { summary });
            }}
          >
            <CheckCheck size={13} />
            登记真实任务成功
          </Btn>
        </div>
      </div>
      <div className="grid gap-4 p-4 lg:grid-cols-2">
        <div className="grid content-start gap-3">
          <div className="grid grid-cols-2 gap-3 text-xs">
            <div>
              <div className="text-zinc-500">协议</div>
              <div className="mt-0.5 text-sm">{c.protocol}</div>
            </div>
            <div>
              <div className="text-zinc-500">选定模型</div>
              <div className="mt-0.5 font-mono text-sm">
                {c.models.join(", ")}
              </div>
            </div>
          </div>
          <Field label="地址">
            <input
              className={inputCls + " font-mono text-xs"}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
          </Field>
          <Field
            label={`认证凭据（当前 ${c.keyMask}）`}
            hint="单独维护，不写入请求头"
          >
            <input
              className={inputCls + " font-mono text-xs"}
              type="password"
              placeholder="粘贴新 key"
              value={key}
              onChange={(e) => setKey(e.target.value)}
            />
          </Field>
          <p className="text-xs text-zinc-500">
            模型列表读取成功不等于调用可用；生成配置后为「待客户端确认」，真实任务成功后才为「已验证」。
          </p>
        </div>
        <div>
          <HeaderEditor headers={h} onChange={setH} />
          <div className="mt-3 flex justify-end">
            <Btn
              size="sm"
              kind="primary"
              disabled={!dirty || c.apply === "saving"}
              onClick={() => {
                saveChannel(c.id, {
                  headers: h,
                  baseUrl: url,
                  ...(key ? { key } : {}),
                });
                setKey("");
              }}
            >
              <Save size={13} />
              {c.apply === "saving" ? "保存中…" : "保存"}
            </Btn>
          </div>
        </div>
      </div>
      {cfg && (
        <ConfigDrawer
          id={c.id}
          client={c.client!}
          title="配置预览"
          onClose={() => setCfg(false)}
        />
      )}
    </div>
  );
}

export default function ClientView() {
  const { s } = useStore();
  const list = s.channels.filter((c) => c.category === "client");
  return (
    <div className="grid gap-4">
      <p className="text-sm text-zinc-600">
        按指定客户端条件单独维护，不进入公共网关自动调整。
      </p>
      {list.map((c) => (
        <Card key={c.id} c={c} />
      ))}
    </div>
  );
}
