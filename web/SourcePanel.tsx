import { useState, type FormEvent } from "react";
import { api, saveError } from "./api";
import { Button, Overlay } from "./components";
import { dateTime, type Source } from "./data";
import HubSourcePanel from "./HubSourcePanel";
import { useWorkspace } from "./workspace";

export default function SourcePanel({
  source,
  close,
  saved,
}: {
  source?: Source;
  close: () => void;
  saved: () => Promise<void>;
}) {
  const [error, setError] = useState("");
  if (source?.kind === "all-api-hub")
    return <HubSourcePanel source={source} close={close} />;
  if (source && source.kind !== "newapi")
    return (
      <Overlay title={source.name} onClose={close}>
        <div className="overlay-body">
          <p>现有资料与上报历史已保留。此来源的新版持续接入在下一批完成。</p>
          <dl className="detail-status">
            <div>
              <dt>最近收到</dt>
              <dd>{dateTime(source.receivedAt || source.last)}</dd>
            </div>
          </dl>
        </div>
      </Overlay>
    );
  return (
    <Overlay
      title={source ? "New API 接入设置" : "接入 New API"}
      onClose={close}
    >
      <SourceForm
        key={source?.version}
        source={source}
        close={close}
        saved={saved}
        error={error}
        setError={setError}
      />
    </Overlay>
  );
}

function SourceForm({
  source,
  close,
  saved,
  error,
  setError,
}: {
  source?: Source;
  close: () => void;
  saved: () => Promise<void>;
  error: string;
  setError: (error: string) => void;
}) {
  const { refresh } = useWorkspace();
  const [name, setName] = useState(source?.name || "New API");
  const [url, setUrl] = useState(source?.url || "");
  const [userId, setUserId] = useState(String(source?.userId || 1));
  const [key, setKey] = useState("");
  const [minutes, setMinutes] = useState(source?.inventoryMinutes || 10);
  const [calls, setCalls] = useState(source?.callsMinutes || 1);
  const [auto, setAuto] = useState(source?.syncEnabled || false);
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const data = {
        name: name.trim(),
        kind: "newapi",
        url: url.trim(),
        userId: Number(userId),
        syncEnabled: auto,
        inventoryMinutes: minutes,
        callsMinutes: calls,
      };
      let s = source
        ? await api<Source>(`/sources/${source.id}`, "PATCH", {
            version: source.version,
            changes: data,
          })
        : await api<Source>("/sources", "POST", { data });
      if (key)
        s = await api<Source>(`/sources/${s.id}/credential`, "PUT", {
          version: s.version,
          key,
        });
      setKey("");
      await saved();
    } catch (e) {
      setError(await saveError(e, refresh));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="overlay-body form-stack" onSubmit={submit}>
      <label>
        显示名称
        <input
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <label>
        服务地址
        <input
          type="url"
          required
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="http://192.168.31.201:3000"
        />
      </label>
      <label>
        管理用户 ID
        <input
          type="number"
          min="1"
          required
          value={userId}
          onChange={(e) => setUserId(e.target.value)}
        />
      </label>
      <label>
        管理访问凭据
        <input
          type="password"
          autoComplete="off"
          required={!source}
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder={
            source?.credentialStatus === "present"
              ? "已保存，留空保持不变"
              : "填写管理访问凭据"
          }
        />
        <small>仅保存在 fn；更换服务地址时需重新填写。</small>
      </label>
      <div className="form-columns">
        <label>
          配置同步间隔（分钟）
          <input
            type="number"
            min="1"
            max="1440"
            required
            value={minutes}
            onChange={(e) => setMinutes(Number(e.target.value))}
          />
        </label>
        <label>
          调用同步间隔（分钟）
          <input
            type="number"
            min="1"
            max="1440"
            required
            value={calls}
            onChange={(e) => setCalls(Number(e.target.value))}
          />
        </label>
      </div>
      <label className="checkbox-label">
        <input
          type="checkbox"
          disabled={!source?.lastInventoryAt}
          checked={auto}
          onChange={(e) => setAuto(e.target.checked)}
        />
        自动同步渠道配置和调用记录
      </label>
      <p className="form-hint">来源同步不会开启模型测试或修改网关。</p>
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      <div className="form-actions">
        <Button onClick={close}>取消</Button>
        <Button type="submit" variant="primary" disabled={busy}>
          {busy ? "保存中…" : "保存接入设置"}
        </Button>
      </div>
    </form>
  );
}
