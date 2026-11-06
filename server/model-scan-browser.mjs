import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout } from "node:timers/promises";
import { scanSite } from "./model-scan.mjs";

const exec = promisify(execFile);
async function relay(...args) {
  const { stdout } = await exec("browser-relay", [...args, "--json"], {
    maxBuffer: 20 * 1024 * 1024,
    timeout: 30000,
  });
  const result = JSON.parse(stdout);
  if (!result.ok || result.exceptionDetails)
    throw Error(result.code || "浏览器未能读取页面");
  return result;
}

// The browser keeps its cookies. Only the non-secret account routing header is
// reused from the site's own request; no token/cookie is exported or stored.
export async function scanWithBrowser(site, { hours = 24 } = {}) {
  const { tabId } = await relay("new-tab", `${site.url}/pricing`);
  try {
    await relay(
      "wait",
      "body",
      "--tab",
      tabId,
      "--state",
      "attached",
      "--timeout",
      "10000",
    );
    let accountHeaders = {};
    for (let i = 0; i < 20; i++) {
      const { entries } = await relay(
        "network",
        "--tab",
        tabId,
        "--type",
        "request",
        "--limit",
        "100",
      );
      const pricing = entries.filter(
        (e) =>
          new URL(e.url).origin === site.url &&
          new URL(e.url).pathname === "/api/pricing",
      );
      const accountRequest = pricing.find((e) =>
        Object.keys(e.request?.headers || {}).some(
          (h) => h.toLowerCase() === "new-api-user",
        ),
      );
      if (accountRequest) {
        accountHeaders = Object.fromEntries(
          Object.entries(accountRequest.request.headers).filter(
            ([k]) => k.toLowerCase() === "new-api-user",
          ),
        );
        break;
      }
      if (pricing.length) break;
      await setTimeout(250);
    }
    const fetcher = async (url) => {
      if (new URL(url).origin !== site.url)
        throw Error("浏览器请求只能读取当前站点");
      const expression = `(async()=>{const r=await fetch(${JSON.stringify(url)},{method:'GET',credentials:'include',headers:${JSON.stringify(accountHeaders)},signal:AbortSignal.timeout(8000)});return {status:r.status,url:r.url,text:await r.text()}})()`;
      const response = await relay("eval", expression, "--tab", tabId);
      const value = response.result.value;
      return {
        status: value.status,
        ok: value.status >= 200 && value.status < 300,
        url: value.url,
        text: async () => value.text,
      };
    };
    const result = await scanSite(
      { url: site.url, name: site.name, channels: [] },
      { fetcher, hours },
    );
    return {
      ...result,
      channels: site.channels,
      channelCatalogs: site.channelCatalogs,
      endpoints: result.endpoints.map((e) => ({
        ...e,
        transport: "browser-session",
      })),
    };
  } finally {
    await relay("close-tab", tabId);
  }
}
