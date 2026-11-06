import { useState, type FormEvent } from "react";
import { api, errorText, saveError } from "./api";
import { Badge, Button, Overlay, SectionHeading } from "./components";
import { dateTime } from "./data";
import { usePolling } from "./hooks";
import { useWorkspace } from "./workspace";
type Target = {
  id: string;
  name: string;
  version: number;
  enabled: boolean;
  sourceId?: string;
  databaseId?: string;
  dataSourceId?: string;
  rootId?: string;
  credentialStatus: string;
  adoptedAt?: string;
  lastAppliedAt?: string;
  counts: Record<string, number>;
};
type Preview = {
  previewId: string;
  target: string;
  browserReadbackRequired: boolean;
  rows: {
    subject: string;
    name: string;
    action: string;
    desired: { models?: string[]; baseUrl?: string; url?: string };
    current?: unknown;
  }[];
};
const labels: Record<string, string> = {
  create: "新增",
  update: "更新",
  disable: "停用",
  conflict: "冲突",
  keep: "保留现状",
  waiting_login: "待插件登录关联",
};
export default function SyncTargets() {
  const { sources, notify } = useWorkspace(),
    [targets, setTargets] = useState<Target[]>([]),
    [editId, setEditId] = useState(""),
    [preview, setPreview] = useState<Preview | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const edit = targets.find((t) => t.id === editId);
  const read = () =>
    api<{ items: Target[] }>("/sync/targets").then((x) => setTargets(x.items));
  usePolling(
    (first) => void read().catch((e) => first && setError(errorText(e))),
  );
  const act = async (id: string, fn: () => Promise<void>) => {
    setBusy(id);
    setError("");
    try {
      await fn();
      await read();
    } catch (e) {
      setError(await saveError(e, read));
    } finally {
      setBusy("");
    }
  };
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!edit) return;
    const f = new FormData(e.currentTarget);
    await act(edit.id, async () => {
      let next = await api<Target>(`/sync/targets/${edit.id}`, "PATCH", {
        version: edit.version,
        changes: Object.fromEntries(
          ["sourceId", "databaseId", "dataSourceId", "rootId"]
            .map((k) => [k, f.get(k)])
            .filter(([, v]) => v),
        ),
      });
      const key = f.get("secret");
      if (key)
        next = await api<Target>(`/sync/targets/${edit.id}/credential`, "PUT", {
          version: next.version,
          key,
        });
      setEditId("");
      notify("同步目标已保存，首次接管需要预览确认");
    });
  }
  async function pairing() {
    await act("pairing", async () => {
      const access = async (role: string, target?: string) =>
        (
          await api<{ token: string }>("/access", "POST", {
            role,
            sourceId: "all-api-hub",
            ...(target ? { target } : {}),
          })
        ).token;
      const token = await access("ingest"),
        connectorToken = await access("connector", "all-api-hub"),
        bookmarkToken = await access("connector", "chrome-bookmarks");
      const blob = new Blob(
          [
            JSON.stringify(
              { url: location.origin, token, connectorToken, bookmarkToken },
              null,
              2,
            ),
          ],
          { type: "application/json" },
        ),
        url = URL.createObjectURL(blob),
        a = document.createElement("a");
      a.href = url;
      a.download = "ai-resource-center-pairing.json";
      a.click();
      URL.revokeObjectURL(url);
      notify("配对文件已生成；导入 All API Hub 后启用所需同步功能");
    });
  }
  return (
    <section className="sync-targets">
      <SectionHeading
        title="配置分发与镜像"
        meta="中心保存整理结果，各工具独立执行并回报"
        action={
          <Button onClick={() => void pairing()} disabled={!!busy}>
            导出浏览器配对
          </Button>
        }
      />
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      <div className="source-grid">
        {targets.map((t) => (
          <article className="source-card" key={t.id}>
            <div className="source-card-top">
              <h3>{t.name}</h3>
              <Badge tone={t.enabled ? "green" : "neutral"}>
                {t.enabled ? "自动同步" : t.adoptedAt ? "已暂停" : "尚未接管"}
              </Badge>
            </div>
            <p className="muted">
              {t.id === "newapi"
                ? "渠道地址、模型、凭据及启停"
                : t.id === "all-api-hub"
                  ? "只回写自动签到启停 · 名称、地址与签到入口以插件为准"
                  : t.id === "notion"
                    ? "每站一条单向镜像 · 保留额外笔记"
                    : "原生书签增量同步 · 保留非托管收藏"}
            </p>
            <dl className="source-detail">
              <div>
                <dt>已同步</dt>
                <dd>
                  {t.counts.applied || 0} · {dateTime(t.lastAppliedAt)}
                </dd>
              </div>
              <div>
                <dt>等待处理</dt>
                <dd>
                  待同步 {t.counts.pending || 0} / 等待 {t.counts.waiting || 0}{" "}
                  / 失败 {t.counts.failed || 0} / 冲突 {t.counts.conflict || 0}
                  {t.counts.not_applicable
                    ? ` · 无需接入 ${t.counts.not_applicable}`
                    : ""}
                </dd>
              </div>
            </dl>
            <div className="form-actions">
              <Button
                aria-label={`设置：${t.name}`}
                onClick={() => setEditId(t.id)}
              >
                设置
              </Button>
              <Button
                disabled={!!busy}
                aria-label={`预览接管：${t.name}`}
                onClick={() =>
                  void act(t.id, async () => {
                    const p = await api<Preview>(
                      `/sync/targets/${t.id}/preview`,
                      "POST",
                      {},
                    );
                    setPreview(p);
                    setSelected(
                      p.rows
                        .filter((r) => ["create", "update"].includes(r.action))
                        .map((r) => r.subject),
                    );
                  })
                }
              >
                预览接管
              </Button>
              {t.adoptedAt && (
                <Button
                  variant="ghost"
                  disabled={!!busy}
                  aria-label={`${t.enabled ? "暂停" : "继续同步"}：${t.name}`}
                  onClick={() =>
                    void act(t.id, async () => {
                      await api(`/sync/targets/${t.id}`, "PATCH", {
                        version: t.version,
                        changes: { enabled: !t.enabled },
                      });
                    })
                  }
                >
                  {t.enabled ? "暂停" : "继续同步"}
                </Button>
              )}
            </div>
          </article>
        ))}
      </div>
      {edit && (
        <Overlay title={`${edit.name} 同步设置`} onClose={() => setEditId("")}>
          <form
            className="overlay-body form-stack"
            key={edit.version}
            onSubmit={save}
          >
            {["newapi", "all-api-hub"].includes(edit.id) && (
              <label>
                绑定来源
                <select
                  name="sourceId"
                  defaultValue={
                    edit.sourceId ||
                    sources.find((s) => s.kind === edit.id)?.id ||
                    ""
                  }
                >
                  <option value="">使用默认来源</option>
                  {sources
                    .filter((s) => s.kind === edit.id)
                    .map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                </select>
              </label>
            )}
            {edit.id === "notion" && (
              <>
                <label>
                  原有 API 清单数据库 ID
                  <input
                    name="databaseId"
                    defaultValue={edit.databaseId || ""}
                  />
                </label>
                <label>
                  数据源 ID（多数据源时填写）
                  <input
                    name="dataSourceId"
                    defaultValue={edit.dataSourceId || ""}
                  />
                </label>
                <label>
                  Notion 集成凭据
                  <input
                    name="secret"
                    type="password"
                    autoComplete="new-password"
                    placeholder={
                      edit.credentialStatus === "present"
                        ? "已保存；留空保留"
                        : "保存到 fn 加密凭据库"
                    }
                  />
                </label>
              </>
            )}
            {edit.id === "chrome-bookmarks" && (
              <>
                <label>
                  托管根目录 ID（留空则新建“公益站”）
                  <input name="rootId" defaultValue={edit.rootId || ""} />
                </label>
                <p className="muted">
                  在 All API Hub
                  中导入配对文件并单独开启书签同步；浏览器离线时任务保留。酒馆目录保持
                  RP 移出中心时的书签，之后在 Chrome 中自行维护。
                </p>
              </>
            )}
            {error && <p className="inline-error">{error}</p>}
            <Button type="submit" variant="primary" disabled={!!busy}>
              保存设置
            </Button>
          </form>
        </Overlay>
      )}
      {preview && (
        <Overlay
          title="首次接管预览"
          subtitle={targets.find((t) => t.id === preview.target)?.name}
          onClose={() => setPreview(null)}
        >
          <div className="overlay-body form-stack">
            <p>
              只接管勾选的项目，后续保存自动同步；未勾选的存量配置保持原状。
            </p>
            {preview.browserReadbackRequired && (
              <p className="muted">
                浏览器或插件执行时还会核对本地配置；缺少账号登录条件会等待，不会用调用
                key 创建登录账号。
              </p>
            )}
            <p className="muted">
              {Object.entries(labels)
                .map(
                  ([action, label]) =>
                    `${label} ${preview.rows.filter((r) => r.action === action).length}`,
                )
                .join(" · ")}
            </p>
            <div className="form-actions">
              <Button
                variant="ghost"
                onClick={() => setSelected(preview.rows.map((r) => r.subject))}
              >
                全选
              </Button>
              <Button variant="ghost" onClick={() => setSelected([])}>
                清空
              </Button>
              <span>已选择 {selected.length} 项 · 停用默认不勾选</span>
            </div>
            <div className="sync-preview-list">
              {preview.rows
                .filter((r) => r.action !== "keep")
                .map((r) => (
                  <div className="sync-preview-row" key={r.subject}>
                    <label className="sync-preview-selection">
                      <input
                        type="checkbox"
                        checked={selected.includes(r.subject)}
                        onChange={(e) =>
                          setSelected(
                            e.target.checked
                              ? [...selected, r.subject]
                              : selected.filter((id) => id !== r.subject),
                          )
                        }
                      />
                      <div>
                        <strong>{r.name}</strong>
                        <small>
                          {r.desired.baseUrl || r.desired.url}
                          {r.desired.models?.length
                            ? ` · ${r.desired.models.join("、")}`
                            : ""}
                        </small>
                      </div>
                    </label>
                    <Badge tone={r.action === "conflict" ? "amber" : "neutral"}>
                      {labels[r.action]}
                    </Badge>
                  </div>
                ))}
            </div>
            {error && <p className="inline-error">{error}</p>}
            <Button
              variant="primary"
              disabled={!!busy || !selected.length}
              onClick={() =>
                void act(preview.target, async () => {
                  await api(`/sync/targets/${preview.target}/confirm`, "POST", {
                    previewId: preview.previewId,
                    subjectIds: selected,
                  });
                  setPreview(null);
                  notify("已确认接管，配置已排队同步");
                })
              }
            >
              接管已选 {selected.length} 项
            </Button>
          </div>
        </Overlay>
      )}
    </section>
  );
}
