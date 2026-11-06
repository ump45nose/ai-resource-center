import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

const usage = `用法：
  node scripts/bench-overview.mjs [--runs 5] [--only overview,sites] [--keep]
      在 /tmp 生成生产量级数据并计时，结束后删除
  node scripts/bench-overview.mjs --seed /tmp/arc-bench
      只生成数据
  node scripts/bench-overview.mjs --dir /tmp/arc-bench [--runs 5]
      对已有数据的副本计时
  node scripts/bench-overview.mjs --dir /tmp/arc-bench --export out.json [--root 其他检出]
      固定时钟导出各接口响应，供不同版本逐字节比较
  node scripts/bench-overview.mjs --compare base.json head.json
数据量：--calls 50000 --scans 3000 --evaluations 300 --deliveries 1500 --days 24`;

const args = { runs: "5" },
  positional = [];
for (let i = 2; i < process.argv.length; i++) {
  if (!process.argv[i].startsWith("--")) {
    positional.push(process.argv[i]);
    continue;
  }
  const next = process.argv[i + 1];
  args[process.argv[i].slice(2)] =
    next === undefined || next.startsWith("--") ? true : (i++, next);
}
if (args.help) {
  console.log(usage);
  process.exit(0);
}
const root = resolve(
  args.root || fileURLToPath(new URL("..", import.meta.url)),
);
const server = (name) => pathToFileURL(join(root, "server", name)).href;
const volume = {
  sites: 145,
  calls: Number(args.calls || 50000),
  scans: Number(args.scans || 3000),
  evaluations: Number(args.evaluations || 300),
  deliveries: Number(args.deliveries || 1500),
  days: Number(args.days || 24),
};
const HOUR = 3600000,
  DAY = 24 * HOUR;

