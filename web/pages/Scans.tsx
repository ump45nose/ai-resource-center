import { useEffect, useState, type FormEvent } from "react";
import { ArrowRight, FileSearch, Play, Radar, Settings2 } from "lucide-react";
import {
  Badge,
  Button,
  EmptyState,
  FilterSearch,
  Overlay,
  SectionHeading,
  Segmented,
} from "../components";
import { api, allPages } from "../api";
import {
  dateTime,
  archiveLabels,
  tagLabels,
  websiteLabel,
  catalogLabel,
  type Channel,
  type Operation,
} from "../data";
import { useWorkspace } from "../workspace";

type Policy = {
  enabled: boolean;
  autoApply: boolean;
  smokeEnabled: boolean;
  smokeMaxTokens: number;
  normalHours: number;
  maintenanceHours: number;
  closedHours: number;
  keyRetryHours: number;
  newModelsHours: number;
  maxCandidates: number;
  maxEvaluationsPerDay: number;
  modelRules: { match: string; capabilityClass: "strong" | "execution" }[];
  excludedModels: string;
};
type State = {
  channelId: string;
  waitingFor: string | null;
  validationBlocked: string | null;
  nextCheckAt: string | null;
  automaticReason?: string | null;
};
type Summary = {
  policy: Policy;
  budget: { used: number; limit: number };
  gatewayWrites: boolean;
  tasks: { total: number; ready: number };
  channels: State[];
  coverage?: Record<
    string,
    {
      channelId: string;
      state: string;
      nextCheckAt: string | null;
      waitingFor: string | null;
    }[]
  >;
  pilot?: {
    state: string;
    channelId: string;
    modelId: string;
    appliedAt?: string;
  };
  bindings?: {
    id: string;
    version: number;
    taskName: string;
    channelId: string;
    modelId: string;
    enabled: boolean;
    validationOnly?: boolean;
  }[];
  runs?: {
    id: string;
    channelId: string;
    modelId: string;
    executionMode?: string;
    createdAt: string;
    completedAt?: string;
    verification?: {
      result: string;
      quality: string;
      reason?: string;
      artifactRef?: string;
    };
  }[];
  operations: Operation[];
};
const errorText = (e: unknown) =>
  e instanceof Error ? e.message : "操作未完成";
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
    [summary, setSummary] = useState<Summary | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [settings, setSettings] = useState(false),
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
  async function load() {
    setSummary(await api<Summary>("/maintenance"));
  }
  useEffect(() => {
    void load().catch((e) => setError(errorText(e)));
    const timer = setInterval(() => {
      void load().catch((e) => setError(errorText(e)));
      void refresh();
    }, 10000);
    return () => clearInterval(timer);
  }, [refresh]);
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
            meta="使用 fn 原任务；验证绑定不更改正式模型或投递"
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
                    {
                      entries.find((e) => e.channel.id === b.channelId)?.channel
                        .name
                    }{" "}
                    · {b.modelId} ·{" "}
                    {b.validationOnly ? "仅用于验证预览" : "正常任务绑定"}
                  </small>
                </span>
                <Button
                  disabled={busy}
                  onClick={() => {
                    setBusy(true);
                    void api(`/cron/bindings/${b.id}`, "PATCH", {
                      version: b.version,
                      changes: { enabled: !b.enabled },
                    })
                      .then(load)
                      .catch((e) => setError(errorText(e)))
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

function MaintenanceSettings({
  summary,
  close,
  saved,
}: {
  summary: Summary;
  close: () => void;
  saved: () => Promise<void>;
}) {
  const [p, setP] = useState(summary.policy),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [tasks, setTasks] = useState<
    {
      id: string;
      name: string;
      enabled: boolean;
      supportsRunConfig: boolean;
      supportsResult: boolean;
    }[]
  >([]);
  useEffect(() => {
    void allPages<(typeof tasks)[number]>("/cron/tasks")
      .then(setTasks)
      .catch((e) => setError(errorText(e)));
  }, []);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("/policies", "PATCH", {
        changes: p,
      });
      await saved();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Overlay
      title="自动维护"
      subtitle="扫描 → 任务验收 → New API 回读"
      onClose={close}
    >
      <form className="overlay-body form-stack" onSubmit={submit}>
        <label className="check-line">
          <input
            type="checkbox"
            checked={p.enabled}
            onChange={(e) => setP({ ...p, enabled: e.target.checked })}
          />
          按周期检查渠道
        </label>
        <label className="check-line">
          <input
            type="checkbox"
            checked={p.autoApply}
            onChange={(e) => setP({ ...p, autoApply: e.target.checked })}
          />
          任务通过后自动恢复到 New API
        </label>
        <label className="check-line">
          <input
            type="checkbox"
            checked={p.smokeEnabled}
            onChange={(e) => setP({ ...p, smokeEnabled: e.target.checked })}
          />
          无可用 cron 时使用小任务验证
        </label>
        <p className="muted">
          小任务检查代码或计算结果，有明确验收；优先使用已绑定、已适配的真实
          cron。生图与视频等待 image-caption。
        </p>
        <div className="form-columns">
          {(
            [
              ["normalHours", "正常渠道 / 小时"],
              ["maintenanceHours", "维护渠道 / 小时"],
              ["closedHours", "关闭网站 / 小时"],
              ["keyRetryHours", "key 复查 / 小时"],
              ["newModelsHours", "模型复验 / 小时"],
              ["maxCandidates", "每渠道每轮候选"],
              ["maxEvaluationsPerDay", "每日任务次数上限"],
              ["smokeMaxTokens", "小任务输出 Token 上限"],
            ] as const
          ).map(([key, label]) => (
            <label key={key}>
              {label}
              <input
                type="number"
                min={key === "smokeMaxTokens" ? 256 : 1}
                max={
                  key === "maxCandidates"
                    ? 20
                    : key === "smokeMaxTokens"
                      ? 4096
                      : undefined
                }
                value={p[key]}
                onChange={(e) => setP({ ...p, [key]: Number(e.target.value) })}
                required
              />
            </label>
          ))}
        </div>
        <h3>认可模型范围</h3>
        <p className="muted">
          按名称包含匹配，逗号分隔；从上到下优先。目录中的其他型号仍可查看，不自动消耗额度验证。
        </p>
        {p.modelRules.map((r, i) => (
          <label key={i}>
            {r.capabilityClass === "strong" ? "强模型候选" : "执行模型候选"}
            <input
              value={r.match}
              onChange={(e) =>
                setP({
                  ...p,
                  modelRules: p.modelRules.map((old, n) =>
                    n === i ? { ...old, match: e.target.value } : old,
                  ),
                })
              }
              required
            />
          </label>
        ))}
        <label>
          排除名称
          <input
            value={p.excludedModels}
            onChange={(e) => setP({ ...p, excludedModels: e.target.value })}
          />
        </label>
        <details>
          <summary>fn 任务目录 · {summary.tasks.ready} 项已适配</summary>
          <div className="task-catalog">
            {tasks.map((t) => (
              <div key={t.id}>
                <span>{t.name}</span>
                <Badge>
                  {!t.enabled
                    ? "原任务暂停"
                    : t.supportsRunConfig && t.supportsResult
                      ? "可绑定"
                      : "待适配"}
                </Badge>
              </div>
            ))}
          </div>
        </details>
        {error && (
          <p className="inline-error" role="alert">
            {error}
          </p>
        )}
        <div className="overlay-actions">
          <Button onClick={close}>取消</Button>
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? "保存中…" : "保存策略"}
          </Button>
        </div>
      </form>
    </Overlay>
  );
}

