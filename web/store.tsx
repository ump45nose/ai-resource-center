import {
  createContext,
  useContext,
  useState,
  useEffect,
  type ReactNode,
} from "react";
import { emptyState, type AppState, type Channel, type Account } from "./data";
type Toast = { id: number; tone: "ok" | "err" | "info"; text: string };
export async function api<T = any>(
  path: string,
  body?: unknown,
  method = "POST",
): Promise<T> {
  const response = await fetch("/api/v1" + path, {
    method: body === undefined ? "GET" : method,
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const result = await response.json();
  if (!response.ok)
    throw Object.assign(new Error(result.error), {
      status: response.status,
      detail: result.detail,
    });
  return result;
}
interface Store {
  s: AppState;
  refresh: () => Promise<void>;
  act: (path: string, body?: unknown, method?: string) => Promise<any>;
  updChannel: (id: string, p: Partial<Channel>) => Promise<any>;
  updAccount: (id: string, p: Partial<Account>) => Promise<any>;
  saveChannel: (
    id: string,
    p: Record<string, unknown>,
    version?: number,
  ) => Promise<any>;
  toast: (text: string, tone?: Toast["tone"]) => void;
  toasts: Toast[];
  query: string;
  setQuery: (q: string) => void;
  page: string;
  go: (p: string, sub?: string) => void;
  sub: string;
}
const Ctx = createContext<Store>(null!);
export const useStore = () => useContext(Ctx);
export function StoreProvider({ children }: { children: ReactNode }) {
  const [s, setS] = useState(emptyState),
    [ready, setReady] = useState(false),
    [login, setLogin] = useState(false),
    [error, setError] = useState(""),
    [password, setPassword] = useState("");
  const [toasts, setToasts] = useState<Toast[]>([]),
    [query, setQuery] = useState(""),
    [page, setPage] = useState("today"),
    [sub, setSub] = useState("all");
  const toast = (text: string, tone: Toast["tone"] = "ok") => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, tone, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 6000);
  };
  const refresh = async () => {
    try {
      setS(await api<AppState>("/state"));
      setLogin(false);
      setError("");
      setReady(true);
    } catch (e: any) {
      if (e.status === 401) setLogin(true);
      else setError(e.message);
      setReady(true);
    }
  };
  useEffect(() => {
    void refresh();
  }, []);
  const act = async (path: string, body?: unknown, method = "POST") => {
    try {
      const result = await api(path, body, method);
      await refresh();
      return result;
    } catch (e: any) {
      toast(e.message, "err");
      if (e.status === 409 || e.status === 401) await refresh();
      return null;
    }
  };
  const saveChannel = async (
    id: string,
    patch: Record<string, unknown>,
    version?: number,
  ) => {
    const c = s.channels.find((x) => x.id === id)!;
    const result = await act(
      `/channels/${id}`,
      { expectedVersion: version ?? c.version, patch },
      "PATCH",
    );
    if (result) toast("已保存到中心，生效结果单独确认", "info");
    return result;
  };
  const updChannel = (id: string, p: Partial<Channel>) => saveChannel(id, p);
  const updAccount = (id: string, p: Partial<Account>) =>
    act(
      `/accounts/${id}`,
      {
        expectedVersion: s.accounts.find((x) => x.id === id)!.version,
        patch: p,
      },
      "PATCH",
    );
  const go = (p: string, sb = "all") => {
    setPage(p);
    setSub(sb);
    window.scrollTo(0, 0);
  };
  if (!ready) return <div className="p-8">正在读取中心…</div>;
  if (login)
    return (
      <div className="mx-auto mt-24 max-w-sm rounded-lg border bg-white p-6">
        <h1 className="mb-5 text-xl font-semibold">AI 资源中心</h1>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              await api("/session", { password });
              setPassword("");
              await refresh();
            } catch (e: any) {
              setError(e.message);
            }
          }}
        >
          <label className="block text-sm">
            管理密码
            <input
              type="password"
              autoComplete="current-password"
              className="my-2 h-10 w-full rounded border px-3"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          {error && <p className="mb-3 text-sm text-red-700">{error}</p>}
          <button className="h-10 w-full rounded bg-blue-600 text-white">
            登录
          </button>
        </form>
      </div>
    );
  if (error)
    return (
      <div className="p-8 text-red-700">
        {error} <button onClick={refresh}>重新读取</button>
      </div>
    );
  return (
    <Ctx.Provider
      value={{
        s,
        refresh,
        act,
        updChannel,
        updAccount,
        saveChannel,
        toast,
        toasts,
        query,
        setQuery,
        page,
        go,
        sub,
      }}
    >
      {children}
    </Ctx.Provider>
  );
}
