import { readFileSync } from "node:fs";
import { nativeImageTask } from "./native.mjs";
import { browserSession, approveNativeLogin } from "./session.mjs";

const config = JSON.parse(
  readFileSync(process.env.IMAGE_WORKER_CONFIG, "utf8"),
);
const relayUrl = process.env.BROWSER_RELAY_URL || "http://127.0.0.1:18795";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const origins = {
  oaichat: "https://image.oaichat.cc",
  wanzij: "https://wanzij.cc.cd",
};
const tabs = new Map();
let stopped = false;
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => {
    stopped = true;
  });

async function bridge(path, body) {
  const response = await fetch(config.url + path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.workerKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const data = await response.json();
  if (!response.ok)
    throw new Error(data.error?.message || `执行队列 HTTP ${response.status}`);
  return data;
}
async function relay(path, body) {
  const response = await fetch(relayUrl + path, {
    ...(body
      ? {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      : {}),
    signal: AbortSignal.timeout(50000),
  });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error("无法连接 Browser Relay");
  return result;
}
async function tabFor(provider) {
  const { tabs: available } = await relay("/api/tabs");
  const owned = available.find(
    (t) =>
      t.id === tabs.get(provider) &&
      new URL(t.url).origin === origins[provider],
  );
  if (owned) return owned.id;
  const existing = available.find(
    (t) => new URL(t.url).origin === origins[provider],
  );
  if (existing) {
    tabs.set(provider, existing.id);
    return existing.id;
  }
  // Do not navigate any unrelated tab. The native browser profile retains login.
  const created = await relay("/api/tabs/create", {
    url: origins[provider] + (provider === "wanzij" ? "/#/studio" : "/"),
  });
  await relay("/api/wait", {
    tabId: created.tabId,
    selector: "body",
    state: "attached",
    timeoutMs: 15000,
  });
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await evaluate(created.tabId, () => location.origin, []) === origins[provider]) {
      tabs.set(provider, created.tabId);
      return created.tabId;
    }
    await sleep(250);
  }
  throw new Error("原站页面尚未完成跳转");
}
async function execute(tabId, provider, operation, input, userId) {
  return evaluate(tabId, nativeImageTask, [provider, operation, input, userId]);
}
async function evaluate(tabId, fn, args) {
  const expression = `(${fn.toString()})(...${JSON.stringify(args)})`;
  const result = await relay("/api/eval", { tabId, expression });
  if (result.exceptionDetails) {
    const message =
      result.exceptionDetails.exception?.description || "原站任务执行失败";
    throw new Error(message.split("\n")[0].replace(/^Error: /, ""));
  }
  return result.result?.value;
}

async function maintainSession(provider, userId) {
  const tab = await tabFor(provider);
  const state = await evaluate(tab, browserSession, [provider, userId, "inspect", provider === "wanzij"]);
  if (!state.needsRenewal) return;
  if (state.authenticated) await evaluate(tab, browserSession, [provider, userId, "backup"]);
  const login = await relay("/api/tabs/create", { url: origins[provider] + "/" });
  let success = false;
  try {
    await relay("/api/wait", { tabId: login.tabId, selector: "body", state: "attached", timeoutMs: 15000 });
    const start = provider === "oaichat"
      ? origins[provider] + "/api/auth/oauth2/linuxdo/start?mode=redirect&return_to=" + encodeURIComponent(origins[provider] + "/")
      : await evaluate(login.tabId, async () => (await (await fetch("/auth/oauth/linuxdo/start")).json()).authorization_url, []);
    await relay("/api/navigate", { tabId: login.tabId, url: start });
    const deadline = Date.now() + 60000;
    let approved = false;
    while (Date.now() < deadline) {
      const page = await evaluate(login.tabId, () => ({ origin: location.origin, path: location.pathname }), []);
      if (page.origin === "https://connect.linux.do" && page.path === "/oauth2/authorize" && !approved) {
        const result = await evaluate(login.tabId, approveNativeLogin, [provider]);
        approved = result.clicked;
      }
      if (page.origin === origins[provider] && page.path === "/") {
        const after = await evaluate(login.tabId, browserSession, [provider, userId, "accept"]);
        if (after.authenticated && !after.needsRenewal) { success = true; break; }
      }
      await sleep(500);
    }
    if (!success) throw new Error("登录需要人工验证");
    console.log(JSON.stringify({ provider, action: "session_renewed", at: new Date().toISOString() }));
  } finally {
    if (!success) await evaluate(tab, browserSession, [provider, userId, "restore"]).catch(() => {});
    await relay("/api/tabs/close", { tabId: login.tabId }).catch(() => {});
  }
}

