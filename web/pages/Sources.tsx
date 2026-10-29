import { useRef, useState } from "react";
import BookmarkImports from "../BookmarkImports";
import SyncTargets from "../SyncTargets";
import {
  ArrowRight,
  ArrowUpRight,
  Blocks,
  Cable,
  Database,
  RefreshCw,
} from "lucide-react";
import { Badge, Button, Overlay, SectionHeading } from "../components";
import { api } from "../api";
import { dateTime, sourceLabel, type Operation, type Source } from "../data";
import { useWorkspace } from "../workspace";

export default function Sources() {
  const {
    sources,
    query,
    configureSource,
    sourceAction,
    refresh,
    notify,
    operations,
  } = useWorkspace();
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<{
    source: Source;
    op: Operation;
  } | null>(null);
  const rank = (s: Source) =>
    s.kind === "newapi" ? 0 : s.kind === "all-api-hub" ? 1 : 2;
  const rows = sources
    .filter(
      (s) =>
        s.kind !== "cron" &&
        `${s.name} ${s.url} ${s.kind}`
          .toLowerCase()
          .includes(query.toLowerCase()),
    )
    .sort((a, b) => rank(a) - rank(b));
  const visibleOperations = operations.filter(
    (o) =>
      ["check", "preview"].includes(o.kind) ||
      (o.kind === "sync" &&
        o.input.sourceId !== "cpa" &&
        (o.state !== "succeeded" ||
          (o.result?.calls || 0) > 0 ||
          o.result?.channels?.some((c) =>
            ["created", "updated", "absent"].includes(c.result),
          ))),
  );
  async function act(s: Source, kind: "check" | "preview" | "sync") {
    setBusy(s.id);
    setError("");
    try {
      const op = await sourceAction(s, kind);
      if (kind === "preview" && op.state === "succeeded")
        setPreview({ source: s, op });
      else
        notify(
          op.state === "succeeded"
            ? kind === "check"
              ? "授权有效，未发起模型请求"
              : "来源同步完成"
            : "操作已提交，可在下方查看进度",
        );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }
  async function toggle(s: Source) {
    setBusy(s.id);
    setError("");
    try {
      await api(`/sources/${s.id}`, "PATCH", {
        version: s.version,
        changes: { syncEnabled: !s.syncEnabled },
      });
      await refresh();
      notify(
        s.syncEnabled ? "已暂停自动同步，现有调用不受影响" : "已开启自动同步",
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }
  return (
    <>
      {error && (
        <div className="inline-error" role="alert">
          {error}
        </div>
      )}
      <div className="source-grid">
        {rows.map((s) => {
          const pull = s.kind === "newapi";
          const hub = s.kind === "all-api-hub" && !!s.hubSync?.lastInventoryAt;
          const stale =
            hub && Date.now() - Date.parse(s.receivedAt || "") > 45 * 60000;
          const issue =
            s.inventoryError || s.callsError || s.authorizationError;
          return (
            <article className="source-card" key={s.id}>
              <div className="source-card-top">
                <span
                  className={`source-mark ${s.kind === "all-api-hub" ? "clay" : "blue"}`}
                >
                  {s.kind === "all-api-hub" ? (
                    <Blocks size={23} />
                  ) : pull ? (
                    <Database size={23} />
                  ) : (
                    <Cable size={23} />
                  )}
                </span>
                <Badge
                  tone={
                    issue
                      ? "amber"
                      : (pull && s.lastInventoryAt) || (hub && !stale)
                        ? "green"
                        : "neutral"
                  }
                >
                  {issue
                    ? "同步待处理"
                    : pull
                      ? s.lastInventoryAt
                        ? s.syncEnabled
                          ? "自动同步"
                          : "手动同步"
                        : "等待首次同步"
                      : hub
                        ? stale
                          ? "最近未上报"
                          : "插件持续上报"
                        : "历史已迁入"}
                </Badge>
              </div>
              <span className="eyebrow">
                {sourceLabel(s.kind)}
                {s.platformVersion && ` · ${s.platformVersion}`}
              </span>
              <h2>{s.name}</h2>
              {s.url && (
                <a
                  className="source-address text-link mono"
                  href={s.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  {s.url}
                  <ArrowUpRight size={12} />
                </a>
              )}
              <div className="source-scopes">
                {(pull
                  ? ["渠道配置", "模型列表", "调用日志"]
                  : s.kind === "all-api-hub"
                    ? ["账号资料", "余额观察", "签到历史", "调用 key"]
                    : ["酒馆连接", "被动调用记录"]
                ).map((l) => (
                  <span key={l}>{l}</span>
                ))}
              </div>
              <dl className="source-detail">
                {pull ? (
                  <>
                    <div>
                      <dt>授权</dt>
                      <dd>
                        {s.credentialStatus === "present"
                          ? "凭据已保存"
                          : "待配置"}
                        {s.checkedAt && ` · ${dateTime(s.checkedAt)}`}
                      </dd>
                    </div>
                    <div>
                      <dt>渠道配置</dt>
                      <dd>{dateTime(s.lastInventoryAt)}</dd>
                    </div>
                    <div>
                      <dt>调用记录</dt>
                      <dd>{dateTime(s.lastCallsAt)}</dd>
                    </div>
                    <div>
                      <dt>同步间隔</dt>
                      <dd>
                        配置 {s.inventoryMinutes || 10} 分钟 / 调用{" "}
                        {s.callsMinutes || 1} 分钟
                      </dd>
                    </div>
                  </>
                ) : (
                  <>
                    <div>
                      <dt>最近收到</dt>
                      <dd>{dateTime(s.receivedAt || s.last)}</dd>
                    </div>
                    <div>
                      <dt>持续上报</dt>
                      <dd>
                        {s.kind === "all-api-hub"
                          ? hub
                            ? "插件更新后交付，离线自动补交"
                            : "在插件设置中配对中心"
                          : "新版适配待接入"}
                      </dd>
                    </div>
                    {hub && (
                      <>
                        <div>
                          <dt>账号 / 余额</dt>
                          <dd>
                            {s.hubSync!.accounts} 个账号 · {s.hubSync!.balances}{" "}
                            份余额观察
                          </dd>
                        </div>
                        <div>
                          <dt>调用 key</dt>
                          <dd>
                            {s.hubSync!.credentials} 把已保存 ·{" "}
                            {s.hubSync!.missingCredentials} 把待取得
                          </dd>
                        </div>
                        <div>
                          <dt>Key 最近交付</dt>
                          <dd>{dateTime(s.hubSync!.lastCredentialsAt)}</dd>
                        </div>
                        {(s.hubSync!.keyReadPending > 0 ||
                          s.hubSync!.keyReadErrors > 0) && (
                          <div>
                            <dt>读取进度</dt>
                            <dd>
                              {s.hubSync!.keyReadPending} 个账号待读取 ·{" "}
                              {s.hubSync!.keyReadErrors} 个需检查登录或站点状态
                            </dd>
                          </div>
                        )}
                      </>
                    )}
                  </>
                )}
              </dl>
              {issue && (
                <p className="source-error">
                  {s.inventoryError && `渠道：${s.inventoryError} `}
                  {s.callsError && `调用：${s.callsError} `}
                  {s.authorizationError}
                </p>
              )}
              {s.lastChanges && (
                <p className="source-change-summary">
                  上轮新增{" "}
                  {
                    s.lastChanges.channels.filter((c) => c.result === "created")
                      .length
                  }{" "}
                  · 更新{" "}
                  {
                    s.lastChanges.channels.filter((c) => c.result === "updated")
                      .length
                  }{" "}
                  · 新调用 {s.lastChanges.added ?? s.lastChanges.calls}
                  {s.lastChanges.unmatched > 0 &&
                    ` · ${s.lastChanges.unmatched} 条待关联`}
                </p>
              )}
              <div className="source-card-actions">
                <Button onClick={() => configureSource(s)}>
                  接入设置
                  <ArrowRight size={14} />
                </Button>
                {pull && (
                  <>
                    <Button
                      disabled={busy === s.id}
                      onClick={() => void act(s, "check")}
                    >
                      检查授权
                    </Button>
                    <Button
                      disabled={busy === s.id}
                      onClick={() =>
                        void act(s, s.lastInventoryAt ? "sync" : "preview")
                      }
                    >
                      <RefreshCw
                        size={14}
                        className={busy === s.id ? "spinning" : ""}
                      />
                      {s.lastInventoryAt ? "立即同步" : "预览导入"}
                    </Button>
                    {s.lastInventoryAt && (
                      <Button
                        variant="ghost"
                        disabled={busy === s.id}
                        onClick={() => void toggle(s)}
                      >
                        {s.syncEnabled ? "暂停自动同步" : "开启自动同步"}
                      </Button>
                    )}
                  </>
                )}
              </div>
            </article>
          );
        })}
      </div>
      <SyncTargets />
      <BookmarkImports />
      <section className="paper-section">
        <SectionHeading
          title="同步与操作记录"
          meta="资料同步不会触发模型调用"
        />
        <div className="change-list">
          {visibleOperations.slice(0, 12).map((op) => (
            <div className="change-row" key={op.id}>
              <span className="change-time">
                {dateTime(op.finishedAt || op.createdAt)}
              </span>
              <Badge
                tone={
                  op.state === "failed"
                    ? "amber"
                    : op.state === "succeeded"
                      ? "green"
                      : "blue"
                }
              >
                {{
                  succeeded: "完成",
                  failed: "未完成",
                  queued: "排队",
                  running: "同步中",
                  waiting: "等待",
                }[op.state] || op.state}
              </Badge>
              <div>
                <strong>
                  {sources.find((s) => s.id === op.input.sourceId)?.name ||
                    "来源"}{" "}
                  · {op.stage}
                </strong>
                <span>
                  {op.reason ||
                    (op.result?.channels &&
                      `${op.result.channels.length} 条渠道记录 · ${op.result.calls || 0} 条调用处理`) ||
                    ""}
                </span>
              </div>
            </div>
          ))}
          {!visibleOperations.length && (
            <p className="inline-empty">
              暂无数据变化；最近同步时间见来源卡片。
            </p>
          )}
        </div>
      </section>
      {preview && (
        <Preview
          source={preview.source}
          op={preview.op}
          close={() => setPreview(null)}
          completed={async () => {
            await refresh();
            setPreview(null);
            notify("首次同步完成，已开启 New API 自动同步");
          }}
        />
      )}
    </>
  );
}

function Preview({
  source,
  op,
  close,
  completed,
}: {
  source: Source;
  op: Operation;
  close: () => void;
  completed: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const requestId = useRef(crypto.randomUUID());
  const rows = op.result?.items || [];
  async function apply() {
    setBusy(true);
    setError("");
    try {
      let run = await api<Operation>(`/sources/${source.id}/sync`, "POST", {
        requestId: requestId.current,
        scope: "all",
        previewId: op.result?.previewId,
      });
      for (
        let i = 0;
        i < 120 && ["queued", "running"].includes(run.state);
        i++
      ) {
        await new Promise((r) => setTimeout(r, 1000));
        run = await api<Operation>(`/operations/${run.id}`);
      }
      if (run.state !== "succeeded")
        throw new Error(run.reason || "同步仍在执行，请关闭面板查看操作记录");
      const current = (await api<{ items: Source[] }>("/sources")).items.find(
        (s) => s.id === source.id,
      )!;
      await api(`/sources/${source.id}`, "PATCH", {
        version: current.version,
        changes: { syncEnabled: true },
      });
      await completed();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Overlay title="首次同步预览" subtitle={source.name} onClose={close}>
      <div className="overlay-body">
        <p>
          {rows.filter((r) => r.result === "new").length} 条新增 ·{" "}
          {rows.filter((r) => r.result === "linked").length} 条已关联 ·{" "}
          {rows.filter((r) => r.result === "excluded").length}{" "}
          条内部或缺地址记录不导入。
        </p>
        <div className="preview-rows">
          {rows.map((r) => (
            <div key={r.externalId}>
              <div>
                <strong>{r.name}</strong>
                <small className="mono wrap-anywhere">
                  {r.baseUrl || "无上游地址"}
                </small>
              </div>
              <Badge>
                {{ new: "新增", linked: "已关联", excluded: "不导入" }[
                  r.result
                ] || r.result}
              </Badge>
              <small>{r.models.length} 个配置模型</small>
            </div>
          ))}
        </div>
        {error && (
          <p className="inline-error" role="alert">
            {error}
          </p>
        )}
        <p className="form-hint">
          确认后导入资料并定期同步调用。扫描、任务验证和网关写入保持关闭。
        </p>
        <div className="form-actions">
          <Button onClick={close}>关闭</Button>
          <Button
            variant="primary"
            disabled={busy}
            onClick={() => void apply()}
          >
            {busy ? "正在同步…" : "确认导入并开启同步"}
          </Button>
        </div>
      </div>
    </Overlay>
  );
}
