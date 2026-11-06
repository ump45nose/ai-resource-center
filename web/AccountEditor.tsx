import { useState, type FormEvent } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { api, conflictText, isVersionConflict, saveError } from "./api";
import { Button } from "./components";
import { amount, lines, type Account } from "./data";
import SyncStatus from "./SyncStatus";

type HubIntegration = {
  state: string;
  extension?: {
    name: string;
    checkinUrl: string | null;
    automaticExecutionEnabled: boolean;
    disabled: boolean;
  } | null;
  automaticCheckin?: {
    automaticExecutionEnabled: boolean | null;
    reason: "archived" | "delegated" | "restored" | null;
  };
};
const writeBack = {
  archived: "签到已归档，中心要求插件停止自动签到",
  delegated: "由独立签到账号执行，中心要求插件停止本账号自动签到",
  restored: "归档或代签已解除，中心要求插件恢复自动签到",
};

function HubValues({ hub }: { hub: HubIntegration }) {
  const values = hub.extension;
  const reason = hub.automaticCheckin?.reason;
  return (
    <p className="rule-line">
      {values
        ? `插件中：${values.name} · 签到入口 ${values.checkinUrl || "插件默认"} · 自动签到${values.automaticExecutionEnabled ? "开启" : "关闭"} · ${values.disabled ? "已停用" : "已启用"}`
        : "插件中：等待插件回报当前资料"}
      。名称、地址、签到入口和启停以插件为准；
      {reason ? writeBack[reason] : "中心不回写，只在归档或代签时停止或恢复自动签到"}
    </p>
  );
}

export default function AccountEditor({
  account: a,
  conflict,
  setConflict,
  refresh,
  notify,
}: {
  account: Account;
  conflict: boolean;
  setConflict: (id: string) => void;
  refresh: () => Promise<void>;
  notify: (s: string) => void;
}) {
  const [open, setOpen] = useState(conflict),
    [error, setError] = useState(conflict ? conflictText : ""),
    [busy, setBusy] = useState(false);
  const hub = (a as Account & { integration?: HubIntegration }).integration;
  const linked = hub?.state === "linked";
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError("");
    setConflict("");
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
      if (isVersionConflict(e)) setConflict(a.id);
      setError(await saveError(e, refresh));
    } finally {
      setBusy(false);
    }
  }
  return (
    <article className="management-card">
      <button
        className="management-card-heading"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        <strong>{a.name}</strong>
        <span>{amount(a.balance, a.unit)}</span>
        <span className="text-link">编辑权益</span>
      </button>
      {hub?.state === "linked" && <HubValues hub={hub} />}
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
              中心启停{linked && "（不写回插件）"}
              <select
                name="pluginState"
                defaultValue={
                  a.enabled == null ? "inherit" : a.enabled ? "yes" : "no"
                }
              >
                <option value="inherit">跟随插件</option>
                <option value="yes">启用</option>
                <option value="no">停用</option>
              </select>
            </label>
            <label>
              签到需求{linked && "（不写回插件）"}
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
                <option value="inherit">跟随插件</option>
                <option value="yes">需要签到</option>
                <option value="no">无需签到</option>
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
