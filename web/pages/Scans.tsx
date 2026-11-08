import { useEffect, useRef, useState } from "react";
import { ArrowRight, FileSearch, Play, Radar, Settings2 } from "lucide-react";
import {
  Badge,
  Button,
  EmptyState,
  FilterSearch,
  SectionHeading,
  Segmented,
} from "../components";
import { api, errorText, saveError } from "../api";
import { usePolling } from "../hooks";
import {
  dateTime,
  archiveLabels,
  tagLabels,
  websiteLabel,
  catalogLabel,
  type MaintenanceSummary,
} from "../data";
import { useWorkspace } from "../workspace";
import MaintenanceSettings from "../MaintenanceSettings";
import ModelTests from "../ModelTests";
import ChannelPools from "./ChannelPools";

const stateLabel = (state?: string) =>
  ({
    queued: "排队中",
    running: "执行中",
    waiting: "等待任务",
    succeeded: "已完成",
    failed: "未完成",
    cancelled: "已取消",
  })[state || ""] || state;

export default function Scans() {
  const { sites, query, inspectSite, refresh, notify } = useWorkspace();
  const [filter, setFilter] = useState("待恢复"),
    [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string[]>([]),
    [summary, setSummary] = useState<MaintenanceSummary | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [settings, setSettings] = useState(false),
    [poolSettings, setPoolSettings] = useState(false),
    [modelChannel, setModelChannel] = useState<string | null>(null);
  const entries = sites.flatMap((site) =>
    site.channels.map((channel) => ({ site, channel })),
  );
  const rows = entries.filter(
    ({ site, channel: c }) =>
      `${site.name} ${site.websiteUrl} ${c.name} ${c.recovery.reason}`
        .toLowerCase()
        .includes(query.toLowerCase()) &&
      `${site.name} ${c.name} ${c.recovery.reason}`
        .toLowerCase()
        .includes(search.toLowerCase()) &&
      (filter === "全部" ||
        (filter === "待恢复" && c.recovery.pending) ||
        (filter === "禁止测活" && !c.probeAllowed) ||
        (filter === "最近恢复" && !!c.maintenance?.lastRestoredAt)),
  );
  const allowed = rows
    .filter(({ channel: c }) => c.probeAllowed)
    .map(({ channel: c }) => c.id);
  const target = entries.find(({ channel: c }) => c.id === modelChannel);
  const loads = useRef(0);
  useEffect(() => () => void loads.current++, []);
  async function load() {
    const id = ++loads.current;
    try {
      const next = await api<MaintenanceSummary>("/maintenance");
      if (id === loads.current) setSummary(next);
    } catch (e) {
      if (id === loads.current) throw e;
    }
  }
  usePolling((first) => {
    void load().catch((e) => setError(errorText(e)));
    if (!first) void refresh();
  }, refresh);
  async function run(kind: "scan" | "maintain", ids: string[]) {
    setBusy(true);
    setError("");
    try {
      await api(kind === "scan" ? "/scans" : "/maintenance/runs", "POST", {
        requestId: crypto.randomUUID(),
        channelIds: ids,
      });
      setSelected([]);
      await load();
      notify(kind === "scan" ? "扫描已排队" : "已安排扫描和任务验证");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  const active =
    summary?.operations.filter((o) =>
      ["queued", "running", "waiting"].includes(o.state),
    ) || [];
  return (
    <>
      <div className="maintenance-heading">
        <div>
          <p>扫描目录与站方表现，再用任务验证；通过后同步 New API。</p>
        </div>
        <Button onClick={() => setPoolSettings(true)}>渠道池与任务</Button>
        <Button onClick={() => setSettings(true)} disabled={!summary}>
          <Settings2 size={15} />
          维护设置
        </Button>
      </div>
      <div className="maintenance-summary">
        <div>
          <span>自动维护</span>
          <strong>{summary?.policy.enabled ? "运行中" : "未开启"}</strong>
        </div>
        <div>
          <span>今日任务预算</span>
          <strong>
            {summary ? `${summary.budget.used} / ${summary.budget.limit}` : "—"}
            <small>次</small>
          </strong>
        </div>
        <div>
          <span>真实 cron</span>
          <strong>
            {summary?.tasks.ready || 0}
            <small>项可用 · 共 {summary?.tasks.total || 0} 项</small>
          </strong>
        </div>
        <div>
          <span>网关写入</span>
          <strong>
            {summary?.gatewayWrites
              ? summary.policy.autoApply
                ? "验证后自动恢复"
                : "手动应用"
              : "尚未开启"}
          </strong>
        </div>
      </div>
      {summary?.coverage && (
        <div className="archive-coverage">
          {Object.entries(archiveLabels).map(([reason, label]) => {
            const rows = summary.coverage?.[reason] || [];
            return (
              <div key={reason}>
                <span>{label}</span>
                <strong>{rows.length}</strong>
                <small>
                  已排程 {rows.filter((r) => r.nextCheckAt).length} · 等待条件{" "}
                  {rows.filter((r) => !r.nextCheckAt).length}
                </small>
              </div>
            );
          })}
        </div>
      )}
      {summary?.pilot && summary.pilot.state !== "completed" && (
        <p className="quiet-notice">
          试点：
          {
            entries.find((e) => e.channel.id === summary.pilot?.channelId)
              ?.channel.name
          }{" "}
          · {summary.pilot.modelId}。
          {summary.pilot.state === "applying"
            ? "任务已通过，等待 New API 回读。"
            : "等待目录、权益和日报预览验证；通过并回读后，再启用其余通用文字渠道的自动验证与调权。"}
        </p>
      )}
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      {!!active.length && (
        <div className="maintenance-progress">
          <Radar size={18} />
          <div>
            <strong>{active[0].stage}</strong>
            <p>{active.length} 项处理中 · 可关闭页面，fn 继续执行</p>
          </div>
          <Badge tone="blue">{stateLabel(active[0].state)}</Badge>
        </div>
      )}
      <section>
        <SectionHeading
          title="渠道检查"
          meta={`${rows.length} 条渠道 · 网站与调用问题分别记录`}
        />
        <div className="filter-bar">
          <Segmented
            label="检查记录视图"
            value={filter}
            onChange={(v) => {
              setFilter(v);
              setSelected([]);
            }}
            options={["待恢复", "全部", "最近恢复", "禁止测活"].map((v) => ({
              value: v,
              label: v,
            }))}
          />
          <FilterSearch
            value={search}
            onChange={setSearch}
            placeholder="搜索站点或失败原因"
          />
        </div>
        <div className="scan-actions">
          <span>
            {selected.length
              ? `已选 ${selected.length} 条`
              : `当前列表 ${allowed.length} 条允许扫描`}
          </span>
          <div>
            <Button
              disabled={busy || !(selected.length || allowed.length)}
              onClick={() =>
                void run("scan", selected.length ? selected : allowed)
              }
            >
              <Radar size={15} />
              只扫描目录
            </Button>
            <Button
              variant="primary"
              disabled={busy || !(selected.length || allowed.length)}
              onClick={() =>
                void run("maintain", selected.length ? selected : allowed)
              }
            >
              <Play size={14} />
              扫描并验证
            </Button>
          </div>
        </div>
        <div className="scan-table-wrap">
          <table className="scan-table">
            <thead>
              <tr>
                <th>
                  <input
                    type="checkbox"
                    aria-label="选择当前可扫描渠道"
                    checked={
                      allowed.length > 0 &&
                      allowed.every((id) => selected.includes(id))
                    }
                    onChange={(e) =>
                      setSelected(e.target.checked ? allowed : [])
                    }
                  />
                </th>
                <th>渠道 / 站点</th>
                <th>网站与目录</th>
                <th>任务与恢复</th>
                <th>后续检查</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ site, channel: c }) => {
                const status = summary?.channels.find(
                    (s) => s.channelId === c.id,
                  ),
                  passed = c.modelAvailability.filter(
                    (o) =>
                      o.verification?.result === "success" &&
                      o.verification.quality === "passed",
                  );
                const latest = c.modelAvailability
                  .filter((o) => o.verification)
                  .sort((a, b) =>
                    (b.verification?.at || "").localeCompare(
                      a.verification?.at || "",
                    ),
                  )[0];
                return (
                  <tr key={c.id}>
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`选择 ${c.name}`}
                        disabled={!c.probeAllowed}
                        checked={selected.includes(c.id)}
                        onChange={(e) =>
                          setSelected(
                            e.target.checked
                              ? [...selected, c.id]
                              : selected.filter((id) => id !== c.id),
                          )
                        }
                      />
                    </td>
                    <td>
                      <button
                        className="table-title"
                        onClick={() => inspectSite(site.id)}
                      >
                        {c.name}
                      </button>
                      <a
                        className="site-link"
                        href={site.websiteUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {site.websiteUrl.replace(/^https?:\/\//, "")}
                      </a>
                      <div className="inline-tags">
                        {c.tags.map((t) => (
                          <Badge key={t}>{tagLabels[t]}</Badge>
                        ))}
                      </div>
                    </td>
                    <td>
                      <strong>
                        {site.websiteObservation
                          ? `网站：${websiteLabel(site.websiteObservation.status)}`
                          : "网站未检查"}
                      </strong>
                      <small>
                        {c.scan
                          ? `${catalogLabel(c.scan.catalogStatus)} · ${c.scan.catalogModels.length} 个模型`
                          : "尚未扫描目录"}
                      </small>
                      <small>{dateTime(c.scan?.scannedAt)}</small>
                    </td>
                    <td>
                      <strong>
                        {passed.length
                          ? `${passed.length} 个模型通过任务`
                          : c.recovery.reason || "尚未验证"}
                      </strong>
                      <small>
                        {c.maintenance?.lastRestoredAt
                          ? `最近恢复 ${dateTime(c.maintenance.lastRestoredAt)}`
                          : latest?.verification?.reason ||
                            `${c.historicalEvaluations.length} 条历史测试`}
                      </small>
                      <Button
                        variant="ghost"
                        aria-label={`模型与结果：${c.name}`}
                        onClick={() => setModelChannel(c.id)}
                      >
                        模型与结果
                        <ArrowRight size={13} />
                      </Button>
                    </td>
                    <td>
                      <strong>
                        {status?.validationBlocked ||
                          status?.waitingFor ||
                          status?.automaticReason ||
                          "按维护策略运行"}
                      </strong>
                      <small>
                        {status?.nextCheckAt
                          ? `下次扫描 ${dateTime(status.nextCheckAt)}`
                          : "不安排主动请求"}
                      </small>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!rows.length && (
            <EmptyState
              icon={FileSearch}
              title="没有匹配的渠道"
              description="可切换到全部渠道查看目录和验证结果。"
            />
          )}
        </div>
      </section>
      {!!summary?.bindings?.length && (
        <section className="maintenance-history">
          <SectionHeading
            title="任务绑定"
            meta="正常任务绑定渠道池，按优先级自动选型；验证预览保留独立绑定"
          />
          <div className="maintenance-log">
            {summary.bindings.map((b) => (
              <div key={b.id}>
                <Badge tone={b.enabled ? "green" : "neutral"}>
                  {b.enabled ? "已启用" : "已停用"}
                </Badge>
                <span>
                  <strong>{b.taskName}</strong>
                  <small>
                    {b.poolId ? `${b.poolName || "渠道池"} · 按优先级自动选型` : <>{
                      entries.find((e) => e.channel.id === b.channelId)?.channel
                        .name
                    } · {b.modelId}</>} ·{" "}
                    {b.validationOnly ? "仅用于验证预览" : "正常任务绑定"}
                  </small>
                </span>
                <Button
                  disabled={busy}
                  aria-label={`${b.enabled ? "停用绑定" : "启用绑定"}：${b.taskName}`}
                  onClick={() => {
                    setBusy(true);
                    void api(`/cron/bindings/${b.id}`, "PATCH", {
                      version: b.version,
                      changes: { enabled: !b.enabled },
                    })
                      .then(load)
                      .catch(async (e) => setError(await saveError(e, load)))
                      .finally(() => setBusy(false));
                  }}
                >
                  {b.enabled ? "停用绑定" : "启用绑定"}
                </Button>
              </div>
            ))}
          </div>
        </section>
      )}
      {!!summary?.runs?.length && (
        <section className="maintenance-history">
          <SectionHeading
            title="任务验证"
            meta="草稿预览不投递；请求事实由 New API 回收"
          />
          <div className="maintenance-log">
            {summary.runs.slice(0, 8).map((r) => (
              <div key={r.id}>
                <Badge
                  tone={
                    r.verification?.result === "success" ? "green" : "neutral"
                  }
                >
                  {r.completedAt
                    ? r.verification?.result === "success"
                      ? "通过"
                      : "未通过"
                    : "执行中"}
                </Badge>
                <span>
                  <strong>
                    {
                      entries.find((e) => e.channel.id === r.channelId)?.channel
                        .name
                    }{" "}
                    · {r.modelId}
                  </strong>
                  <small>
                    {r.executionMode === "preview" ? "仅验证预览" : "正式任务"}{" "}
                    ·{" "}
                    {r.verification?.reason ||
                      r.verification?.artifactRef ||
                      "等待执行结果"}
                  </small>
                </span>
                <time>{dateTime(r.completedAt || r.createdAt)}</time>
              </div>
            ))}
          </div>
        </section>
      )}
      {!!summary?.operations.length && (
        <section className="maintenance-history">
          <SectionHeading title="执行记录" meta="任务验收与网关应用分别留痕" />
          <div className="maintenance-log">
            {summary.operations.slice(0, 12).map((o) => (
              <div key={o.id}>
                <Badge
                  tone={
                    o.state === "failed" || o.result?.passed === false
                      ? "amber"
                      : o.state === "succeeded"
                        ? "green"
                        : "neutral"
                  }
                >
                  {o.result?.passed === false ? "未通过" : stateLabel(o.state)}
                </Badge>
                <span>
                  <strong>
                    {entries.find((e) => e.channel.id === o.input.channelId)
                      ?.channel.name ||
                      {
                        maintain: "扫描与恢复",
                        scan: "目录扫描",
                        apply: "New API 应用",
                      }[o.kind] ||
                      "模型验证"}
                    {o.input.modelId ? ` · ${o.input.modelId}` : ""}
                  </strong>
                  <small>{o.reason || o.result?.reason || o.stage}</small>
                </span>
                <time>{dateTime(o.createdAt)}</time>
              </div>
            ))}
          </div>
        </section>
      )}
      {poolSettings && <ChannelPools close={() => setPoolSettings(false)} saved={async () => {
        await load(); await refresh(); notify("渠道池配置已保存");
      }} />}
      {settings && summary && (
        <MaintenanceSettings
          summary={summary}
          close={() => setSettings(false)}
          saved={async () => {
            await load();
            await refresh();
            setSettings(false);
            notify("维护策略已保存");
          }}
        />
      )}
      {target && (
        <ModelTests
          channel={target.channel}
          status={summary?.channels.find(
            (s) => s.channelId === target.channel.id,
          )}
          close={() => setModelChannel(null)}
          updated={async () => {
            await load();
            await refresh();
          }}
        />
      )}
    </>
  );
}