function ModelTests({
  channel: c,
  status,
  close,
  updated,
}: {
  channel: Channel;
  status?: State;
  close: () => void;
  updated: () => Promise<void>;
}) {
  const [search, setSearch] = useState(""),
    [busy, setBusy] = useState(""),
    [error, setError] = useState("");
  type Task = {
    id: string;
    externalId: string;
    source: string;
    name: string;
    enabled: boolean;
    supportsRunConfig: boolean;
    supportsResult: boolean;
    supportsScheduledRunConfig?: boolean;
  };
  const [tasks, setTasks] = useState<Task[]>([]),
    [taskId, setTaskId] = useState(""),
    [validationOnly, setValidationOnly] = useState(true);
  useEffect(() => {
    void allPages<Task>("/cron/tasks")
      .then(setTasks)
      .catch((e) => setError(errorText(e)));
  }, []);
  const rows = [...c.modelAvailability]
    .filter((o) => o.modelId.toLowerCase().includes(search.toLowerCase()))
    .sort(
      (a, b) =>
        Number(!!b.verification) - Number(!!a.verification) ||
        Number(b.proposedClass !== "unclassified") -
          Number(a.proposedClass !== "unclassified") ||
        (b.stationMetrics?.successRate ?? -1) -
          (a.stationMetrics?.successRate ?? -1),
    );
  async function act(
    modelId: string,
    action: "evaluate" | "apply" | "external" | "center",
  ) {
    setBusy(modelId);
    setError("");
    try {
      const path =
        action === "evaluate"
          ? "/evaluations"
          : `/channels/${c.id}/${action === "apply" ? "apply" : "resolve"}`;
      const task = tasks.find((t) => t.id === taskId);
      let binding: { id: string } | undefined;
      if (action === "evaluate" && task)
        binding = await api<{ id: string }>("/cron/bindings", "POST", {
          data: {
            taskRef: { source: task.source, id: task.externalId },
            channelId: c.id,
            modelId,
            enabled: true,
            discoverNewModels: true,
            validationOnly,
          },
        });
      await api(path, "POST", {
        requestId: crypto.randomUUID(),
        modelId,
        ...(action === "evaluate"
          ? {
              channelId: c.id,
              ...(task
                ? {
                    taskRef: { source: task.source, id: task.externalId },
                    bindingId: binding?.id,
                    executionMode: validationOnly ? "preview" : "scheduled",
                  }
                : {}),
            }
          : {}),
        ...(["external", "center"].includes(action) ? { choice: action } : {}),
      });
      await updated();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy("");
    }
  }
  return (
    <Overlay
      title={c.name}
      subtitle="目录可见、站方表现和任务结果分开看"
      drawer
      onClose={close}
    >
      <div className="overlay-body form-stack">
        {status?.validationBlocked && (
          <p className="quiet-notice">{status.validationBlocked}</p>
        )}
        {error && (
          <p className="inline-error" role="alert">
            {error}
          </p>
        )}
        <label>
          验证任务
          <select value={taskId} onChange={(e) => setTaskId(e.target.value)}>
            <option value="">使用已绑定 cron，否则用小任务</option>
            {tasks
              .filter(
                (t) => t.enabled && t.supportsRunConfig && t.supportsResult,
              )
              .map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
          </select>
        </label>
        {taskId && (
          <label className="toggle-field">
            <input
              type="checkbox"
              checked={validationOnly}
              onChange={(e) => setValidationOnly(e.target.checked)}
            />
            仅用于验证预览，不改正式任务配置和投递
          </label>
        )}
        {!tasks.some(
          (t) => t.enabled && t.supportsRunConfig && t.supportsResult,
        ) && (
          <p className="muted">
            cron 目录已接入，执行入口尚待适配。原计划与暂停状态不变。
          </p>
        )}
        <FilterSearch
          value={search}
          onChange={setSearch}
          placeholder="搜索模型"
        />
        <div className="model-tests">
          {rows.slice(0, 60).map((o) => (
            <article key={o.modelId}>
              <strong className="mono">{o.modelId}</strong>
              <div className="inline-tags">
                <Badge>
                  {o.catalog?.present ? "key 目录可见" : "历史或已选模型"}
                </Badge>
                {o.proposedClass && o.proposedClass !== "unclassified" && (
                  <Badge>
                    {o.proposedClass === "strong"
                      ? "强模型候选"
                      : "执行模型候选"}
                  </Badge>
                )}
                <Badge
                  tone={
                    o.verification?.result === "success" ? "green" : "neutral"
                  }
                >
                  {o.verification?.result === "success"
                    ? "任务通过"
                    : o.verification
                      ? "未通过验证"
                      : "未验证"}
                </Badge>
              </div>
              <p>
                站方成功率{" "}
                {o.stationMetrics?.successRate != null
                  ? `${o.stationMetrics.successRate}%`
                  : "未提供"}{" "}
                · {o.stationMetrics?.samples ?? "—"} 条站方样本
              </p>
              {o.health?.blocked && (
                <p className="inline-error">
                  已隔离：{o.health.reason || "等待任务复验"}
                </p>
              )}
              {o.verification && (
                <p>
                  {o.verification.reason || o.verification.result} ·{" "}
                  {dateTime(o.verification.at)}
                </p>
              )}
              {o.grade && (
                <p>
                  真实调用：{o.grade.samples} 条 · 成功率{" "}
                  {o.grade.successRate == null
                    ? "未采集"
                    : `${o.grade.successRate.toFixed(1)}%`}{" "}
                  ·
                  {{
                    observing: "样本不足，保留原优先级",
                    preferred: "优先候选",
                    regular: "常规候选",
                    backup: "备用候选",
                  }[o.grade.tier] || o.grade.tier}
                  {o.grade.entitlement?.daily ? " · 优先消耗当日额度" : ""} ·
                  权重 {o.grade.weight ?? 100}
                  {o.grade.reason && <small>{o.grade.reason}</small>}
                </p>
              )}
              {o.apply && (
                <p>
                  New API：
                  {{
                    synced: "已回读确认",
                    staged: "仅验证连接",
                    conflict: "存在外部修改",
                    external: "采用外部配置",
                    pending_sync: "已保存，等待分发回读",
                    distributed: "中心托管配置已分发",
                  }[o.apply.state] || o.apply.state}
                  {o.grade
                    ? ` · ${o.grade.samples} 条真实样本 · 优先级 ${o.grade.priority}`
                    : ""}
                </p>
              )}
              {o.apply?.state === "conflict" ? (
                <div className="scan-actions">
                  <Button
                    disabled={!!busy}
                    onClick={() => void act(o.modelId, "external")}
                  >
                    采用外部配置
                  </Button>
                  <Button
                    disabled={!!busy}
                    onClick={() => void act(o.modelId, "center")}
                  >
                    恢复中心规则
                  </Button>
                </div>
              ) : (
                <div className="scan-actions">
                  <Button
                    disabled={
                      !!busy || (!!status?.validationBlocked && !taskId)
                    }
                    onClick={() => void act(o.modelId, "evaluate")}
                  >
                    验证此模型
                  </Button>
                  {o.verification?.result === "success" && (
                    <Button
                      disabled={!!busy}
                      onClick={() => void act(o.modelId, "apply")}
                    >
                      同步 New API
                    </Button>
                  )}
                </div>
              )}
            </article>
          ))}
        </div>
        {!rows.length && <p className="muted">尚无模型目录，先扫描渠道。</p>}
        {rows.length > 60 && (
          <p className="muted">显示前 60 个，可搜索具体模型。</p>
        )}
      </div>
    </Overlay>
  );
}
