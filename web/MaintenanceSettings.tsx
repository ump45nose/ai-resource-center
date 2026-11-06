import { useEffect, useState, type FormEvent } from "react";
import { api, allPages, errorText } from "./api";
import { Badge, Button, Overlay } from "./components";
import type { MaintenanceSummary } from "./data";

export default function MaintenanceSettings({
  summary,
  close,
  saved,
}: {
  summary: MaintenanceSummary;
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
              ["normalHours", "正常渠道 / 小时", 1],
              ["maintenanceHours", "维护渠道 / 小时", 1],
              ["closedHours", "关闭网站 / 小时", 1],
              ["keyRetryHours", "key 复查 / 小时", 1],
              ["archiveAfterDays", "持续故障归档 / 天", 1, 365],
              ["archiveReviewHours", "归档后复查 / 小时", 24, 8760],
              ["newModelsHours", "模型复验 / 小时", 1],
              ["maxCandidates", "每渠道每轮候选", 1, 20],
              ["maxEvaluationsPerDay", "每日任务次数上限", 1, 500],
              ["smokeMaxTokens", "小任务输出 Token 上限", 256, 4096],
            ] as const
          ).map(([key, label, min, max]) => (
            <label key={key}>
              {label}
              <input
                type="number"
                min={min}
                max={max}
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
