import { z } from "zod";
export const rulesSchema = z
  .object({
    days: z.number().int().min(1).max(90),
    samples: z.number().int().min(1),
    good: z.number().min(0).max(100),
    warn: z.number().min(0).max(100),
  })
  .refine((v) => v.good >= v.warn, { message: "优先阈值不能低于常规阈值" });
const url = z
  .url()
  .refine(
    (v) => ["http:", "https:"].includes(new URL(v).protocol),
    "仅支持 HTTP(S) 地址",
  );
export const channelPatch = z
  .object({
    name: z.string().min(1).optional(),
    siteId: z.string().optional(),
    accountId: z.string().optional(),
    category: z.enum(["general", "media", "rp", "client"]).optional(),
    baseUrl: url.optional(),
    protocol: z
      .enum(["OpenAI", "OpenAI Responses", "Anthropic", "Gemini"])
      .optional(),
    models: z.array(z.string().min(1)).max(30).optional(),
    bindings: z.array(z.string()).optional(),
    enabled: z.boolean().optional(),
    mode: z.enum(["auto", "manual"]).optional(),
    rating: z.enum(["", "优", "良", "差"]).optional(),
    note: z.string().optional(),
    order: z.number().int().min(0).optional(),
    client: z.string().optional(),
    headers: z
      .array(z.object({ name: z.string(), value: z.string() }))
      .optional(),
    key: z.string().optional(),
    priority: z.number().int().optional(),
    weight: z.number().int().min(1).max(200).optional(),
  })
  .strict();
