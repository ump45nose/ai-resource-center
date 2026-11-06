import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowRight,
  ArrowUpRight,
  Box,
  CalendarCheck2,
  Cable,
  Check,
  CircleHelp,
  Globe2,
  LogOut,
  Menu,
  PanelLeftClose,
  Plus,
  Radar,
  RefreshCw,
  Search,
  Settings2,
  Sparkles,
  X,
} from "lucide-react";
import { Badge, Button, Overlay } from "./components";
import { api, allPages, ApiError, errorText } from "./api";
import {
  balances,
  pageLabels,
  type Meta,
  type Model,
  type Operation,
  type Page,
  type Site,
  type Source,
} from "./data";
import { WorkspaceProvider } from "./workspace";
import Login from "./Login";
import Sites from "./pages/Sites";
import ManagementPanel from "./ManagementPanel";
import Models from "./pages/Models";
import Sources from "./pages/Sources";
import SourcePanel from "./SourcePanel";
import Scans from "./pages/Scans";
import Benefits from "./pages/Benefits";

type Panel =
  | { kind: "site"; id: string }
  | { kind: "model"; id: string }
  | { kind: "source"; source?: Source }
  | { kind: "help" };
const nav = [
  { id: "sites", icon: Globe2 },
  { id: "models", icon: Box },
  { id: "sources", icon: Cable },
  { id: "scans", icon: Radar },
] as const;
const currentPage = (): Page =>
  Object.hasOwn(pageLabels, window.location.hash.slice(1))
    ? (window.location.hash.slice(1) as Page)
    : "sites";

