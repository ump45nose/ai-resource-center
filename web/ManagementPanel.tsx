import { useState, type FormEvent } from "react";
import { ArrowUpRight } from "lucide-react";
import { api, errorText, saveError } from "./api";
import { Button, Overlay } from "./components";
import { usageLabels, lines, type Site } from "./data";
import AccountEditor from "./AccountEditor";
import ChannelEditor from "./ChannelEditor";

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
    [busy, setBusy] = useState(false),
    [conflict, setConflict] = useState("");
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
      setError(await saveError(e, refresh));
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
              conflict={conflict === a.id}
              setConflict={setConflict}
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
              conflict={conflict === c.id}
              setConflict={setConflict}
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
      setError(errorText(e));
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
