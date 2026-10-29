import { useEffect, useState } from "react";
import { api, allPages } from "./api";
import { Badge, Button, SectionHeading } from "./components";
import { dateTime } from "./data";
type Item = {
  id: string;
  title: string;
  url: string;
  usage: string;
  state: string;
  reason?: string;
  updatedAt: string;
  attempts: number;
  api?: { available: boolean; reason?: string };
};
const labels: Record<string, string> = {
  pending_native: "等待浏览器导入",
  needs_model: "等待每日模型任务",
  model_running: "模型探查中",
  recipe_ready: "等待插件应用",
  waiting_sync: "等待账号回传",
  waiting_security: "浏览器安全拦截",
  waiting_login: "需要登录",
  imported: "已导入",
  existing: "中心已收录",
  unsupported: "需要接口适配",
  failed: "本轮未完成",
};
export default function BookmarkImports() {
  const [items, setItems] = useState<Item[]>([]),
    [error, setError] = useState("");
  const read = () => allPages<Item>("/bookmark-imports").then(setItems);
  useEffect(() => {
    void read().catch((e) => setError(e.message));
    const t = setInterval(() => void read().catch(() => {}), 10000);
    return () => clearInterval(t);
  }, []);
  const rows = items.filter((i) => i.state !== "existing");
  return (
    <section className="sync-targets">
      <SectionHeading
        title="收藏夹新增渠道"
        meta="酒馆、生图新增书签自动导入；未完成项由每日任务处理。"
      />
      {error && <p className="inline-error">{error}</p>}
      {!rows.length ? (
        <p className="muted">暂时没有新增渠道。</p>
      ) : (
        <div className="scan-table-wrap">
          <table className="scan-table">
            <thead>
              <tr>
                <th>站点</th>
                <th>用途</th>
                <th>进度</th>
                <th>最近处理</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((i) => (
                <tr key={i.id}>
                  <td>
                    <a href={i.url} target="_blank" rel="noreferrer">
                      {i.title}
                    </a>
                    <p className="muted">{i.reason || i.api?.reason}</p>
                  </td>
                  <td>{i.usage === "rp" ? "酒馆" : "生图"}</td>
                  <td>
                    <Badge>{labels[i.state] || i.state}</Badge>
                    {i.api?.available === false && (
                      <p className="muted">API：{i.api.reason}</p>
                    )}
                  </td>
                  <td>{dateTime(i.updatedAt)}</td>
                  <td>
                    {!["imported", "model_running"].includes(i.state) && (
                      <Button
                        onClick={() =>
                          void api(
                            `/bookmark-imports/${i.id}/retry`,
                            "POST",
                            {},
                          )
                            .then(read)
                            .catch((e) => setError(e.message))
                        }
                      >
                        重试导入
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