let state = 20261028;
const random = () => {
  state = (state + 0x6d2b79f5) | 0;
  let t = Math.imul(state ^ (state >>> 15), 1 | state);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const int = (min, max) => min + Math.floor(random() * (max - min + 1));
const pick = (list) => list[Math.floor(random() * list.length)];
const round = (value) => Math.round(value * 100) / 100;
const sample = (list, n) => {
  const rest = [...list],
    out = [];
  while (out.length < n && rest.length)
    out.push(rest.splice(Math.floor(random() * rest.length), 1)[0]);
  return out;
};
const textModels = [
  "gpt-5",
  "gpt-5.1",
  "gpt-5-codex",
  "gpt-4.1",
  "gpt-4o",
  "o3",
  "o4-mini",
  "claude-opus-4-5",
  "claude-sonnet-4-5",
  "claude-haiku-4-5",
  "claude-3-7-sonnet",
  "gemini-2.5-pro",
  "gemini-2.5-flash",
  "gemini-3-pro-preview",
  "deepseek-v3.2",
  "deepseek-r1",
  "glm-5",
  "glm-4.6",
  "kimi-k2",
  "kimi-k2-thinking",
  "qwen3-coder-plus",
  "qwen3-235b-a22b",
  "qwen3-max",
  "minimax-m3",
  "grok-4",
  "grok-code-fast-1",
  "llama-4-maverick",
  "mistral-large",
  "doubao-seed-1.6",
  "hunyuan-t1",
].flatMap((family) =>
  [
    "",
    "-thinking",
    "-high",
    "-20251101",
    "-preview",
    "-latest",
    "-fast",
    "-nothink",
  ].map((suffix) => family + suffix),
);
const imageModels = [
  "gpt-image-1",
  "dall-e-3",
  "flux-1.1-pro",
  "flux-kontext-pro",
  "imagen-4",
  "seedream-4",
  "midjourney-v7",
  "stable-diffusion-3.5",
  "nano-banana",
  "qwen-image",
];
const videoModels = [
  "sora-2",
  "veo-3",
  "veo-3-fast",
  "kling-v2-master",
  "hailuo-02",
  "vidu-q1",
  "seedance-1-pro",
  "wan-2.5-video",
];

function gatewayFetcher(remote) {
  const json = (data) =>
    new Response(JSON.stringify(data), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  return async (url, options = {}) => {
    const u = new URL(url);
    if (u.host === "gateway.test" && u.pathname === "/api/status")
      return json({ data: { version: "bench", log_consume_enabled: true } });
    if (u.host === "gateway.test" && u.pathname === "/api/channel/") {
      const page = Number(u.searchParams.get("p") || 1),
        size = Number(u.searchParams.get("page_size") || 100),
        items = [...remote.values()];
      return json({
        data: {
          items: items.slice((page - 1) * size, page * size),
          total: items.length,
        },
      });
    }
    const one =
      u.host === "gateway.test" && u.pathname.match(/^\/api\/channel\/(\d+)$/);
    if (one) return json({ data: remote.get(Number(one[1])) });
    throw new Error(
      `bench: unexpected request ${options.method || "GET"} ${url}`,
    );
  };
}

const owned = (r) => ({
  name: r.name,
  base_url: r.base_url || "",
  models: (r.models || "").split(",").filter(Boolean).sort().join(","),
  status: r.status,
  type: r.type,
  header_override: r.header_override || "",
  setting: r.setting || "",
  model_mapping: r.model_mapping || "",
  priority: r.priority || 0,
  weight: r.weight ?? 100,
});

function svg(size) {
  const parts = [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 800">',
  ];
  let length = parts[0].length;
  while (length < size) {
    const path = `<path d="M${int(0, 1200)} ${int(0, 800)} L${int(0, 1200)} ${int(0, 800)} L${int(0, 1200)} ${int(0, 800)}" stroke="#${int(0, 0xffffff).toString(16).padStart(6, "0")}" fill="none"/>`;
    parts.push(path);
    length += path.length;
  }
  return parts.join("") + "</svg>";
}

function scanResult(site, channels, scannedAt) {
  const at = Date.parse(scannedAt);
  const listed = [...new Set(channels.flatMap((c) => c.models || []))];
  const names = [...new Set([...listed, ...sample(textModels, int(5, 40))])];
  const metric = () => ({
    successRate: round(80 + random() * 20),
    latencyMs: int(400, 9000),
    ttftMs: int(200, 3000),
    tps: round(20 + random() * 80),
    samples: int(5, 5000),
  });
  const metrics = sample(names, Math.min(names.length, int(8, 30))).map(
    (name) => ({
      name,
      ...metric(),
      recent: Array.from({ length: 12 }, (_, h) => ({
        at: Math.floor((at - (11 - h) * 2 * HOUR) / 1000),
        rate: round(80 + random() * 20),
      })),
      windowStart: Math.floor((at - DAY) / 1000),
      windowEnd: Math.floor(at / 1000),
    }),
  );
  const groups = metrics.slice(0, 3).flatMap((m) =>
    ["default", "vip"].slice(0, int(1, 2)).map((group) => ({
      model: m.name,
      group,
      ...metric(),
      series: Array.from({ length: 24 }, (_, h) => ({
        at: Math.floor((at - (23 - h) * HOUR) / 1000),
        ...metric(),
      })),
      observedAt: scannedAt,
    })),
  );
  const endpoint = (path, status = "ok") => ({
    url: `${site.url}${path}`,
    resolvedUrl: `${site.url}${path}`,
    observedAt: scannedAt,
    httpStatus: status === "ok" ? 200 : 404,
    status,
  });
  return {
    url: site.url,
    name: site.name,
    scannedAt,
    channels: channels.map(({ credentialId, headers, ...c }) => c),
    catalog: names.map((name) => ({
      name,
      groups: ["default"],
      endpoints: ["openai"],
      tags: "",
    })),
    metrics,
    groups,
    channelCatalogs: channels.map((c) => {
      const status = c.credentialId
        ? random() < 0.85
          ? "ok"
          : pick(["login_required", "rate_limited", "timeout"])
        : "missing_key";
      return {
        channelId: c.id,
        connectionVersion: c.connectionVersion || 1,
        url: `${c.baseUrl}/models`,
        resolvedUrl: `${c.baseUrl}/models`,
        observedAt: scannedAt,
        ...(status === "missing_key"
          ? {}
          : { httpStatus: status === "ok" ? 200 : 401 }),
        status,
        ...(status === "ok" || status === "missing_key"
          ? {}
          : { message: "invalid token" }),
        models:
          status === "ok"
            ? [...new Set([...(c.models || []), ...sample(names, int(0, 4))])]
            : [],
      };
    }),
    endpoints: [
      endpoint("/api/pricing"),
      endpoint("/api/perf-metrics/summary?hours=24"),
      ...metrics
        .slice(0, 3)
        .map((m) =>
          endpoint(
            `/api/perf-metrics?model=${encodeURIComponent(m.name)}&hours=24`,
          ),
        ),
    ],
    coverage: {
      listed: names.length,
      withStats: metrics.length,
      statsNotListed: 0,
    },
    website: { observedAt: scannedAt, status: "reachable", httpStatus: 200 },
  };
}

async function seed(dir) {
  const { createApp } = await import(server("app.mjs"));
  const { recordCall, ingestAccounts } = await import(server("ingest.mjs"));
  const { policies } = await import(server("resources.mjs"));
  const { dayKey } = await import(server("domain.mjs"));
  const { digest } = await import(server("canonical.mjs"));
  const { bookmarkPlan } = await import(server("bookmarks.mjs"));
  const { archiveLabels } = await import(server("channel-rules.mjs"));
  const remote = new Map();
  const app = await createApp({
    dir,
    fetcher: gatewayFetcher(remote),
    allowGatewayWrites: true,
  });
  const { store, resources, sources, scans, distribution } = app.services;
  const now = Date.now(),
    ago = (ms) => new Date(now - ms).toISOString(),
    step = (label) =>
      console.log(
        `[seed] ${label} (${((Date.now() - now) / 1000).toFixed(1)} s)`,
      );

  const gateway = sources.save({
    name: "New API",
    kind: "newapi",
    url: "https://gateway.test",
    userId: 1,
  });
  sources.save({
    name: "酒馆",
    kind: "sillytavern",
    url: "https://tavern.bench.test",
  });
  sources.save({ name: "NAS cron", kind: "cron" });
  store.setting("maintenancePolicy", {
    ...policies(store),
    enabled: true,
    newApiSourceId: gateway.id,
  });

  const sites = [];
  for (let i = 0; i < volume.sites; i++) {
    const url = `https://site${i}.bench.test`;
    const base = resources.site(
      {
        name: `公益站 ${String(i).padStart(3, "0")}`,
        url,
        checkinUrl: i % 3 === 0 ? `${url}/console/personal` : undefined,
        aliases: i % 9 === 0 ? [`https://api.site${i}.bench.test`] : [],
      },
      i % 4 === 0 ? "manual" : "all-api-hub",
    );
    sites.push(
      store.put("site", {
        ...base,
        ...(i % 5 === 0 ? { note: "每日签到送额度，晚间限流" } : {}),
        pinned: i < 4,
        websiteObservation:
          i % 17 === 3
            ? { status: "unreachable", observedAt: ago(int(1, 30) * HOUR) }
            : {
                status: "reachable",
                observedAt: ago(int(1, 30) * HOUR),
                httpStatus: 200,
              },
        ...(i % 37 === 36 ? { removed: true } : {}),
        ...(i % 48 === 47 ? { resourceExcluded: true } : {}),
        ...(i % 6 === 0
          ? {
              curation: {
                authority: "center",
                updatedAt: ago(int(2, 20) * DAY),
              },
            }
          : {}),
      }),
    );
  }
  step(`${sites.length} sites`);

  const primary = [],
    login = new Map();
  for (const [i, site] of sites.entries()) {
    const ext = `hub-${i}`,
      automatic = random() < 0.62,
      daily = i % 4 === 1,
      confirmedAt = ago(
        random() < 0.7 ? int(10, 23 * 60) * 60000 : int(26, 200) * HOUR,
      ),
      balance = random() < 0.12 ? 0 : round(random() * 50);
    const hubKeys = Array.from({ length: int(0, 3) }, (_, k) => ({
      id: `hub-key-${i}-${k}`,
      source: "all-api-hub",
      externalId: `${ext}:key${k}`,
      accountExternalId: ext,
      name: `key ${k}`,
      baseUrl: `${site.url}/v1`,
      protocol: "OpenAI",
      models: sample(textModels, int(10, 60)),
      allowedModelIds: null,
      enabled: true,
      secretState: "present",
      observedAt: ago(3 * HOUR),
      present: true,
      credentialId: store.secret(`sk-bench-hub-${i}-${k}`),
      credentialStatus: "present",
    }));
    const account = store.put("account", {
      siteId: site.id,
      name: `账号 ${i}`,
      source: "all-api-hub",
      sourceId: ext,
      balance,
      unit: pick(["USD", "USD", "积分", "点"]),
      quota: daily ? "daily" : "long",
      benefit: {
        tz: "Asia/Shanghai",
        ...(i % 29 === 4
          ? { balanceMode: "fixed_daily", dailyLimit: 20, resetAt: "00:00" }
          : {}),
        ...(i % 31 === 7
          ? { windows: [{ start: "09:00", end: "23:00" }] }
          : {}),
        ...(i % 19 === 5 ? { releaseTimes: ["10:00", "22:00"] } : {}),
        ...(i % 13 === 2 ? { renewal: "automatic" } : {}),
      },
      confirmedAt,
      observedAt: confirmedAt,
      status: "正常",
      ...(daily
        ? {
            dailyBalance: balance,
            longBalance: round(random() * 10),
            validUntil: ago(-int(1, 20) * HOUR),
          }
        : {}),
      sourceObservation: {
        source: "all-api-hub",
        externalId: ext,
        name: `账号 ${i}`,
        siteName: site.name,
        siteUrl: site.url,
        checkinUrl: site.checkinUrl || null,
        siteType: pick([
          "new-api",
          "new-api",
          "veloera",
          "one-hub",
          "done-hub",
        ]),
        enabled: i % 41 !== 3,
        ...(i % 15 === 4
          ? { health: { status: "warning", reason: "余额不足" } }
          : {}),
        checkin: {
          enabled: automatic,
          configured: true,
          supportStatus: "supported",
          availability: automatic ? "enabled" : "disabled",
          lastCheckInDate: dayKey(now - DAY),
          isCheckedInToday: false,
          statusObservedAt: ago(2 * HOUR),
        },
        observedAt: ago(int(5, 120) * 60000),
        deviceId: "chrome-mac",
        present: true,
      },
      hubKeys,
      keySync: {
        observedAt: ago(3 * HOUR),
        complete: true,
        count: hubKeys.length,
        error: i % 21 === 6 ? "读取 key 超时" : null,
      },
      healthWindows: {
        checkin: { at: ago(int(1, 20) * HOUR), count: 0, connectionVersion: 1 },
      },
    });
    store.ref("all-api-hub", "account", ext, account.id);
    primary.push(account);
    if (automatic && !site.removed) login.set(i, { ext, account });
  }
  for (const i of [...login.keys()].slice(0, 30)) {
    const site = sites[i],
      ext = `personal-checkin-${i}`;
    const executor = store.put("account", {
      siteId: site.id,
      name: `签到号 ${i}`,
      source: "all-api-hub",
      sourceId: ext,
      balance: int(0, 500),
      unit: "积分",
      quota: "long",
      benefit: {},
      confirmedAt: ago(int(1, 30) * HOUR),
      role: "checkin",
      sourceObservation: {
        source: "all-api-hub",
        externalId: ext,
        name: `签到号 ${i}`,
        siteName: site.name,
        siteUrl: site.url,
        siteType: "lupi",
        enabled: true,
        checkin: {
          enabled: true,
          configured: true,
          supportStatus: "supported",
        },
        observedAt: ago(int(5, 120) * 60000),
        deviceId: "chrome-mac",
        present: true,
      },
    });
    store.ref("all-api-hub", "account", ext, executor.id);
    primary[i] = store.put("account", {
      ...primary[i],
      checkinAccountId: executor.id,
    });
    login.set(i, { ext, account: executor });
  }
  for (let k = 0; k < 20; k++) {
    const i = (k * 7 + 3) % sites.length;
    store.put("account", {
      siteId: sites[i].id,
      name: `小号 ${k}`,
      balance: round(random() * 10),
      unit: "USD",
      quota: "long",
      benefit: {},
      confirmedAt: ago(int(1, 90) * HOUR),
      ...(k % 4 === 0 ? { enabled: false } : {}),
      ...(k % 5 === 1 ? { mergedInto: primary[i].id } : {}),
      ...(k % 3 === 2
        ? {
            sourceObservation: {
              source: "all-api-hub",
              externalId: `alt-${k}`,
              siteType: "new-api",
              enabled: true,
              present: k % 6 !== 2,
              checkin: { enabled: true, supportStatus: "supported" },
              observedAt: ago(int(1, 48) * HOUR),
            },
          }
        : {}),
    });
  }
  step(`${store.list("account").length} accounts`);

  const plan = [
    ...Array.from({ length: 71 }, (_, k) => ["general", k]),
    ...Array.from({ length: 15 }, (_, k) => ["image", 55 + k]),
    ...Array.from({ length: 7 }, (_, k) => ["video", 70 + k]),
    ...Array.from({ length: 40 }, (_, k) => ["rp", (30 + k * 2) % 130]),
    ...Array.from({ length: 4 }, (_, k) => ["client", 126 + k]),
    ...Array.from({ length: 5 }, (_, k) => ["removed", 5 + k * 11]),
    ...Array.from({ length: 3 }, (_, k) => ["internal", 9 + k * 13]),
    ...Array.from({ length: 2 }, (_, k) => ["merged", 2 + k * 3]),
  ];
  const channels = [];
  let remoteId = 1000,
    shared = null;
  for (const [n, [kind, i]] of plan.entries()) {
    const site = sites[i],
      account = primary[i];
    const usage = ["image", "video", "rp"].includes(kind) ? kind : "general";
    const models =
      kind === "image"
        ? sample(imageModels, int(3, 8))
        : kind === "video"
          ? sample(videoModels, int(2, 6))
          : kind === "client"
            ? sample(
                textModels.filter((m) => /claude|gpt-5/.test(m)),
                int(3, 10),
              )
            : sample(textModels, kind === "rp" ? int(5, 40) : int(5, 60));
    const protocol =
      kind === "general"
        ? pick([
            "OpenAI",
            "OpenAI",
            "OpenAI",
            "OpenAI",
            "OpenAI",
            "Anthropic",
            "OpenAI Responses",
            "Gemini",
          ])
        : "OpenAI";
    const created = resources.channel({
      siteId: site.id,
      accountId: account.id,
      name: `${site.name} · ${kind}${n}`,
      baseUrl: `${site.url}/v1`,
      protocol,
      models,
      enabled: true,
      mode: random() < 0.6 ? "auto" : "manual",
      priority: int(0, 10),
      weight: 100,
      group: "default",
      recoveryPolicy: { enabled: true },
      ...(kind === "client"
        ? {
            purpose: "client",
            client: "claude-code",
            clientRequirements: { client: "claude-code" },
          }
        : { usage }),
      ...(["image", "video"].includes(kind) ? { capabilities: [kind] } : {}),
      ...(n % 17 === 8
        ? { tags: ["no_probe"] }
        : n % 23 === 4 && kind === "rp"
          ? { tags: ["no_nsfw"] }
          : n % 31 === 6
            ? { tags: ["code_only"] }
            : {}),
    });
    const managed =
      ["general", "image", "video", "client", "removed"].includes(kind) &&
      random() < 0.7;
    const gatewayId = managed ? remoteId++ : null;
    const key = n % 29 === 3 && shared ? shared : `sk-bench-channel-${n}`;
    if (n % 29 === 2) shared = key;
    const keyless = kind === "rp" ? n % 2 === 0 : random() < 0.08;
    const version = int(1, 3);
    const archived =
      ["general", "image", "video"].includes(kind) && random() < 0.15;
    const reason = archived ? pick(Object.keys(archiveLabels)) : null;
    const paused = !archived && kind === "general" && n % 19 === 7;
    const observation = managed && {
      externalId: String(gatewayId),
      name: created.name,
      baseUrl: created.baseUrl,
      nativeType: 1,
      models:
        random() < 0.8
          ? models
          : models.slice(0, Math.max(1, models.length - 2)),
      protocol,
      enabled: !archived && !paused,
      status: archived || paused ? 2 : 1,
      gateway: { sourceId: gateway.id, channelId: gatewayId },
      group: "default",
      priority: created.priority,
      weight: 100,
      modelMapping: "",
      headerNames: [],
      hasCompatibilitySettings: false,
      internal: false,
      observedAt: ago(int(1, 10) * 60000),
      present: true,
    };
    const channel = store.put("channel", {
      ...created,
      ...(keyless
        ? kind === "rp"
          ? {
              nativeCredentialRef: {
                device: "fn:tavern",
                profileId: `profile-${n}`,
                secretId: `secret-${n}`,
              },
            }
          : {}
        : {
            credentialId: store.secret(key),
            credentialState:
              random() < 0.9
                ? "present"
                : pick(["authentication_failed", "invalid"]),
            credentialChangedAt: ago(int(2, 30) * DAY),
          }),
      connectionVersion: version,
      ...(version > 1 ? { connectionChangedAt: ago(int(2, 20) * DAY) } : {}),
      ...(managed
        ? {
            gateway: { sourceId: gateway.id, channelId: gatewayId },
            bindings: ["New API"],
            sourceObservation: observation,
          }
        : {}),
      ...(kind === "rp"
        ? {
            tavern: {
              profileId: `profile-${n}`,
              device: "fn:tavern",
              current: n % 5 === 0,
              lastSavedAt: ago(int(1, 10) * DAY),
            },
          }
        : {}),
      ...(random() < 0.4 && !keyless
        ? {
            source: "all-api-hub",
            hubObservation: {
              source: "all-api-hub",
              externalId: `hub-${i}:key0`,
              accountExternalId: `hub-${i}`,
              name: "key 0",
              baseUrl: created.baseUrl,
              protocol,
              models: sample(models, Math.max(1, models.length - 1)),
              allowedModelIds: null,
              enabled: true,
              secretState: "present",
              observedAt: ago(3 * HOUR),
              present: n % 13 !== 5,
            },
          }
        : {}),
      catalogObservation: {
        status: random() < 0.85 ? "ok" : "rate_limited",
        at: ago(int(1, 30) * HOUR),
        connectionVersion: version,
      },
      lastScanAt: ago(int(1, 30) * HOUR),
      maintenance: { lastScanAttemptAt: ago(int(1, 30) * HOUR) },
      healthWindows: {
        scan: {
          at: ago(int(1, 30) * HOUR),
          count: 0,
          connectionVersion: version,
        },
        calls:
          random() < 0.2
            ? {
                at: ago(int(1, 48) * HOUR),
                count: int(1, 4),
                connectionVersion: version,
                firstFailureAt: ago(int(2, 9) * DAY),
                reason: "call",
                detail: "连续 3 次真实调用失败",
                evidenceId: `calls:${n}`,
              }
            : {
                at: ago(int(1, 48) * HOUR),
                count: 0,
                connectionVersion: version,
              },
      },
      tagHistory: [
        { tags: [], source: "旧分组迁移", at: ago(40 * DAY) },
        ...(random() < 0.3
          ? [
              {
                tags: created.tags,
                source: "人工修改",
                at: ago(int(2, 30) * DAY),
              },
            ]
          : []),
      ],
      management: {
        state:
          kind === "removed"
            ? "removed"
            : archived
              ? reason === "website"
                ? "closed"
                : "maintenance"
              : paused
                ? "paused"
                : "active",
        manualOnly: created.mode === "manual",
      },
      ...(random() < 0.3
        ? {
            curation: { authority: "center", updatedAt: ago(int(1, 20) * DAY) },
          }
        : {}),
      ...(random() < 0.3 ? { note: "高峰期 429，夜间稳定" } : {}),
      ...(random() < 0.1
        ? {
            runtimeIssue: {
              type: "rate",
              at: ago(int(1, 5) * HOUR),
              reason: "限流，等待可用时段",
            },
          }
        : {}),
      ...(random() < 0.05 ? { retryAt: ago(-int(1, 3) * HOUR) } : {}),
      ...(archived
        ? {
            enabled: false,
            archiveReason: reason,
            availability: archiveLabels[reason],
            archiveNote: "自动归档：连续失败",
            archivedAt: ago(int(1, 14) * DAY),
            autoArchive: {
              reason,
              evidenceId: `scan:${n}`,
              source: "scan",
              at: ago(int(1, 14) * DAY),
              connectionVersion: version,
            },
          }
        : {}),
      ...(paused ? { enabled: false } : {}),
      ...(kind === "removed" ? { enabled: false, availability: "已移除" } : {}),
      ...(kind === "internal" ? { internal: true } : {}),
    });
    channels.push(channel);
    if (managed)
      remote.set(gatewayId, {
        id: gatewayId,
        name: channel.name,
        base_url: channel.baseUrl,
        models: (observation.models || []).join(","),
        status: observation.status,
        type: protocol === "Anthropic" ? 14 : protocol === "Gemini" ? 24 : 1,
        header_override: "",
        setting: "",
        model_mapping: "",
        priority: channel.priority,
        weight: 100,
        group: "default",
      });
    if (managed)
      store.ref(gateway.id, "channel", String(gatewayId), channel.id);
  }
  for (const [k, c] of channels
    .filter((c) => c.name.includes("merged"))
    .entries())
    store.put("channel", { ...c, mergedInto: channels[k].id, enabled: false });
  step(`${channels.length} channels`);

  const bySite = new Map();
  for (const c of store
    .list("channel")
    .filter((c) => !c.mergedInto && !c.internal))
    bySite.set(c.siteId, [...(bySite.get(c.siteId) || []), c]);
  for (const [siteId, list] of bySite) {
    const site = store.require("site", siteId);
    scans.persist(scanResult(site, list, ago(int(1, 20) * HOUR)), [siteId]);
  }
  const scanned = [...bySite];
  for (let n = 0; scanned.length && n < volume.scans - bySite.size; n++) {
    const [siteId, list] = scanned[n % scanned.length],
      site = store.require("site", siteId),
      at = ago(DAY + int(0, 20 * DAY));
    store.put("modelScan", {
      ...scanResult(site, list, at),
      id: `${site.url}#${at}`,
    });
  }
  step(`${store.list("modelScan").length} model scans`);

  for (const o of store.list("offering")) {
    const c = store.require("channel", o.channelId),
      roll = random();
    if (roll > 0.55) continue;
    const at = ago(int(1, 14 * 24) * HOUR);
    const success = roll < 0.42;
    store.put("offering", {
      ...o,
      verification: {
        result: success ? "success" : "failure",
        quality: success ? "passed" : "failed",
        at,
        connectionVersion: random() < 0.9 ? c.connectionVersion || 1 : 1,
        method: pick(["cron", "smoke"]),
        latencyMs: int(500, 30000),
        ...(success
          ? { stableSamples: int(0, 5) }
          : {
              reason: "任务验收未通过",
              errorType: pick(["upstream", "rate", "key"]),
            }),
      },
      ...(success
        ? {
            lastPassedVerification: {
              at,
              connectionVersion: c.connectionVersion || 1,
            },
          }
        : {}),
      grade: {
        samples: int(0, 80),
        successRate: round(85 + random() * 15),
        tier: pick(["preferred", "regular", "observing", "backup"]),
        priority: pick([0, 100, 200, 300, 400]),
        weight: int(50, 150),
        reason: "近 7 天真实调用",
        coverage: "仅 New API 记录",
        entitlement: { daily: random() < 0.3, reasons: [] },
        computedAt: ago(int(1, 48) * HOUR),
      },
      ...(random() < 0.1
        ? {
            health: {
              connectionVersion: c.connectionVersion || 1,
              blocked: random() < 0.5,
              failureType: "call",
              callFailures: int(1, 5),
              at,
              reason: "连续 3 次真实调用失败",
            },
          }
        : {}),
      ...(success && random() < 0.5
        ? {
            apply: { state: "distributed", at, remoteId: c.gateway?.channelId },
          }
        : {}),
      capabilityClass: pick([
        "strong",
        "execution",
        "unclassified",
        "unclassified",
      ]),
    });
  }
  step(`${store.list("offering").length} offerings`);

  const textChannels = channels.filter(
    (c) => !["image", "video"].includes(c.usage) && c.models.length,
  );
  for (let n = 0; n < volume.evaluations; n++) {
    const c = pick(textChannels),
      started = now - int(20, 60) * DAY;
    store.put("evaluation", {
      channelId: c.id,
      model: pick(c.models),
      client: pick(["cherry-studio", "claude-code", "codex", "pi"]),
      state: "completed",
      preparedAt: new Date(started - 60000).toISOString(),
      startedAt: new Date(started).toISOString(),
      endedAt: new Date(started + int(30, 900) * 1000).toISOString(),
      rating: pick(["优", "良", "差", ""]),
      records: Array.from({ length: int(1, 4) }, (_, r) => ({
        round: r + 1,
        ok: random() < 0.8,
        seconds: round(random() * 60),
        note: "生成内容通过人工检查",
      })),
      ...(random() < 0.25
        ? {
            piAudit: {
              rounds: int(1, 5),
              complete: random() < 0.8,
              svg: svg(int(30000, 250000)),
              seconds: int(30, 600),
              visualReviewed: random() < 0.5,
            },
          }
        : {}),
      ...(random() < 0.08
        ? { image: { file: `evaluations/${n}.png`, width: 1024, height: 1024 } }
        : {}),
    });
  }
  step(`${volume.evaluations} legacy evaluations`);

  const events = [];
  for (let d = volume.days - 1; d >= 0; d--)
    for (const [i, { ext, account }] of login) {
      const site = sites[i],
        start = Date.parse(`${dayKey(now - d * DAY)}T00:00:00+08:00`);
      for (let attempt = 0; attempt < (random() < 0.15 ? 2 : 1); attempt++) {
        const occurredAt =
          start + 8 * HOUR + attempt * 3 * HOUR + int(0, 90) * 60000;
        if (occurredAt >= now) continue;
        const roll = random();
        const [result, reason] =
          roll < 0.55
            ? ["成功"]
            : roll < 0.72
              ? ["已签到"]
              : roll < 0.8
                ? ["未执行", "already_checked_today"]
                : roll < 0.88
                  ? ["失败", "upstream_error"]
                  : roll < 0.93
                    ? ["需登录", "authentication_required"]
                    : roll < 0.96
                      ? ["需人工操作", "captcha"]
                      : ["待确认"];
        events.push({
          eventId: `checkin-${i}-${d}-${attempt}`,
          kind: "checkin",
          accountId: ext,
          occurredAt: new Date(occurredAt).toISOString(),
          site: { name: site.name, url: site.url },
          name: account.name,
          result,
          ...(reason ? { reason } : {}),
          ...(result === "成功" ? { reward: `+$${round(random() * 2)}` } : {}),
          method: pick(["api", "browser"]),
          timezone: "Asia/Shanghai",
        });
      }
      if (random() < 0.6) {
        const occurredAt = start + int(9, 23) * HOUR;
        if (occurredAt < now)
          events.push({
            eventId: `balance-${i}-${d}`,
            kind: "account",
            accountId: ext,
            occurredAt: new Date(occurredAt).toISOString(),
            site: { name: site.name, url: site.url },
            name: account.name,
            balance: round(random() * 50),
            unit: account.unit || "USD",
            status: "正常",
          });
      }
    }
  events.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
  for (let n = 0; n < events.length; n += 200)
    ingestAccounts(resources, "all-api-hub", events.slice(n, n + 200));
  step(`${events.length} account events`);

  const callers = channels.filter((c) => !c.mergedInto && !c.internal);
  const weights = callers.map((_, k) => 1 / ((k % 23) + 1));
  const total = weights.reduce((sum, w) => sum + w, 0);
  const caller = () => {
    let r = random() * total;
    for (const [k, w] of weights.entries())
      if ((r -= w) <= 0) return callers[k];
    return callers.at(-1);
  };
  store.transaction(() => {
    for (let n = 0; n < volume.calls; n++) {
      const c = random() < 0.05 ? null : caller(),
        rp = c?.usage === "rp",
        roll = random();
      const result =
        roll < 0.88
          ? "success"
          : roll < 0.97
            ? "failure"
            : roll < 0.98
              ? "pending"
              : roll < 0.99
                ? "cancelled"
                : "unknown";
      recordCall(
        store,
        rp ? "sillytavern" : gateway.id,
        rp ? `fn:tavern:${n}` : 500000 + n,
        c?.id,
        pick(c?.models?.length ? c.models : textModels),
        ago(Math.floor(random() ** 1.4 * 21 * DAY)),
        result,
        {
          errorType:
            result === "failure"
              ? pick(["upstream", "upstream", "rate", "quota", "key", "input"])
              : null,
          latencyMs: int(300, 60000),
          ttftMs: int(100, 5000),
          requestId: `req-${n}`,
          tokenId: rp ? null : int(1, 20),
          upstreamChannel: c?.gateway?.channelId ?? null,
          application: rp ? "酒馆 · fn:tavern" : null,
          inputTokens: int(100, 50000),
          outputTokens: int(10, 4000),
          isStream: random() < 0.7,
          group: "default",
          origin: "live",
        },
      );
    }
  });
  step(`${volume.calls} calls`);

  const history = [];
  const current = distribution.entries("newapi");
  for (let n = 0; current.length && n < volume.deliveries; n++) {
    const e = pick(current),
      payload = structuredClone(e.payload),
      createdAt = ago(DAY + int(0, 20 * DAY));
    payload.routing = {
      ...payload.routing,
      available: random() < 0.7,
      reasons: random() < 0.3 ? ["余额耗尽"] : [],
    };
    payload.models = payload.models.slice(
      0,
      Math.max(1, payload.models.length - int(0, 3)),
    );
    payload.order = int(0, 5);
    const r = remote.get(
      store.require("channel", e.subject).gateway?.channelId,
    );
    history.push({
      target: "newapi",
      subject: e.subject,
      revision: digest(payload),
      payload,
      state: random() < 0.85 ? "applied" : "superseded",
      createdAt,
      attempts: 1,
      appliedAt: createdAt,
      leaseUntil: null,
      reason: null,
      retryAt: null,
      receipt: { remoteId: r?.id || null, snapshot: r ? owned(r) : null },
    });
  }
  const bookmarks = bookmarkPlan(resources);
  delete bookmarks.generatedAt;
  for (let n = 0; n < Math.round(volume.deliveries / 10); n++) {
    const payload = structuredClone(bookmarks),
      createdAt = ago(DAY + int(0, 20 * DAY));
    payload.folders[n % payload.folders.length].items.splice(0, 1);
    history.push({
      target: "chrome-bookmarks",
      subject: "bookmarks",
      revision: digest(payload),
      payload,
      state: random() < 0.5 ? "applied" : "superseded",
      createdAt,
      attempts: 1,
      appliedAt: createdAt,
    });
  }
  history.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  store.transaction(() => {
    for (const j of history) store.put("delivery", j);
  });
  step(`${history.length} historical deliveries`);

  const preview = await distribution.preview("newapi");
  distribution.confirm("newapi", preview.previewId);
  for (const j of store
    .list("delivery")
    .filter((j) => j.target === "newapi" && j.state === "pending")) {
    const r = remote.get(
      store.require("channel", j.subject).gateway?.channelId,
    );
    if (r && random() < 0.9)
      distribution.finish(j.id, { remoteId: r.id, snapshot: owned(r) });
    else
      store.put("delivery", {
        ...j,
        state: "waiting",
        reason: "等待模型任务验证",
        retryAt: ago(-HOUR),
      });
  }
  distribution.observeNewApi(gateway.id, [...remote.values()], Date.now());
  const bookmarkPreview = await distribution.preview("chrome-bookmarks");
  distribution.confirm("chrome-bookmarks", bookmarkPreview.previewId);
  sources.update(gateway.id, {
    credentialId: store.secret("bench-gateway-admin"),
    syncEnabled: true,
    lastInventoryAt: ago(5 * 60000),
    lastCallsAt: ago(60000),
    last: ago(60000),
    cursor: Math.floor(now / 1000) - 60,
    callsAdapterVersion: 2,
    platformVersion: "v0.9.0",
    logConsumeEnabled: true,
    coverage: "仅包含 New API 已记录调用；失败日志及流式终态可能不完整。",
    lastChanges: {
      channels: channels
        .slice(0, 90)
        .map((c) => ({
          id: c.id,
          name: c.name,
          result: "unchanged",
          fields: [],
        })),
      calls: 120,
      added: 37,
      unmatched: 2,
      errors: [],
    },
  });
  store.setting("received:all-api-hub", ago(60000));
  store.setting("hubSync:all-api-hub", {
    lastInventoryAt: ago(10 * 60000),
    lastCredentialsAt: ago(3 * HOUR),
    deviceId: "chrome-mac",
  });
  for (const c of channels.slice(0, 12))
    store.setting(`attention:${c.id}:missing_key`, {
      state: pick(["read", "snoozed"]),
    });
  step("distribution adopted");
  await app.close();
  writeFileSync(
    join(dir, "bench.json"),
    JSON.stringify({ seededAt: now, volume }, null, 2),
  );
}

function report(dir) {
  const db = new DatabaseSync(join(dir, "center.sqlite"), { readOnly: true });
  try {
    const kinds = db
      .prepare(
        "SELECT kind,count(*) n,sum(length(data)) bytes FROM entities GROUP BY kind ORDER BY bytes DESC",
      )
      .all();
    const count = (table) =>
      db.prepare(`SELECT count(*) n FROM ${table}`).get().n;
    console.log("数据量：");
    for (const k of kinds)
      console.log(
        `  ${k.kind.padEnd(20)} ${String(k.n).padStart(7)}  ${(k.bytes / 1048576).toFixed(1).padStart(7)} MB`,
      );
    console.log(
      `  calls ${count("calls")} · events ${count("events")} · credentials ${count("credentials")}`,
    );
  } finally {
    db.close();
  }
}

const median = (values) =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

async function bench(dir) {
  const { createApp } = await import(server("app.mjs"));
  const { issueToken } = await import(server("auth.mjs"));
  const app = await createApp({ dir });
  const { store } = app.services;
  const token = issueToken(store, "read");
  const detail = biggestSite(store);
  const endpoints = [
    ["overview", "/api/v2/overview"],
    ["sources", "/api/v2/sources"],
    ["sites", "/api/v2/sites?limit=200"],
    ["models", "/api/v2/models?limit=200"],
    ["checkins", "/api/v2/checkins"],
    ["site detail", `/api/v2/sites/${detail}`],
    ["attention", "/api/v2/attention"],
  ].filter(
    ([name]) => !args.only || String(args.only).split(",").includes(name),
  );
  const get = async (url) => {
    const started = performance.now();
    const r = await app.inject({
      method: "GET",
      url,
      headers: { authorization: `Bearer ${token}` },
    });
    const ms = performance.now() - started;
    if (r.statusCode !== 200)
      throw new Error(`${url} → ${r.statusCode} ${r.body.slice(0, 200)}`);
    return { ms, bytes: r.rawPayload.length };
  };
  const rows = [];
  let tick = 0;
  for (const [name, url] of endpoints) {
    await get(url);
    const cold = [],
      warm = [];
    let bytes = 0;
    for (let n = 0; n < Number(args.runs); n++) {
      // Production writes every minute; each poll therefore starts after a revision change.
      store.setting("bench:tick", ++tick);
      const first = await get(url);
      cold.push(first.ms);
      warm.push((await get(url)).ms);
      bytes = first.bytes;
    }
    rows.push({
      name,
      cold: median(cold),
      min: Math.min(...cold),
      warm: median(warm),
      bytes,
    });
  }
  await app.close();
  console.log(
    `\n${"接口".padEnd(14)}${"写后中位".padStart(10)}${"写后最快".padStart(10)}${"重复中位".padStart(10)}${"响应".padStart(10)}`,
  );
  for (const r of rows)
    console.log(
      `${r.name.padEnd(16)}${r.cold.toFixed(1).padStart(10)}${r.min.toFixed(1).padStart(10)}${r.warm.toFixed(1).padStart(10)}${`${(r.bytes / 1024).toFixed(0)} KB`.padStart(11)}`,
    );
  return rows;
}

function biggestSite(store) {
  const counts = new Map();
  for (const c of store.list("channel"))
    if (c.management?.state !== "removed" && !c.internal)
      counts.set(c.siteId, (counts.get(c.siteId) || 0) + 1);
  return [...counts].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  )[0][0];
}

function freezeClock(at) {
  const RealDate = Date;
  globalThis.Date = class extends RealDate {
    constructor(...values) {
      super(...(values.length ? values : [at]));
    }
    static now() {
      return at;
    }
  };
}

async function exportResponses(dir, file) {
  const { seededAt } = JSON.parse(
    readFileSync(join(dir, "bench.json"), "utf8"),
  );
  freezeClock(seededAt + 60000);
  const { createApp } = await import(server("app.mjs"));
  const { issueToken } = await import(server("auth.mjs"));
  const app = await createApp({ dir });
  const { store } = app.services;
  const token = issueToken(store, "admin");
  const get = (url) =>
    app.inject({
      method: "GET",
      url,
      headers: { authorization: `Bearer ${token}` },
    });
  const out = [];
  const record = async (url) => {
    const r = await get(url);
    out.push({ url, status: r.statusCode, body: r.body });
    return r;
  };
  const pages = async (path) => {
    let cursor = "0";
    do {
      const r = await record(
        `${path}${path.includes("?") ? "&" : "?"}cursor=${cursor}`,
      );
      cursor = r.statusCode === 200 ? JSON.parse(r.body).nextCursor : null;
    } while (cursor);
  };
  const sites = store.list("site"),
    channels = store.list("channel");
  for (const url of [
    "/api/v2/overview",
    "/api/v2/sources",
    "/api/v2/attention?limit=200",
    "/api/v2/sites?limit=200",
    "/api/v2/models?limit=200",
    "/api/v2/checkins",
    "/api/v2/checkins?limit=200",
    `/api/v2/checkins?siteId=${sites[3].id}`,
    "/api/v2/bookmarks",
    "/api/v2/sync/targets",
    "/api/v2/sync/jobs",
    "/api/v2/maintenance",
    "/api/v1/rp/connections",
    "/api/v2/capabilities",
    "/api/v2/policies",
    `/api/v2/evaluations?limit=200&channelId=${channels[0].id}`,
  ])
    await record(url);
  for (const query of [
    "usage=rp",
    "usage=image",
    "usage=video",
    "purpose=client",
    "purpose=media",
    "tag=no_probe",
    "capability=video",
    "application=New%20API",
    "archiveReason=balance",
    "archiveReason=website",
    "recoveryState=pending",
    "recoveryState=scheduled",
    "status=missing",
    "status=present",
    "q=site1",
  ])
    await record(`/api/v2/sites?limit=200&${query}`);
  await pages("/api/v2/sites?limit=40");
  await pages("/api/v2/models?limit=200");
  await pages("/api/v2/attention?limit=20");
  await pages("/api/v2/evaluations?limit=200");
  for (const query of [
    "purpose=media",
    "capabilityClass=strong",
    "capabilityClass=unclassified",
    "availability=success",
    "availability=failure",
    "q=claude",
    "tag=client_restricted",
    "application=New%20API",
    "capability=image",
  ])
    await pages(`/api/v2/models?limit=200&${query}`);
  let cursor = null;
  do {
    const r = await record(
      `/api/v2/checkins?limit=60${cursor ? `&cursor=${cursor}` : ""}`,
    );
    cursor = JSON.parse(r.body).nextCursor;
  } while (cursor);
  for (const site of sites) await record(`/api/v2/sites/${site.id}`);
  await app.close();
  writeFileSync(file, JSON.stringify(out));
  console.log(`已导出 ${out.length} 个响应 → ${file}`);
}

function firstDifference(a, b, path = "$") {
  if (isDeepStrictEqual(a, b)) return null;
  if (a && b && typeof a === "object" && typeof b === "object") {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
    for (const key of keys) {
      const found = firstDifference(a[key], b[key], `${path}.${key}`);
      if (found) return found;
    }
    return `${path}: 键顺序不同`;
  }
  return `${path}: ${JSON.stringify(a)?.slice(0, 120)} ≠ ${JSON.stringify(b)?.slice(0, 120)}`;
}

function compare(fileA, fileB) {
  const a = JSON.parse(readFileSync(fileA, "utf8")),
    b = JSON.parse(readFileSync(fileB, "utf8"));
  let differences = 0;
  if (a.length !== b.length) {
    console.log(`响应数量不同：${a.length} ≠ ${b.length}`);
    differences++;
  }
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i].url !== b[i].url) {
      console.log(`第 ${i} 项请求不同：${a[i].url} ≠ ${b[i].url}`);
      differences++;
      continue;
    }
    if (a[i].status === b[i].status && a[i].body === b[i].body) continue;
    differences++;
    console.log(`${a[i].url}：${a[i].status} / ${b[i].status}`);
    try {
      console.log(
        `  ${firstDifference(JSON.parse(a[i].body), JSON.parse(b[i].body))}`,
      );
    } catch {
      console.log("  响应不是 JSON");
    }
  }
  const bytes = a.reduce((sum, r) => sum + r.body.length, 0);
  console.log(
    differences
      ? `${differences} 处不同`
      : `${a.length} 个响应逐字节一致（共 ${(bytes / 1048576).toFixed(1)} MB）`,
  );
  return differences;
}

if (args.compare) {
  if (!positional[0]) throw new Error(usage);
  process.exitCode = compare(String(args.compare), positional[0]) ? 1 : 0;
} else if (args.seed) {
  const dir = resolve(String(args.seed));
  if (existsSync(join(dir, "center.sqlite")))
    throw new Error(`${dir} 已有数据`);
  await seed(dir);
  report(dir);
} else {
  const seeded = args.dir
    ? resolve(String(args.dir))
    : mkdtempSync("/tmp/arc-bench-");
  // Runs use a copy: startup migrations and the benchmark's own writes leave the seed untouched.
  const dir = mkdtempSync("/tmp/arc-bench-run-");
  try {
    if (!args.dir) {
      await seed(seeded);
      report(seeded);
    }
    cpSync(seeded, dir, { recursive: true });
    if (args.export) await exportResponses(dir, resolve(String(args.export)));
    else await bench(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    if (!args.dir && !args.keep)
      rmSync(seeded, { recursive: true, force: true });
    else if (!args.dir) console.log(`数据保留在 ${seeded}`);
  }
}
