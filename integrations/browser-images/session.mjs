// Native login maintenance; tokens and rollback copies stay on their own origin.
export async function browserSession(provider, userId, action = "inspect", daily = false) {
  const origin = provider === "oaichat" ? "https://image.oaichat.cc" : "https://wanzij.cc.cd";
  if (location.origin !== origin) throw new Error("登录页面来源不匹配");
  const key = provider === "oaichat" ? "ip_token" : "chatgpt2api.adminKey";
  const backupKey = "arc:login-backup", stampKey = "arc:login-renewed";
  const backup = JSON.parse(localStorage.getItem(backupKey) || "null");
  let token = localStorage.getItem(key) || sessionStorage.getItem(key);
  if (action === "restore" && backup?.userId === userId) {
    token = backup.token;
    localStorage.setItem(key, token);
    if (provider === "oaichat") sessionStorage.setItem(key, token);
    localStorage.removeItem(backupKey);
  }
  if (!token) return { authenticated: false, needsRenewal: true };
  const r = await fetch(provider === "oaichat" ? "/api/status" : "/auth/status", {
    headers: { Authorization: `Bearer ${token}` }, cache: "no-store", signal: AbortSignal.timeout(20000),
  });
  if (r.status === 401) return { authenticated: false, needsRenewal: true };
  if (!r.ok) throw new Error(`登录状态 HTTP ${r.status}`);
  const d = await r.json();
  if (provider === "wanzij" && d.authenticated !== true ||
      provider === "oaichat" && !d.user_id)
    return { authenticated: false, needsRenewal: true };
  const actual = String(provider === "oaichat" ? d.user_id : d.subject?.id);
  if (actual !== userId) throw new Error("续登账号与渠道绑定不一致");
  if (action === "accept" && provider === "wanzij" && backup?.token === token)
    return { authenticated: true, userId: actual, needsRenewal: true };
  if (action === "backup") localStorage.setItem(backupKey, JSON.stringify({ userId, token }));
  if (action === "accept" || action === "restore") {
    localStorage.setItem(key, token);
    if (provider === "oaichat") sessionStorage.setItem(key, token);
    if (action === "accept") localStorage.setItem(stampKey, JSON.stringify({ userId, at: Date.now() }));
    localStorage.removeItem(backupKey);
  }
  let expiresAt = null;
  if (provider === "oaichat") {
    const c = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    expiresAt = c.exp * 1000;
  }
  const stamp = JSON.parse(localStorage.getItem(stampKey) || "null");
  return { authenticated: true, userId: actual, expiresAt, persistent: !!localStorage.getItem(key),
    needsRenewal: provider === "oaichat" ? expiresAt - Date.now() < 86400000
      : daily && (stamp?.userId !== userId || Date.now() - stamp.at >= 86400000) };
}

/** Reuses All API Hub's single, semantic Linux.do authorization control. */
export function approveNativeLogin(provider) {
  const current = new URL(location.href);
  const callback = new URL(current.searchParams.get("redirect_uri"));
  const host = provider === "oaichat" ? "image.oaichat.cc" : "wanzij.cc.cd";
  if (current.origin !== "https://connect.linux.do" || current.pathname !== "/oauth2/authorize" ||
      callback.hostname !== host || !current.searchParams.get("state") || !current.searchParams.get("client_id"))
    throw new Error("登录授权页面不匹配");
  const controls = [...document.querySelectorAll('button,input[type="submit"],a[href],[role="button"]')]
    .filter(e => !e.disabled && /^(允许|授权|同意|Allow|Authorize|Continue)$/i.test(
      (e.getAttribute("aria-label") || (e instanceof HTMLInputElement ? e.value : e.textContent) || "").trim()));
  if (controls.length !== 1) return { clicked: false };
  controls[0].click(); return { clicked: true };
}