export default function App() {
  const [session, setSession] = useState<"loading" | "login" | "ready">(
    "loading",
  );
  const [page, setPage] = useState(currentPage);
  const [sites, setSites] = useState<Site[]>([]);
  const [sources, setSources] = useState<Source[]>([]);
  const [operations, setOperations] = useState<Operation[]>([]);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [query, setQuery] = useState("");
  const [panel, setPanel] = useState<Panel | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [toast, setToast] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const notify = (text: string) => setToast(text);
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [s, src, ops, cap] = await Promise.all([
        allPages<Site>("/sites"),
        api<{ items: Source[] }>("/sources"),
        api<{ items: Operation[] }>("/operations?limit=30"),
        api<Meta>("/capabilities"),
      ]);
      setSites(s);
      setSources(src.items);
      setOperations(ops.items);
      setMeta(cap);
      setLoadError("");
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 401))
        setLoadError(errorText(e));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    api("/session")
      .then(() => setSession("ready"))
      .catch((e) => {
        setSession("login");
        if (!(e instanceof ApiError && e.status === 401))
          setLoadError(errorText(e));
      });
    const expired = () => {
      setSession("login");
      setSites([]);
      setPanel(null);
    };
    window.addEventListener("session-expired", expired);
    return () => window.removeEventListener("session-expired", expired);
  }, []);
  useEffect(() => {
    if (session !== "ready") return;
    void refresh();
    const timer = setInterval(() => void refresh(), 60000);
    return () => clearInterval(timer);
  }, [session, refresh]);
  useEffect(() => {
    const onHash = () => {
      setPage(currentPage());
      setMenuOpen(false);
      window.scrollTo({ top: 0 });
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("hashchange", onHash);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("hashchange", onHash);
      window.removeEventListener("keydown", onKey);
    };
  }, []);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 5000);
    return () => clearTimeout(timer);
  }, [toast]);
  function navigate(next: Page) {
    window.location.hash = next;
    setMenuOpen(false);
  }
  const models = useMemo(() => {
    const grouped = new Map<string, Model>();
    for (const site of sites)
      for (const channel of site.channels)
        for (const id of channel.activeModels) {
          const offering = channel.modelAvailability.find(
            (o) => o.modelId === id,
          );
          if (!grouped.has(id))
            grouped.set(id, {
              id,
              tier: offering?.capabilityClass || "unclassified",
              channels: [],
            });
          grouped.get(id)!.channels.push({
            site,
            channel,
            verified: offering?.verification?.result === "success",
          });
        }
    return [...grouped.values()].sort((a, b) => a.id.localeCompare(b.id));
  }, [sites]);
  async function sourceAction(
    source: Source,
    action: "check" | "preview" | "sync",
  ) {
    let op = await api<Operation>(`/sources/${source.id}/${action}`, "POST", {
      requestId: crypto.randomUUID(),
    });
    for (let i = 0; i < 120 && ["queued", "running"].includes(op.state); i++) {
      await new Promise((r) => setTimeout(r, 1000));
      op = await api<Operation>(`/operations/${op.id}`);
    }
    await refresh();
    if (op.state === "failed") throw new Error(op.reason || "同步未完成");
    return op;
  }
  const site =
    panel?.kind === "site" ? sites.find((s) => s.id === panel.id) : null;
  const model =
    panel?.kind === "model" ? models.find((m) => m.id === panel.id) : null;
  const daily = balances(
    sites.flatMap((s) => s.accounts),
    true,
  );
  if (session !== "ready")
    return (
      <Login
        loading={session === "loading"}
        initialError={loadError}
        loggedIn={() => {
          setLoadError("");
          setSession("ready");
        }}
      />
    );
  return (
    <WorkspaceProvider
      value={{
        sites,
        sources,
        models,
        operations,
        meta,
        query,
        navigate,
        inspectSite: (id) => setPanel({ kind: "site", id }),
        inspectModel: (id) => setPanel({ kind: "model", id }),
        configureSource: (source) => setPanel({ kind: "source", source }),
        sourceAction,
        refresh,
        notify,
      }}
    >
      <a className="skip-link" href="#main-content">
        跳到主要内容
      </a>
      <div className="app-shell">
        {menuOpen && (
          <button
            className="mobile-scrim"
            aria-label="关闭导航"
            onClick={() => setMenuOpen(false)}
          />
        )}
        <aside
          className={`sidebar ${menuOpen ? "open" : ""}`}
          aria-label="主导航"
        >
          <a className="brand" href="#sites">
            <span className="brand-symbol">
              <Sparkles size={21} strokeWidth={1.3} />
            </span>
            <span>
              <strong>AI Resource Hub</strong>
              <small>你的公益 AI 资源中心</small>
            </span>
          </a>
          <Button
            className="mobile-close icon-button"
            variant="ghost"
            aria-label="关闭导航"
            onClick={() => setMenuOpen(false)}
          >
            <PanelLeftClose size={19} />
          </Button>
          <div className="sidebar-pulse">
            <span>
              当日额度<Badge tone="clay">优先使用</Badge>
            </span>
            <strong>{daily.join(" / ") || "未取得"}</strong>
            <small>{sites.length} 个站点 · fn 数据</small>
          </div>
          <div className="nav-caption">资源工作台</div>
          <nav className="main-nav">
            {nav.map((n) => (
              <a
                key={n.id}
                href={`#${n.id}`}
                aria-current={page === n.id ? "page" : undefined}
                className={page === n.id ? "active" : ""}
                onClick={() => setMenuOpen(false)}
              >
                <n.icon size={19} strokeWidth={1.6} />
                <span>{pageLabels[n.id]}</span>
                {n.id === "sites" && (
                  <span className="nav-count">{sites.length}</span>
                )}
              </a>
            ))}
          </nav>
          <div className="nav-caption secondary-caption">日常管理</div>
          <nav className="main-nav">
            <a
              href="#benefits"
              className={page === "benefits" ? "active" : ""}
              onClick={() => setMenuOpen(false)}
            >
              <CalendarCheck2 size={19} strokeWidth={1.6} />
              <span>签到与权益</span>
            </a>
          </nav>
          <div className="sidebar-bottom">
            <button
              className="sidebar-help"
              onClick={() => setPanel({ kind: "help" })}
            >
              <Settings2 size={17} />
              <span>连接与管理</span>
              <CircleHelp size={15} />
            </button>
            <div className="sidebar-version">
              <span>fn · 真实资料</span>
              <span className="status-dot green" />
            </div>
          </div>
        </aside>
        <div className="main-shell">
          <header className="command-bar">
            <Button
              className="mobile-menu icon-button"
              variant="ghost"
              aria-label="展开导航"
              onClick={() => setMenuOpen(true)}
            >
              <Menu size={21} />
            </Button>
            <div className="command-title">
              <h1>{pageLabels[page]}</h1>
              <span className="data-label">fn</span>
            </div>
            <label className="global-search">
              <Search size={16} />
              <input
                ref={searchRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                aria-label="搜索站点、模型或来源"
                placeholder="搜索站点、模型或来源"
              />
              {query ? (
                <button aria-label="清空全局搜索" onClick={() => setQuery("")}>
                  <X size={14} />
                </button>
              ) : (
                <kbd>⌘ K</kbd>
              )}
            </label>
            <div className="command-actions">
              <Button
                variant="ghost"
                disabled={loading}
                aria-label="刷新数据"
                onClick={() => void refresh()}
              >
                <RefreshCw size={15} className={loading ? "spinning" : ""} />
              </Button>
              {page === "sources" ? (
                <Button
                  variant="primary"
                  onClick={() => setPanel({ kind: "source" })}
                >
                  <Plus size={15} />
                  添加 New API
                </Button>
              ) : page === "sites" ? (
                <Button onClick={() => navigate("sources")}>
                  接入来源
                  <ArrowRight size={15} />
                </Button>
              ) : null}
            </div>
          </header>
          <main
            id="main-content"
            tabIndex={-1}
            className="workspace"
            key={page}
          >
            {loadError && (
              <div className="inline-error" role="alert">
                {loadError}
                <Button onClick={() => void refresh()}>重新读取</Button>
              </div>
            )}
            {loading && !sites.length ? (
              <p className="inline-empty">正在读取 fn 资料…</p>
            ) : (
              <>
                {page === "sites" && <Sites />}
                {page === "models" && <Models />}
                {page === "sources" && <Sources />}
                {page === "scans" && <Scans />}
                {page === "benefits" && <Benefits />}
              </>
            )}
          </main>
        </div>
      </div>
      {site && (
        <ManagementPanel
          site={site}
          close={() => setPanel(null)}
          refresh={refresh}
          notify={notify}
        />
      )}
      {model && (
        <Overlay
          title={model.id}
          subtitle="模型与渠道"
          drawer
          onClose={() => setPanel(null)}
        >
          <div className="overlay-body">
            <code className="detail-model-id">{model.id}</code>
            <h3>已生效渠道</h3>
            {model.channels.map(({ site, channel, verified }) => (
              <button
                className="detail-route"
                key={channel.id}
                onClick={() => setPanel({ kind: "site", id: site.id })}
              >
                <div>
                  <strong>{site.name}</strong>
                  <small>{channel.name}</small>
                </div>
                <Badge tone={verified ? "green" : "neutral"}>
                  {verified ? "任务已验证" : "查看依据"}
                </Badge>
                <ArrowRight size={15} />
              </button>
            ))}
          </div>
        </Overlay>
      )}
      {panel?.kind === "source" && (
        <SourcePanel
          source={
            sources.find((s) => s.id === panel.source?.id) ?? panel.source
          }
          close={() => setPanel(null)}
          saved={async () => {
            await refresh();
            setPanel(null);
            notify("来源设置已保存，尚未启动模型测试");
          }}
        />
      )}
      {panel?.kind === "help" && (
        <Overlay title="连接与管理" onClose={() => setPanel(null)}>
          <div className="overlay-body">
            <dl className="detail-status">
              <div>
                <dt>数据</dt>
                <dd>fn 持久化资料</dd>
              </div>
              <div>
                <dt>来源同步</dt>
                <dd>
                  {meta?.sourceSyncEnabled
                    ? "New API 自动同步已开启"
                    : "手动同步"}
                </dd>
              </div>
              <div>
                <dt>主动维护</dt>
                <dd>{meta?.automationEnabled ? "已开启" : "未开启"}</dd>
              </div>
              <div>
                <dt>网关写入</dt>
                <dd>{meta?.gatewayWrites ? "已开启" : "未开启"}</dd>
              </div>
            </dl>
            <p>
              测试权限按渠道标签判断。RP 渠道只在酒馆和 Chrome
              书签中管理，CPA 本版不接入。
            </p>
            <a
              className="text-link"
              href="/openapi.json"
              target="_blank"
              rel="noreferrer"
            >
              OpenAPI
              <ArrowUpRight size={14} />
            </a>
            <Button
              onClick={async () => {
                await api("/session", "DELETE");
                setPanel(null);
                setSites([]);
                setSession("login");
              }}
            >
              <LogOut size={15} />
              退出登录
            </Button>
          </div>
        </Overlay>
      )}
      {toast && (
        <div className="toast" role="status">
          <Check size={16} />
          <span>{toast}</span>
          <button aria-label="关闭提示" onClick={() => setToast("")}>
            <X size={14} />
          </button>
        </div>
      )}
    </WorkspaceProvider>
  );
}