export function normalizeUrl(value) {
  const u = new URL(value);
  u.hash = "";
  u.search = "";
  u.pathname = u.pathname.replace(/\/+$/, "");
  return u.href.replace(/\/$/, "");
}
export function headers(input) {
  const out = {};
  const protectedNames = new Set([
    "authorization",
    "x-api-key",
    "api-key",
    "host",
    "content-length",
    "connection",
    "transfer-encoding",
    "cookie",
    "proxy-authorization",
  ]);
  for (const item of input) {
    const name = item.name.trim().toLowerCase();
    if (!name && !item.value) continue;
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name) || /[\r\n\0]/.test(item.value))
      throw new Error("请求头名称或值不合法");
    if (protectedNames.has(name))
      throw new Error(`${name} 由凭据或传输机制管理`);
    if (Object.hasOwn(out, name)) throw new Error(`请求头 ${name} 重复`);
    out[name] = item.value;
  }
  return Object.entries(out).map(([name, value]) => ({ name, value }));
}
export function dayKey(time, tz = "Asia/Shanghai") {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(time));
}
export function availability(c, a, now = new Date()) {
  if (!c.enabled) return "人工暂停";
  if (!c.credentialId && !c.gateway && !c.nativeCredentialRef) return "缺 key";
  if (c.availability && c.availability !== "可用") return c.availability;
  if (a?.status && a.status !== "正常") return a.status;
  if (a?.balance === 0) return "余额耗尽";
  if (a?.validUntil && new Date(a.validUntil) <= now) return "额度已到期";
  const windows = a?.benefit?.windows;
  if (windows?.length) {
    const t = new Intl.DateTimeFormat("en-GB", {
      timeZone: a.benefit.tz,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(now);
    if (
      !windows.some((w) =>
        w.start <= w.end
          ? t >= w.start && t < w.end
          : t >= w.start || t < w.end,
      )
    )
      return "窗口关闭";
  }
  return null;
}
export function errorType(text = "", status = 0) {
  if (status === 429 || /rate.?limit|限流/i.test(text)) return "rate";
  if (/quota|balance|余额|insufficient|额度/i.test(text)) return "quota";
  if (status === 401 || /invalid.*key|invalid.*token|key.*无效/i.test(text))
    return "key";
  if (status === 403 || /verification|账号验证/i.test(text)) return "account";
  if (status === 400 || /context.*length|invalid.*request/i.test(text))
    return "input";
  if (/cancel/i.test(text)) return "cancelled";
  return "upstream";
}
const median = (values) => {
  const s = values.filter(Number.isFinite).sort((a, b) => a - b);
  return s.length
    ? (s[Math.floor((s.length - 1) / 2)] + s[Math.floor(s.length / 2)]) / 2
    : null;
};
export function evaluate(channels, accounts, calls, rules, now = new Date()) {
  const start = new Date(now.getTime() - rules.days * 86400000).toISOString();
  const valid = calls.filter(
    (x) =>
      x.occurred_at >= start &&
      ["success", "failure"].includes(x.result) &&
      (!x.error_type || x.error_type === "upstream"),
  );
  const compare = new Map();
  for (const c of channels.filter((c) => c.category !== "media"))
    for (const model of c.models) {
      const vs = valid.filter(
        (x) =>
          x.channel_id === c.id &&
          x.model === model &&
          x.result === "success" &&
          x.ttft > 0,
      );
      if (vs.length)
        compare.set(`${c.id}:${model}`, median(vs.map((x) => x.ttft)));
    }
  const result = [];
  for (const c of channels) {
    const a = accounts.find((a) => a.id === c.accountId),
      rows = valid.filter(
        (x) => x.channel_id === c.id && c.models.includes(x.model),
      );
    const samples = rows.length,
      success = samples
        ? (100 * rows.filter((x) => x.result === "success").length) / samples
        : null;
    let priority = c.priority,
      weight = c.weight || 100,
      reason = "样本不足，保留原配置";
    const hold = availability(c, a, now),
      tier =
        samples < rules.samples
          ? "pending"
          : success >= rules.good
            ? "preferred"
            : success >= rules.warn
              ? "regular"
              : "backup";
    const daily =
      a?.quota === "daily" &&
      a.benefit?.tz &&
      a.validUntil &&
      new Date(a.validUntil) > now;
    if (
      c.category === "rp" ||
      c.category === "client" ||
      !c.gateway ||
      c.mode === "manual"
    )
      reason = "人工维护，不参与自动调整";
    else if (hold) {
      priority = 0;
      reason = hold + "，暂时退出优先池";
    } else if (tier !== "pending") {
      priority =
        tier === "backup"
          ? 0
          : daily
            ? tier === "preferred"
              ? 400
              : 300
            : tier === "preferred"
              ? 200
              : 100;
      if (c.rating === "差") priority = Math.min(priority, c.priority, 0);
      reason = `${daily ? "当日" : "长期/有效期待确认"}额度 · ${tier === "preferred" ? "优先" : tier === "regular" ? "常规" : "备用"}候选`;
      if (c.rating === "差") reason = "人工较差，不自动提权";
      const ratios = c.models.flatMap((model) => {
        const own = compare.get(`${c.id}:${model}`);
        if (!own) return [];
        const others = channels
          .filter(
            (x) =>
              x.category === c.category &&
              x.models.includes(model) &&
              x.group === c.group,
          )
          .map((x) => compare.get(`${x.id}:${model}`))
          .filter((v) => v > 0);
        return others.length > 1 ? [median(others) / own] : [];
      });
      weight =
        c.category === "media" || !ratios.length
          ? 100
          : Math.max(
              50,
              Math.min(
                200,
                Math.round(
                  (100 * ratios.reduce((n, v) => n + v, 0)) / ratios.length,
                ),
              ),
            );
    }
    result.push({
      ...c,
      samples,
      success: success === null ? null : Math.round(success * 100) / 100,
      ttft: median(
        rows.filter((x) => x.result === "success").map((x) => x.ttft),
      ),
      disconnects: rows.filter((x) => x.stream_status === "disconnected")
        .length,
      lastSeen: rows.at(-1)?.occurred_at || "—",
      priority,
      weight,
      reason,
      quality: tier,
    });
  }
  return result;
}