async function run(job) {
  const update = (fields) =>
    bridge(`/worker/jobs/${job.id}`, { lease: job.lease, ...fields });
  let submitting = false,
    terminalFailure = false,
    remoteId = job.remoteId;
  try {
    const tab = await tabFor(job.provider);
    await execute(tab, job.provider, "inspect", {}, job.userId);
    if (!remoteId) {
      await update({ state: "submitting" });
      submitting = true;
      const created = await execute(
        tab,
        job.provider,
        "create",
        job.input,
        job.userId,
      );
      remoteId = created.id;
      await update({ state: "running", remoteId });
      submitting = false;
    }
    const deadline = Date.now() + 25 * 60000;
    while (!stopped && Date.now() < deadline) {
      const task = await execute(
        tab,
        job.provider,
        "poll",
        { remoteId },
        job.userId,
      );
      if (task.status === "failed") {
        terminalFailure = true;
        throw new Error(task.error);
      }
      if (task.status === "succeeded") {
        if (task.images.length !== 1) throw new Error("原站未返回一张生成图片");
        await update({ state: "running", remoteId });
        let image = task.images[0];
        // Materialize the result while the browser has access; downstream never needs a login token.
        if (!image.b64_json)
          image = await execute(tab, job.provider, "image", image, job.userId);
        await update({ state: "succeeded", remoteId, data: [image] });
        console.log(
          JSON.stringify({
            at: new Date().toISOString(),
            provider: job.provider,
            id: job.id,
            state: "succeeded",
            remoteId,
          }),
        );
        return;
      }
      await update({ state: "running", remoteId });
      await sleep(4000);
    }
    // Leave a resumable upstream task for the next worker. Never submit again.
  } catch (e) {
    const error = e.message.slice(0, 400);
    if (remoteId && !submitting && !terminalFailure) {
      // Read failures keep the task resumable until its 30-minute deadline.
      console.error(
        JSON.stringify({ provider: job.provider, id: job.id, remoteId, error }),
      );
      return;
    }
    await update({ state: submitting ? "uncertain" : "failed", error }).catch(
      () => {},
    );
    console.error(
      JSON.stringify({
        provider: job.provider,
        id: job.id,
        state: submitting ? "uncertain" : "failed",
        error,
      }),
    );
  }
}

async function loop(provider) {
  let lastError = "",
    lastErrorAt = 0;
  let nextSessionCheck = 0;
  while (!stopped) {
    let waitMs = 3000;
    try {
      const sessionUser = config.sessionAccounts?.[provider];
      if (sessionUser && Date.now() >= nextSessionCheck) {
        nextSessionCheck = Date.now() + 15 * 60000;
        await maintainSession(provider, sessionUser);
        nextSessionCheck = Date.now() + 86400000;
      }
      const { job } = await bridge("/worker/claim", { provider });
      lastError = "";
      if (job) await run(job);
    } catch (e) {
      const error = e.message.slice(0, 200);
      if (error !== lastError || Date.now() - lastErrorAt > 300000) {
        console.error(JSON.stringify({ provider, error }));
        lastError = error;
        lastErrorAt = Date.now();
      }
      waitMs = 15000;
    }
    await sleep(waitMs);
  }
}
await Promise.all(Object.keys(origins).map(loop));
