import { parseArgs } from "node:util";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { Store } from "../server/store.mjs";
import { scanTargets, scanAll } from "../server/model-scan.mjs";
import { renderScan, scanStatus } from "../server/model-scan-report.mjs";

const { values } = parseArgs({
  options: {
    "data-dir": { type: "string", default: process.env.DATA_DIR || "data" },
    output: { type: "string" },
    "import-report": { type: "string" },
    "exclude-host": { type: "string", multiple: true },
    category: { type: "string", multiple: true },
    url: { type: "string", multiple: true },
    hours: { type: "string", default: "24" },
    help: { type: "boolean" },
  },
});
if (values.help) {
  console.log(
    "npm run scan:models -- --data-dir /data [--output /data/model-scans/latest] [--exclude-host token.example.com] [--url https://example.com] [--category general] [--hours 24]\n读取站方性能数据及已有 key 的模型目录；不发送生成请求。排除配置保存在中心，后续启动继续使用。",
  );
  process.exit(0);
}
const hours = Number(values.hours);
if (!Number.isInteger(hours) || hours < 1 || hours > 720)
  throw Error("hours 需要是 1～720 的整数");
const dir = resolve(values["data-dir"]),
  store = new Store(dir);
try {
  if (values["import-report"]) {
    const path = resolve(values["import-report"]);
    const report = JSON.parse(await readFile(path, "utf8"));
    for (const site of report.sites)
      store.put("modelScan", { id: site.url, ...site });
    store.setting("modelScanLatest", {
      finishedAt: report.finishedAt,
      output: dirname(path),
      sites: report.sites.length,
    });
    console.log(`已接回 ${report.sites.length} 个站点的扫描结果。`);
  } else {
    const policy = {
      categories: ["general"],
      excludeHosts: [],
      ...store.setting("modelScanPolicy"),
    };
    if (values["exclude-host"]) policy.excludeHosts = values["exclude-host"];
    if (values.category) policy.categories = values.category;
    if (
      policy.categories.some((c) => !["general", "media", "client"].includes(c))
    )
      throw Error("扫描用途只支持 general、media、client");
    store.setting("modelScanPolicy", policy);
    const { targets, excluded } = scanTargets(store, policy);
    for (const url of values.url || []) {
      const origin = new URL(url).origin;
      if (!targets.some((t) => t.url === origin))
        targets.push({ url: origin, name: new URL(url).host, channels: [] });
    }
    const startedAt = new Date().toISOString();
    const output = resolve(
      values.output ||
        join(dir, "model-scans", startedAt.replace(/[:.]/g, "-")),
    );
    await mkdir(output, { recursive: true, mode: 0o700 });
    console.log(
      `开始读取 ${targets.length} 个站点，排除 ${excluded.length} 条连接，最多同时读取 5 个站点。`,
    );
    const sites = await scanAll(targets, { store, hours }, async (site) => {
      store.put("modelScan", { id: site.url, ...site });
      const summary = site.endpoints.find((e) => e.url.includes("/summary?"));
      console.log(
        `${site.url}：目录 ${site.coverage.listed ?? "未读取"}，统计 ${site.coverage.withStats ?? "未知"}，${scanStatus[summary.status]}`,
      );
    });
    const report = {
      startedAt,
      finishedAt: new Date().toISOString(),
      hours,
      policy,
      excluded,
      sites,
    };
    await writeFile(
      join(output, "scan.json"),
      JSON.stringify(report, null, 2),
      {
        mode: 0o600,
      },
    );
    await writeFile(join(output, "index.html"), renderScan(report), {
      mode: 0o600,
    });
    store.setting("modelScanLatest", {
      finishedAt: report.finishedAt,
      output,
      sites: sites.length,
    });
    console.log(`完成：${join(output, "index.html")}`);
  }
} finally {
  store.close();
}
