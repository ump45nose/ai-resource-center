import { useState } from "react";
import { ArrowRight, Box, Copy } from "lucide-react";
import {
  Badge,
  Button,
  EmptyState,
  FilterSearch,
  Segmented,
} from "../components";
import { copyText } from "../api";
import { tagLabels } from "../data";
import { useWorkspace } from "../workspace";
export default function Models() {
  const { models, query, inspectModel, inspectSite, notify } = useWorkspace();
  const [tier, setTier] = useState("全部");
  const [search, setSearch] = useState("");
  const [shown, setShown] = useState(36);
  const rows = models.filter(
    (m) =>
      (tier === "全部" || m.tier === tier) &&
      m.id.toLowerCase().includes(query.toLowerCase()) &&
      m.id.toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <>
      <div className="filter-bar">
        <Segmented
          label="模型能力"
          value={tier}
          onChange={(v) => {
            setTier(v);
            setShown(36);
          }}
          options={[
            { value: "全部", label: "全部" },
            { value: "strong", label: "强模型" },
            { value: "execution", label: "执行模型" },
            { value: "unclassified", label: "待评价" },
          ]}
        />
        <FilterSearch
          value={search}
          onChange={(v) => {
            setSearch(v);
            setShown(36);
          }}
          placeholder="搜索具体模型 ID"
        />
      </div>
      <div className="section-heading compact">
        <span>{rows.length} 个模型 · 仅显示已生效渠道</span>
      </div>
      <div className="model-grid">
        {rows.slice(0, shown).map((m) => (
          <article className="model-card" key={m.id}>
            <div className="model-card-head">
              <Badge>{m.channels.length} 条渠道</Badge>
              <Badge
                tone={m.channels.some((r) => r.verified) ? "green" : "neutral"}
              >
                {m.channels.some((r) => r.verified)
                  ? "存在已验证渠道"
                  : "已生效"}
              </Badge>
            </div>
            <button className="model-name" onClick={() => inspectModel(m.id)}>
              {m.id}
            </button>
            <code className="model-id">{m.id}</code>
            <div className="route-list">
              {m.channels.slice(0, 3).map(({ site, channel, verified }) => (
                <button key={channel.id} onClick={() => inspectSite(site.id)}>
                  <span
                    className={`status-dot ${verified ? "green" : "clay"}`}
                  />
                  <span>{site.name}</span>
                  <span className="muted">
                    {verified ? "已验证" : "已生效"}
                  </span>
                  <ArrowRight size={13} />
                </button>
              ))}
            </div>
            <div className="inline-tags">
              {[...new Set(m.channels.flatMap((r) => r.channel.tags))].map(
                (t) => (
                  <Badge key={t}>{tagLabels[t]}</Badge>
                ),
              )}
            </div>
            <div className="model-card-footer">
              <Button
                variant="ghost"
                aria-label={`查看渠道：${m.id}`}
                onClick={() => inspectModel(m.id)}
              >
                查看渠道
                <ArrowRight size={14} />
              </Button>
              <Button
                variant="ghost"
                aria-label={`复制 ID：${m.id}`}
                onClick={async () => {
                  try {
                    await copyText(m.id);
                    notify("模型 ID 已复制");
                  } catch {
                    notify("请在详情中选择并复制模型 ID");
                  }
                }}
              >
                <Copy size={14} />
                复制 ID
              </Button>
            </div>
          </article>
        ))}
      </div>
      {!rows.length && (
        <EmptyState
          icon={Box}
          title="没有匹配的已生效模型"
          description="可在站点中查看渠道状态与选定模型。"
        />
      )}
      {rows.length > shown && (
        <Button onClick={() => setShown(shown + 36)}>再显示 36 个模型</Button>
      )}
    </>
  );
}
