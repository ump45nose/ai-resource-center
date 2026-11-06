export function normalizeUrl(value) {
  const u = new URL(value);
  u.hash = "";
  u.search = "";
  u.pathname = u.pathname.replace(/\/+$/, "");
  return u.href.replace(/\/$/, "");
}
export function canonicalApi(value, protocol = "OpenAI") {
  const u = new URL(normalizeUrl(value));
  if (["OpenAI", "OpenAI Responses", "Anthropic"].includes(protocol))
    u.pathname = u.pathname.replace(/\/v1$/, "");
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
// Building a formatter costs far more than formatting with it.
const formatters = new Map();
const formatter = (locale, options) => {
  const key = JSON.stringify([locale, options]);
  if (!formatters.has(key))
    formatters.set(key, new Intl.DateTimeFormat(locale, options));
  return formatters.get(key);
};
export function dayKey(time, tz = "Asia/Shanghai") {
  return formatter("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(time));
}
export function nextReset(time, tz, resetAt) {
  const now = new Date(time),
    [hour, minute] = resetAt.split(":").map(Number);
  const partsAt = (d) =>
    Object.fromEntries(
      formatter("en-CA", {
        timeZone: tz,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
      })
        .formatToParts(d)
        .filter((x) => x.type !== "literal")
        .map((x) => [x.type, Number(x.value)]),
    );
  const serial = (p) =>
    Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  const current = partsAt(now),
    offset = serial(current) - Math.floor(now.getTime() / 1000) * 1000;
  let target = Date.UTC(
    current.year,
    current.month - 1,
    current.day,
    hour,
    minute,
  );
  if (hour * 60 + minute <= current.hour * 60 + current.minute)
    target += 86400000;
  let end = target - offset;
  end += target - serial(partsAt(new Date(end)));
  if (serial(partsAt(new Date(end))) !== target)
    throw new Error("该重置时刻在所选时区不存在，请填写明确截止时间");
  return new Date(end).toISOString();
}
export const clock = (tz) =>
  formatter("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
export function windowOpen(windows, tz, now = new Date()) {
  if (!windows?.length) return true;
  const t = clock(tz).format(now);
  return windows.some((w) =>
    w.start <= w.end ? t >= w.start && t < w.end : t >= w.start || t < w.end,
  );
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
export const errorLabel = (type) =>
  ({
    rate: "限流",
    quota: "余额或额度不足",
    key: "调用凭据错误",
    account: "账号需验证",
    input: "请求或模型不兼容",
    cancelled: "请求取消",
    upstream: "上游调用失败",
  })[type] || "原因未确认";
