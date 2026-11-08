import { useEffect, useState } from "react";
import { api, allPages, errorText } from "./api";
import { Badge, Button, FilterSearch, Overlay } from "./components";
import { dateTime, type Channel, type MaintenanceState } from "./data";

export default function ModelTests({
  channel: c,
  status,
  close,
  updated,
}: {
  channel: Channel;
  status?: MaintenanceState;
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
    supportsPreview?: boolean;
    supportsScheduledRunConfig?: boolean;
    requiredCapabilities?: string[];
  };
  const [tasks, setTasks] = useState<Task[]>([]),
    [taskId, setTaskId] = useState("");
  const validationOnly = true;
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
            <option value="">选择预览任务，否则用小任务</option>
            {tasks
              .filter(
                (t) => t.enabled && t.supportsRunConfig && t.supportsResult && t.supportsPreview !== false,
              )
              .map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}{t.requiredCapabilities?.length ? " · 截图与工具调用" : ""}
                </option>
              ))}
          </select>
        </label>
        <p className="muted">正常定时任务请在“渠道池与任务”中绑定渠道池；此处仅安排单模型验证预览。</p>
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
