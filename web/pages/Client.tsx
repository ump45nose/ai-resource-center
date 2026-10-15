import { useState } from "react";
import { FileCode2, CheckCheck, Settings2 } from "lucide-react";
import { useStore } from "../store";
import { Badge, Btn, Url, ApplyBadge } from "../ui";
import { ChannelDrawer, ConfigDrawer, ConflictDrawer } from "../shared";
import type { Channel } from "../data";

function Card({ c }: { c: Channel }) {
  const { s, act } = useStore();
  const [cfg, setCfg] = useState(false),
    [edit, setEdit] = useState(false),
    [conflict, setConflict] = useState(false);
  const site = s.sites.find((x) => x.id === c.siteId)!;
  const source = s.integrations.find((x) => x.id === c.gateway?.sourceId);
  const gateway = s.integrations.find((x) => x.kind === "newapi");
  const canExport = c.gateway
    ? !!c.nativePassthrough && c.apply === "synced"
    : c.gatewayAllowed === false && c.hasKey;
  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2 font-medium">
            {c.name}
            <Badge tone="info">仅 {c.client || "客户端待确认"}</Badge>
            <ApplyBadge a={c.apply} />
            <Badge tone={c.clientState === "verified" ? "ok" : "warn"}>
              {c.clientState === "verified"
                ? "真实任务已验证"
                : "待真实任务确认"}
            </Badge>
          </div>
          <div className="mt-1 text-sm">
            <Url href={site.url} />
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Btn size="sm" onClick={() => setEdit(true)}>
            <Settings2 size={13} />
            编辑连接
          </Btn>
          {!c.gateway && gateway && c.gatewayAllowed !== false && (
            <Btn
              size="sm"
              disabled={!c.hasKey || !c.models.length}
              onClick={() =>
                act(`/channels/${c.id}/connect-gateway`, {
                  sourceId: gateway.id,
                })
              }
            >
              接入 New API
            </Btn>
          )}
          {c.gateway && c.apply !== "diff" && (
            <Btn size="sm" onClick={() => act(`/channels/${c.id}/apply`, {})}>
              {c.nativePassthrough ? "应用网关配置" : "应用原生透传"}
            </Btn>
          )}
          {c.apply === "diff" && (
            <Btn size="sm" onClick={() => setConflict(true)}>
              处理网关差异
            </Btn>
          )}
          <Btn size="sm" disabled={!canExport} onClick={() => setCfg(true)}>
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
            登记任务成功
          </Btn>
        </div>
      </div>
      <div className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
        <div>
          协议：{c.protocol} · key：
          {c.hasKey ? "已保存" : c.gateway ? "由网关保存" : "缺少，待补充"}
        </div>
        <div className="break-all">
          模型：{c.models.join("、") || "待确认"}
          {c.context1m ? " · 原生 1M" : ""}
        </div>
        <div className="break-all">
          入口：
          {source ? (
            <Url href={source.url} />
          ) : c.gatewayAllowed === false ? (
            "站点禁止网关转发，保留直连"
          ) : (
            "尚未接入 fn"
          )}
        </div>
        <div>
          透传：{c.nativePassthrough ? "原生正文与客户端请求头" : "未应用"} ·{" "}
          {c.mode === "auto" ? "按客户端组自动调整" : "人工管理"}
        </div>
      </div>
      {c.group && (
        <p className="mt-2 text-xs text-zinc-500">独立分组：{c.group}</p>
      )}
      {c.applyMsg && (
        <p
          className={`mt-2 text-sm ${["failed", "diff"].includes(c.apply) ? "text-red-700" : "text-amber-800"}`}
        >
          {c.applyMsg}
        </p>
      )}
      {c.availability && (
        <p className="mt-2 text-sm text-red-700">调用问题：{c.availability}</p>
      )}
      {c.note && (
        <p className="mt-2 whitespace-pre-line text-xs text-zinc-600">
          {c.note}
        </p>
      )}
      {edit && <ChannelDrawer id={c.id} onClose={() => setEdit(false)} />}
      {conflict && (
        <ConflictDrawer id={c.id} onClose={() => setConflict(false)} />
      )}
      {cfg && (
        <ConfigDrawer
          id={c.id}
          client={c.client!}
          title="fn 调用配置"
          onClose={() => setCfg(false)}
        />
      )}
    </div>
  );
}
export default function ClientView() {
  const { s } = useStore();
  return (
    <div className="grid gap-4">
      <p className="text-sm text-zinc-600">
        New API 按客户端和原生协议分组；保留客户端特征。配置使用 fn
        推理身份，真实任务成功后再确认可用。调用记录见「渠道评价」。
      </p>
      {s.channels
        .filter((c) => c.category === "client")
        .map((c) => (
          <Card key={c.id} c={c} />
        ))}
    </div>
  );
}
