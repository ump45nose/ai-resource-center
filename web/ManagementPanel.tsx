import { useEffect, useState, type FormEvent } from "react";
import { ArrowUpRight, ChevronDown, ChevronRight } from "lucide-react";
import { api } from "./api";
import { Badge, Button, Overlay } from "./components";
import {
  archiveLabels,
  usageLabels,
  tagLabels,
  amount,
  dateTime,
  type Site,
  type Channel,
  type Account,
  type ChannelTag,
  type ChannelUsage,
} from "./data";

const failure = (e: unknown) => (e instanceof Error ? e.message : "操作未完成");
const lines = (s: string) =>
  s
    .split(/\n|,/)
    .map((x) => x.trim())
    .filter(Boolean);
const stateLabels: Record<string, string> = {
  pending: "待同步",
  running: "同步中",
  applied: "已同步",
  failed: "同步失败",
  conflict: "配置冲突",
  waiting: "等待条件",
  not_applicable: "无需接入",
};
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
  sillytavern: "酒馆",
  notion: "Notion",
  "chrome-bookmarks": "Chrome 书签",
};

export function SyncStatus({ subject }: { subject: string }) {
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
  useEffect(() => {
    void read().catch((e) => setError(failure(e)));
    const t = setInterval(() => void read().catch(() => {}), 10000);
    return () => clearInterval(t);
  }, [subject]);
  const act = async (j: Job, path: string, body?: unknown) => {
    try {
      await api(`/sync/jobs/${j.id}/${path}`, "POST", body);
      await read();
      setError("");
    } catch (e) {
      setError(failure(e));
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
            {stateLabels[j.state] || j.state}
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
                    .catch((e) => setError(failure(e)))
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

export default function ManagementPanel({
  site,
  close,
  refresh,
  notify,
}: {
  site: Site;
  close: () => void;
  refresh: () => Promise<void>;
  notify: (s: string) => void;
}) {
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function saveSite(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError("");
    try {
      await api(`/sites/${site.id}`, "PATCH", {
        version: site.version,
        changes: {
          name: f.get("name"),
          websiteUrl: f.get("url"),
          checkinUrl: f.get("checkin") || null,
          aliases: lines(String(f.get("aliases"))),
          note: f.get("note"),
        },
      });
      await refresh();
      notify("站点已保存，已接管目标会自动同步");
    } catch (e) {
      setError(failure(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Overlay title={site.name} subtitle="管理站点与连接" drawer onClose={close}>
      <div className="overlay-body management-panel">
        <form className="form-stack" key={site.version} onSubmit={saveSite}>
          <div className="form-grid">
            <label>
              站点名称
              <input name="name" required defaultValue={site.name} />
            </label>
            <label>
              网站地址
              <input
                name="url"
                type="url"
                required
                defaultValue={site.websiteUrl}
              />
            </label>
          </div>
          <label>
            签到入口
            <input
              name="checkin"
              type="url"
              defaultValue={site.checkinUrl || ""}
              placeholder="与网站分离时填写独立入口"
            />
          </label>
          <details>
            <summary>别名与备注</summary>
            <label>
              别名地址
              <textarea
                name="aliases"
                rows={2}
                defaultValue={(site.aliases || []).join("\n")}
                placeholder="每行一个地址"
              />
            </label>
            <label>
              备注
              <textarea name="note" rows={2} defaultValue={site.note || ""} />
            </label>
          </details>
          {error && (
            <p className="inline-error" role="alert">
              {error}
            </p>
          )}
          <div className="form-actions">
            <Button type="submit" variant="primary" disabled={busy}>
              保存站点
            </Button>
            <a
              className="text-link"
              href={site.websiteUrl}
              target="_blank"
              rel="noreferrer"
            >
              访问网站 <ArrowUpRight size={12} />
            </a>
          </div>
        </form>
        <section>
          <h3>账号与权益</h3>
          {site.accounts.map((a) => (
            <AccountEditor
              key={`${a.id}:${a.version}`}
              account={a}
              refresh={refresh}
              notify={notify}
            />
          ))}
        </section>
        <section>
          <h3>
            渠道连接 <span className="muted">{site.channels.length}</span>
          </h3>
          <NewChannel site={site} refresh={refresh} notify={notify} />
          {site.channels.map((c) => (
            <ChannelEditor
              key={`${c.id}:${c.version}`}
              channel={c}
              accounts={site.accounts}
              refresh={refresh}
              notify={notify}
            />
          ))}
        </section>
      </div>
    </Overlay>
  );
}
function NewChannel({
  site,
  refresh,
  notify,
}: {
  site: Site;
  refresh: () => Promise<void>;
  notify: (s: string) => void;
}) {
  const [open, setOpen] = useState(!site.channels.length),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError("");
    try {
      await api("/channels", "POST", {
        data: {
          siteId: site.id,
          accountId: f.get("accountId"),
          name: f.get("name"),
          baseUrl: f.get("baseUrl"),
          protocol: f.get("protocol"),
          usage: f.get("usage"),
        },
      });
      setOpen(false);
      await refresh();
      notify("渠道已添加，在凭据中填写或选择 key");
    } catch (e) {
      setError(failure(e));
    } finally {
      setBusy(false);
    }
  }
  if (!site.accounts.length)
    return <p className="muted">先接入站点账号，再配置调用渠道。</p>;
  if (!open) return <Button onClick={() => setOpen(true)}>添加渠道</Button>;
  return (
    <form className="form-stack" onSubmit={save}>
      <div className="form-grid">
        <label>
          渠道名称
          <input name="name" required defaultValue={site.name} />
        </label>
        <label>
          所属账号
          <select name="accountId" defaultValue={site.accounts[0].id}>
            {site.accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label>
        API 地址
        <input
          name="baseUrl"
          type="url"
          required
          defaultValue={site.websiteUrl}
        />
      </label>
      <div className="form-grid">
        <label>
          用途分组
          <select name="usage" defaultValue="general">
            {Object.entries(usageLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          协议
          <select name="protocol" defaultValue="OpenAI">
            {["OpenAI", "OpenAI Responses", "Anthropic", "Gemini"].map((p) => (
              <option key={p}>{p}</option>
            ))}
          </select>
        </label>
      </div>
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      <div className="form-actions">
        <Button type="submit" variant="primary" disabled={busy}>
          添加渠道
        </Button>
        <Button onClick={() => setOpen(false)} disabled={busy}>
          取消
        </Button>
      </div>
    </form>
  );
}
function AccountEditor({
  account: a,
  refresh,
  notify,
}: {
  account: Account;
  refresh: () => Promise<void>;
  notify: (s: string) => void;
}) {
  const [open, setOpen] = useState(false),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError("");
    try {
      await api(`/accounts/${a.id}`, "PATCH", {
        version: a.version,
        changes: {
          name: f.get("name"),
          quota: f.get("quota"),
          enabled:
            f.get("pluginState") === "inherit"
              ? null
              : f.get("pluginState") === "yes",
          checkinEnabled:
            f.get("checkin") === "inherit" ? null : f.get("checkin") === "yes",
          validUntil: f.get("expiry")
            ? new Date(String(f.get("expiry"))).toISOString()
            : null,
          benefit: {
            tz: f.get("tz"),
            resetAt: f.get("reset") || undefined,
            threshold: f.get("threshold") || undefined,
            validity: f.get("validity") || undefined,
            dailyLimit:
              f.get("dailyLimit") === ""
                ? undefined
                : Number(f.get("dailyLimit")),
            renewal: f.get("renewal") || undefined,
            releaseTimes: lines(String(f.get("release"))),
            windows: lines(String(f.get("windows"))).map((x) => {
              const [start, end] = x.split("~").map((v) => v.trim());
              return { start, end };
            }),
          },
        },
      });
      await refresh();
      notify("权益规则已保存");
    } catch (e) {
      setError(failure(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <article className="management-card">
      <button
        className="management-card-heading"
        onClick={() => setOpen(!open)}
      >
        {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        <strong>{a.name}</strong>
        <span>{amount(a.balance, a.unit)}</span>
        <span className="text-link">编辑权益</span>
      </button>
      {open && (
        <form className="form-stack" onSubmit={save}>
          <div className="form-grid">
            <label>
              账号名称
              <input name="name" required defaultValue={a.name} />
            </label>
            <label>
              每日基础额度
              <input
                name="dailyLimit"
                type="number"
                min="0"
                defaultValue={a.benefit?.dailyLimit ?? ""}
              />
            </label>
            <label>
              额度获取方式
              <select name="renewal" defaultValue={a.benefit?.renewal || ""}>
                <option value="">待确认</option>
                <option value="automatic">每日自动刷新</option>
                <option value="checkin">签到领取</option>
              </select>
            </label>
            <label>
              额度类型
              <select name="quota" defaultValue={a.quota || "long"}>
                <option value="long">长期额度</option>
                <option value="daily">当日额度</option>
              </select>
            </label>
            <label>
              插件账号
              <select
                name="pluginState"
                defaultValue={
                  a.enabled == null ? "inherit" : a.enabled ? "yes" : "no"
                }
              >
                <option value="inherit">保留插件启停</option>
                <option value="yes">启用</option>
                <option value="no">停用</option>
              </select>
            </label>
            <label>
              自动签到
              <select
                name="checkin"
                defaultValue={
                  a.checkinEnabled == null
                    ? "inherit"
                    : a.checkinEnabled
                      ? "yes"
                      : "no"
                }
              >
                <option value="inherit">保留插件设置</option>
                <option value="yes">启用</option>
                <option value="no">停用</option>
              </select>
            </label>
            <label>
              重置时区
              <input
                name="tz"
                defaultValue={a.benefit?.tz || "Asia/Shanghai"}
              />
            </label>
            <label>
              重置时间
              <input
                name="reset"
                type="time"
                defaultValue={a.benefit?.resetAt || ""}
              />
            </label>
            <label>
              签到余额门槛
              <input
                name="threshold"
                defaultValue={a.benefit?.threshold ?? ""}
              />
            </label>
          </div>
          <label>
            可用窗口（每行 HH:MM~HH:MM）
            <textarea
              name="windows"
              rows={2}
              defaultValue={(a.benefit?.windows || [])
                .map((w) => `${w.start}~${w.end}`)
                .join("\n")}
            />
          </label>
          <label>
            投放时刻（每行 HH:MM）
            <textarea
              name="release"
              rows={2}
              defaultValue={(a.benefit?.releaseTimes || []).join("\n")}
            />
          </label>
          <label>
            有效期说明
            <input name="validity" defaultValue={a.benefit?.validity || ""} />
          </label>
          <label>
            确定的到期时间
            <input
              name="expiry"
              type="datetime-local"
              defaultValue={
                a.validUntil
                  ? new Date(
                      Date.parse(a.validUntil) -
                        new Date().getTimezoneOffset() * 60000,
                    )
                      .toISOString()
                      .slice(0, 16)
                  : ""
              }
            />
          </label>
          {error && (
            <p className="inline-error" role="alert">
              {error}
            </p>
          )}
          <Button type="submit" disabled={busy}>
            保存权益
          </Button>
        </form>
      )}
      <SyncStatus subject={a.id} />
    </article>
  );
}
function ChannelEditor({
  channel: c,
  accounts,
  refresh,
  notify,
}: {
  channel: Channel;
  accounts: Account[];
  refresh: () => Promise<void>;
  notify: (s: string) => void;
}) {
  const [open, setOpen] = useState(c.credentialStatus === "missing"),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [tags, setTags] = useState<ChannelTag[]>(c.tags),
    [choices, setChoices] = useState<{ id: string; name: string }[]>([]),
    [action, setAction] = useState("");
  useEffect(() => {
    void api<{ items: { id: string; name: string }[] }>(
      `/channels/${c.id}/credentials`,
    )
      .then((x) => setChoices(x.items))
      .catch((e) => setError(failure(e)));
  }, [c.id]);
  const run = async (fn: () => Promise<unknown>, message: string) => {
    setBusy(true);
    setError("");
    try {
      await fn();
      await refresh();
      notify(message);
    } catch (e) {
      setError(failure(e));
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
            order: Number(f.get("order") || 0),
            note: f.get("note"),
            enabled: f.get("enabled") === "on",
            recoveryPolicy: { enabled: f.get("recovery") === "on" },
            mode: f.get("maintenanceMode") === "auto" ? "auto" : "manual",
            management: {
              ...c.management,
              fixed: f.get("maintenanceMode") === "fixed",
            },
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
            <div className="form-grid">
              <label>
                限定客户端
                <input
                  name="client"
                  defaultValue={c.client || c.clientRequirements?.client || ""}
                />
              </label>
              <label>
                酒馆排序
                <input
                  type="number"
                  name="order"
                  min="0"
                  defaultValue={c.order || 0}
                />
              </label>
            </div>
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
