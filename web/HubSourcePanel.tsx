import { useState } from "react";
import { Button, Overlay } from "./components";
import { api, errorText } from "./api";
import { dateTime, type Source } from "./data";

export default function HubSourcePanel({
  source,
  close,
}: {
  source: Source;
  close: () => void;
}) {
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function create() {
    setBusy(true);
    setError("");
    try {
      setToken(
        (
          await api<{ token: string }>("/access", "POST", {
            role: "ingest",
            sourceId: source.id,
          })
        ).token,
      );
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  function download() {
    const url = URL.createObjectURL(
      new Blob(
        [
          JSON.stringify(
            {
              url: location.origin,
              token,
              sourceId: source.id,
              role: "ingest",
            },
            null,
            2,
          ),
        ],
        { type: "application/json" },
      ),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = "all-api-hub-center-access.json";
    a.click();
    URL.revokeObjectURL(url);
  }
  return (
    <Overlay title="接入 All API Hub" onClose={close}>
      <div className="overlay-body form-stack">
        <p>在插件「设置 → 通知 → AI 资源中心」导入接入文件，保存并同步。</p>
        <dl className="detail-status">
          <div>
            <dt>中心地址</dt>
            <dd>{location.origin}</dd>
          </div>
          <div>
            <dt>最近收到</dt>
            <dd>{dateTime(source.receivedAt)}</dd>
          </div>
        </dl>
        {source.hubSync?.lastInventoryAt && (
          <p>
            已接入 {source.hubSync.accounts} 个账号、
            {source.hubSync.credentials} 把调用
            key。账号、余额和签到跟随原有操作更新。
          </p>
        )}
        {!token ? (
          <Button variant="primary" onClick={create} disabled={busy}>
            生成插件接入文件
          </Button>
        ) : (
          <>
            <label>
              仅上报凭据
              <input type="password" readOnly value={token} />
            </label>
            <Button variant="primary" onClick={download}>
              下载接入文件
            </Button>
            <p className="form-hint">
              文件用于配对插件，请保存在私人目录。关闭此窗口后不再显示此凭据。
            </p>
          </>
        )}
        {error && (
          <p role="alert" className="inline-error">
            {error}
          </p>
        )}
      </div>
    </Overlay>
  );
}
