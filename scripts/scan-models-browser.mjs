import { parseArgs } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { scanWithBrowser } from "../server/model-scan-browser.mjs";
import { renderScan, scanStatus } from "../server/model-scan-report.mjs";

const { values } = parseArgs({
  options: {
    input: { type: "string" },
    site: { type: "string", multiple: true },
    help: { type: "boolean" },
  },
});
if (values.help || !values.input) {
  console.log(
    "npm run scan:models:browser -- --input /path/scan.json [--site https://example.com]\n用 Chrome 已有登录态补采受保护的模型广场；不导出 Cookie 或 Token。未指定站点时只处理需要登录或 HTTP 403 的站点。",
  );
  process.exit(values.help ? 0 : 1);
}
const path = resolve(values.input),
  report = JSON.parse(await readFile(path, "utf8"));
const selected = values.site?.map((u) => new URL(u).origin);
for (const [index, site] of report.sites.entries()) {
  const blocked = site.endpoints.some((e) =>
    ["login_required", "access_denied"].includes(e.status),
  );
  if (selected ? !selected.includes(site.url) : !blocked) continue;
  const fresh = await scanWithBrowser(site, { hours: report.hours });
  // Retain earlier server failures for diagnosis instead of rewriting history.
  fresh.serverObservation = {
    scannedAt: site.scannedAt,
    endpoints: site.endpoints,
  };
  report.sites[index] = fresh;
  report.finishedAt = new Date().toISOString();
  await writeFile(path, JSON.stringify(report, null, 2), { mode: 0o600 });
  await writeFile(join(dirname(path), "index.html"), renderScan(report), {
    mode: 0o600,
  });
  const summary = fresh.endpoints.find((e) => e.url.includes("/summary?"));
  console.log(
    `${site.url}：目录 ${fresh.coverage.listed ?? "未读取"}，统计 ${fresh.coverage.withStats ?? "未知"}，${scanStatus[summary.status]}`,
  );
}
console.log(`完成：${join(dirname(path), "index.html")}`);
