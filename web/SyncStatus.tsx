import { useState } from "react";
import { api, errorText } from "./api";
import { Badge, Button } from "./components";
import { syncStateLabels } from "./data";
import { usePolling } from "./hooks";

type Job = {
  id: string;
  target: string;
  state: string;
  reason?: string;
  appliedAt?: string;
};
const targetLabels: Record<string, string> = {
  newapi: "New API · 渠道配置",
  "all-api-hub": "All API Hub · 账号与签到",
  notion: "Notion",
  "chrome-bookmarks": "Chrome 书签",
};

export default function SyncStatus({ subject }: { subject: string }) {
  const [diff, setDiff] = useState<{
    id: string;
    changes: { field: string; center: unknown; target: unknown }[];
  } | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]),
    [error, setError] = useState("");
  const read = () =>
    api<{ items: Job[] }>(
      `/sync/jobs?subject=${encodeURIComponent(subject)}`,
    ).then((x) =>
      setJobs(
        x.items.filter(
          (j, i, a) => a.findIndex((y) => y.target === j.target) === i,
        ),
      ),
    );
  usePolling(
    (first) => void read().catch((e) => first && setError(errorText(e))),
    subject,
  );
  const act = async (j: Job, path: string, body?: unknown) => {
    try {
      await api(`/sync/jobs/${j.id}/${path}`, "POST", body);
      await read();
      setError("");
    } catch (e) {
      setError(errorText(e));
    }
  };
  return (
    <div className="sync-status">
      {jobs.map((j) => (
        <div className="sync-status-row" key={j.id}>
          <span>{targetLabels[j.target]}</span>
          <Badge
            tone={
              j.state === "applied"
                ? "green"
                : j.state === "conflict" || j.state === "failed"
                  ? "amber"
                  : "neutral"
            }
          >
            {syncStateLabels[j.state] || j.state}
          </Badge>
          {j.reason && <small>{j.reason}</small>}
          {j.state === "conflict" ? (
            <div className="form-actions">
              <Button
                variant="ghost"
                onClick={() =>
                  void api<{
                    id: string;
                    changes: {
                      field: string;
                      center: unknown;
                      target: unknown;
                    }[];
                  }>(`/sync/jobs/${j.id}/diff`)
                    .then(setDiff)
                    .catch((e) => setError(errorText(e)))
                }
              >
                查看差异
              </Button>

              <Button
                variant="ghost"
                onClick={() => void act(j, "resolve", { choice: "target" })}
              >
                采用目标配置
              </Button>
              <Button
                variant="ghost"
                onClick={() => void act(j, "resolve", { choice: "center" })}
              >
                恢复中心配置
              </Button>
            </div>
          ) : (
            ["failed", "waiting"].includes(j.state) && (
              <Button variant="ghost" onClick={() => void act(j, "retry")}>
                重试
              </Button>
            )
          )}
        </div>
      ))}
      {diff && (
        <div className="sync-diff">
          <div className="form-actions">
            <strong>中心 / 目标</strong>
            <Button variant="ghost" onClick={() => setDiff(null)}>
              收起
            </Button>
          </div>
          {diff.changes.map((d) => (
            <div key={d.field}>
              <strong>
                {(
                  {
                    name: "名称",
                    base_url: "API 地址",
                    baseUrl: "API 地址",
                    models: "模型",
                    status: "启停",
                    enabled: "启用",
                    checkinUrl: "签到入口",
                    automaticExecutionEnabled: "自动签到",
                    disabled: "账号停用",
                    order: "排序",
                    protocol: "协议",
                  } as Record<string, string>
                )[d.field] || d.field}
              </strong>
              <span>
                {typeof d.center === "object"
                  ? JSON.stringify(d.center)
                  : String(d.center ?? "—")}
              </span>
              <span>
                {typeof d.target === "object"
                  ? JSON.stringify(d.target)
                  : String(d.target ?? "—")}
              </span>
            </div>
          ))}
        </div>
      )}
      {!jobs.length && <small>已保存到中心 · 目标接管后自动同步</small>}
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
