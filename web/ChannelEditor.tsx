import { useEffect, useState, type FormEvent } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import {
  api,
  conflictText,
  errorText,
  isVersionConflict,
  saveError,
} from "./api";
import { Badge, Button } from "./components";
import {
  archiveLabels,
  usageLabels,
  tagLabels,
  dateTime,
  lines,
  type Channel,
  type Account,
  type ChannelTag,
  type ChannelUsage,
} from "./data";
import SyncStatus from "./SyncStatus";

export default function ChannelEditor({
  channel: c,
  accounts,
  conflict,
  setConflict,
  refresh,
  notify,
}: {
  channel: Channel;
  accounts: Account[];
  conflict: boolean;
  setConflict: (id: string) => void;
  refresh: () => Promise<void>;
  notify: (s: string) => void;
}) {
  const [open, setOpen] = useState(
      conflict || c.credentialStatus === "missing",
    ),
    [error, setError] = useState(conflict ? conflictText : ""),
    [busy, setBusy] = useState(false),
    [tags, setTags] = useState<ChannelTag[]>(c.tags),
    [choices, setChoices] = useState<{ id: string; name: string }[]>([]),
    [action, setAction] = useState("");
  useEffect(() => {
    void api<{ items: { id: string; name: string }[] }>(
      `/channels/${c.id}/credentials`,
    )
      .then((x) => setChoices(x.items))
      .catch((e) => setError(errorText(e)));
  }, [c.id]);
  const run = async (fn: () => Promise<unknown>, message: string) => {
    setBusy(true);
    setError("");
    setConflict("");
    try {
      await fn();
      await refresh();
      notify(message);
    } catch (e) {
      if (isVersionConflict(e)) setConflict(c.id);
      setError(await saveError(e, refresh));
    } finally {
      setBusy(false);
    }
  };
  function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget),
      usage = f.get("usage") as ChannelUsage;
    void run(
      () =>
        api(`/channels/${c.id}`, "PATCH", {
          version: c.version,
          changes: {
            name: f.get("name"),
            accountId: f.get("accountId"),
            baseUrl: f.get("base"),
            protocol: f.get("protocol"),
            usage,
            capabilities:
              usage === "image"
                ? ["image"]
                : usage === "video"
                  ? ["video"]
                  : ["text"],
            models: lines(String(f.get("models"))),
            ...(f.get("replaceHeaders") === "on"
              ? {
                  headers: String(f.get("headerValues"))
                    .split("\n")
                    .filter((line) => line.trim())
                    .map((line) => {
                      const at = line.indexOf(":");
                      return {
                        name: line.slice(0, at).trim(),
                        value: line.slice(at + 1).trim(),
                      };
                    }),
                }
              : {}),
            tags,
            client: f.get("client") || "",
            note: f.get("note"),
            enabled: f.get("enabled") === "on",
            recoveryPolicy: { enabled: f.get("recovery") === "on" },
            mode: f.get("maintenanceMode") === "auto" ? "auto" : "manual",
            management: { fixed: f.get("maintenanceMode") === "fixed" },
          },
        }),
      "渠道已保存；新模型等待验证后生效",
    );
  }
  function keySave(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget),
      key = String(f.get("newKey") || "").trim(),
      choiceId = f.get("choice");
    void run(
      () =>
        key
          ? api(`/channels/${c.id}/credential`, "PUT", {
              version: c.version,
              key,
            })
          : api(`/channels/${c.id}/credentials/select`, "POST", {
              version: c.version,
              choiceId,
            }),
      "调用 key 已加密保存，归档状态保留",
    );
  }
  function lifecycle(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    void run(
      () =>
        api(`/channels/${c.id}/lifecycle`, "POST", {
          version: c.version,
          action,
          reason: action === "archive" ? f.get("reason") : undefined,
          note: f.get("archiveNote") || "",
          recoveryEnabled: f.get("auto") === "on",
        }),
      "管理状态已保存",
    );
  }
  return (
    <article className="management-card">
      <button
        className="management-card-heading"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        <strong>{c.name}</strong>
        <Badge>{usageLabels[c.usage]}</Badge>
        <Badge tone={c.credentialStatus === "missing" ? "amber" : "neutral"}>
          {c.credentialStatus === "missing" ? "待补 key" : "凭据已关联"}
        </Badge>
        <span className="text-link">编辑</span>
      </button>
      <a
        className="site-link mono"
        href={c.baseUrl}
        target="_blank"
        rel="noreferrer"
      >
        {c.baseUrl}
      </a>
      {c.archiveReasons.length > 0 && (
        <p className="rule-line">
          归档：{c.archiveReasons.map((x) => archiveLabels[x]).join("、")}{" "}
          {c.archiveNote}
        </p>
      )}
      {c.management?.state === "paused" && (
        <p className="rule-line">人工暂停 · 不会自动恢复</p>
      )}
      {open && (
        <>
          <form className="form-stack" onSubmit={save}>
            <div className="form-grid">
              <label>
                渠道名称
                <input name="name" required defaultValue={c.name} />
              </label>
              <label>
                自动维护
                <select
                  name="maintenanceMode"
                  defaultValue={
                    c.management?.fixed ? "fixed" : c.mode || "manual"
                  }
                >
                  <option value="auto">自动验证、恢复与调权</option>
                  <option value="manual">人工管理</option>
                  <option value="fixed">人工固定 · 不自动调整</option>
                </select>
              </label>
              <label>
                用途分组
                <select name="usage" defaultValue={c.usage}>
                  {Object.entries(usageLabels).map(([v, l]) => (
                    <option key={v} value={v}>
                      {l}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                API 地址
                <input
                  name="base"
                  type="url"
                  required
                  defaultValue={c.baseUrl}
                />
              </label>
              <label>
                协议
                <select name="protocol" defaultValue={c.protocol}>
                  {["OpenAI", "OpenAI Responses", "Anthropic", "Gemini"].map(
                    (v) => (
                      <option key={v}>{v}</option>
                    ),
                  )}
                </select>
              </label>
            </div>
            <label>
              所属账号
              <select name="accountId" defaultValue={c.accountId}>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              选定模型（每行一个）
              <textarea
                name="models"
                rows={3}
                defaultValue={c.models.join("\n")}
              />
            </label>
            <details>
              <summary>兼容请求头</summary>
              <label className="check-row">
                <input name="replaceHeaders" type="checkbox" />
                替换当前请求头（不勾选则保留）
              </label>
              <label>
                每行 Header-Name: value
                <textarea
                  name="headerValues"
                  rows={3}
                  placeholder="anthropic-beta: ..."
                />
              </label>
              <p className="muted">认证由凭据管理；不回显已保存的请求头值。</p>
            </details>
            <fieldset className="tag-options">
              <legend>限制标签</legend>
              {Object.entries(tagLabels).map(([tag, label]) => (
                <label key={tag}>
                  <input
                    type="checkbox"
                    checked={tags.includes(tag as ChannelTag)}
                    onChange={(e) =>
                      setTags(
                        e.target.checked
                          ? [...tags, tag as ChannelTag]
                          : tags.filter((t) => t !== tag),
                      )
                    }
                  />
                  {label}
                </label>
              ))}
            </fieldset>
            <label>
              限定客户端
              <input
                name="client"
                defaultValue={c.client || c.clientRequirements?.client || ""}
              />
            </label>
            <label>
              备注
              <textarea name="note" rows={2} defaultValue={c.note || ""} />
            </label>
            <div className="check-row">
              <label>
                <input
                  name="enabled"
                  type="checkbox"
                  defaultChecked={c.enabled}
                />
                启用连接（归档仍需验证恢复）
              </label>
              <label>
                <input
                  name="recovery"
                  type="checkbox"
                  defaultChecked={c.recoveryPolicy?.enabled !== false}
                />
                参与自动复查
              </label>
            </div>
            <Button type="submit" variant="primary" disabled={busy}>
              保存渠道
            </Button>
          </form>
          <details
            className="credential-editor"
            open={c.credentialStatus === "missing"}
          >
            <summary>
              调用 key ·{" "}
              {c.credentialStatus === "present"
                ? "保存在 fn 加密凭据库"
                : "待关联"}
            </summary>
            <form className="form-stack" onSubmit={keySave}>
              <label>
                选择同账号已有 key
                <select name="choice" defaultValue="">
                  <option value="">选择已保存的凭据</option>
                  {choices.map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                或填写／替换 key
                <input
                  name="newKey"
                  type="password"
                  autoComplete="new-password"
                  placeholder="保存后不回显明文"
                />
              </label>
              <Button type="submit" disabled={busy}>
                保存 key 关联
              </Button>
            </form>
          </details>
          <details>
            <summary>归档与停用</summary>
            <form className="form-stack" onSubmit={lifecycle}>
              <label>
                操作
                <select
                  required
                  value={action}
                  onChange={(e) => setAction(e.target.value)}
                >
                  <option value="">选择操作</option>
                  <option value="archive">归档，可定期复查</option>
                  <option value="pause">人工暂停，不自动启用</option>
                  {c.management?.state === "paused" && (
                    <option value="resume">解除人工暂停</option>
                  )}
                  <option value="review">重新进入验证，暂不启用</option>
                  <option value="remove">永久移除，不自动恢复</option>
                </select>
              </label>
              {action === "archive" && (
                <>
                  <label>
                    问题类型
                    <select
                      name="reason"
                      defaultValue={c.archiveReasons[0] || "maintenance"}
                    >
                      {Object.entries(archiveLabels).map(([v, l]) => (
                        <option key={v} value={v}>
                          {l}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    说明
                    <textarea
                      name="archiveNote"
                      rows={2}
                      defaultValue={c.archiveNote || ""}
                    />
                  </label>
                  <label>
                    <input type="checkbox" name="auto" defaultChecked />
                    参与自动恢复
                  </label>
                </>
              )}
              {action === "remove" && (
                <label>
                  <input required type="checkbox" />
                  确认永久移除，保留历史
                </label>
              )}
              <Button type="submit" disabled={busy || !action}>
                确认操作
              </Button>
            </form>
          </details>
        </>
      )}
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      <SyncStatus subject={c.id} />
      <div className="management-footnote">
        {c.recovery.waitingFor || c.recovery.reason || "未归档"}
        {c.recovery.nextCheckAt &&
          ` · 下次检查 ${dateTime(c.recovery.nextCheckAt)}`}
      </div>
    </article>
  );
}
