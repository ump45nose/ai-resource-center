import { useState, type FormEvent } from "react";
import { ArrowRight, Sparkles } from "lucide-react";
import { api, errorText } from "./api";
import { Button } from "./components";

export default function Login({
  loading,
  initialError,
  loggedIn,
}: {
  loading: boolean;
  initialError: string;
  loggedIn: () => void;
}) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("/session", "POST", { password });
      setPassword("");
      loggedIn();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="login-shell">
      <form className="login-card form-stack" onSubmit={submit}>
        <Sparkles size={30} strokeWidth={1.2} />
        <h1>AI Resource Hub</h1>
        <p className="muted">查看和管理手上的公益 AI 资源。</p>
        {loading ? (
          <p>正在连接…</p>
        ) : (
          <>
            <label>
              管理密码
              <input
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
            {(error || initialError) && (
              <p className="inline-error" role="alert">
                {error || initialError}
              </p>
            )}
            <Button type="submit" variant="primary" disabled={busy}>
              {busy ? "登录中…" : "进入工作台"}
              <ArrowRight size={15} />
            </Button>
          </>
        )}
      </form>
    </main>
  );
}
