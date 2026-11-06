import { probeBlock } from "./channel-rules.mjs";
import { canonicalApi } from "./domain.mjs";

const finite = (value) => (Number.isFinite(value) ? value : null);

export async function readJson(
  url,
  { headers = {}, fetcher = fetch, timeout = 15000 } = {},
) {
  const observedAt = new Date().toISOString();
  try {
    const response = await fetcher(url, {
      method: "GET",
      headers: { Accept: "application/json", ...headers },
      redirect: Object.keys(headers).length ? "error" : "follow",
      signal: AbortSignal.timeout(timeout),
    });
    const record = {
      url,
      resolvedUrl: response.url || url,
      observedAt,
      httpStatus: response.status,
      ...(response.headers.get("retry-after") &&
      /^\d+$/.test(response.headers.get("retry-after"))
        ? {
            retryAt: new Date(
              Date.now() + Number(response.headers.get("retry-after")) * 1000,
            ).toISOString(),
          }
        : {}),
    };
    if (!response.ok) {
      let message = "";
      try {
        const error = await response.json();
        message = String(error.error?.message || error.message || "").slice(
          0,
          200,
        );
      } catch {
        /* HTML errors retain the HTTP status; they are not auth evidence. */
      }
      return {
        ...record,
        status:
          response.status === 401
            ? "login_required"
            : response.status === 403
              ? "access_denied"
              : response.status === 404
                ? "unsupported"
                : response.status === 429
                  ? "rate_limited"
                  : "http_error",
        message,
      };
    }
    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return {
        ...record,
        status: /^\s*</.test(text) ? "html_response" : "invalid_response",
      };
    }
    if (data.success === false || data.error)
      return {
        ...record,
        status: /登录|令牌|login|token|unauth/i.test(
          data.error?.message || data.message || "",
        )
          ? "login_required"
          : "api_error",
        message: String(
          data.error?.message || data.message || "接口返回错误",
        ).slice(0, 200),
      };
    return { ...record, status: "ok", data };
  } catch (error) {
    return {
      url,
      observedAt,
      status: /timeout|abort/i.test(error.name) ? "timeout" : "network_error",
      message: String(error.cause?.code || error.code || error.name),
    };
  }
}

export function catalogModels(payload) {
  if (!Array.isArray(payload?.data)) return null;
  if (payload.data.some((m) => typeof m?.model_name !== "string")) return null;
  return payload.data.map((m) => ({
    name: m.model_name,
    groups: m.enable_groups || [],
    endpoints: m.supported_endpoint_types || [],
    tags: m.tags || "",
  }));
}

export function metric(value) {
  return {
    successRate: finite(value.success_rate),
    latencyMs: finite(value.avg_latency_ms),
    ttftMs: finite(value.avg_ttft_ms),
    tps: finite(value.avg_tps),
    samples: finite(value.request_count),
  };
}

export function summaryModels(payload) {
  const data = payload?.data;
  if (!Array.isArray(data?.models)) return null;
  return data.models.map((m) => ({
    name: m.model_name,
    ...metric(m),
    recent:
      m.recent_success_series?.map((p) => ({
        at: p.ts,
        rate: finite(p.success_rate),
      })) ||
      (m.recent_success_rates || []).map((rate) => ({
        at: null,
        rate: finite(rate),
      })),
    windowStart: finite(data.window_start),
    windowEnd: finite(data.window_end),
  }));
}

export function groupMetrics(payload) {
  if (!Array.isArray(payload?.data?.groups)) return null;
  return payload.data.groups.map((g) => ({
    group: g.group,
    ...metric(g),
    series: (g.series || []).map((p) => ({ at: p.ts, ...metric(p) })),
  }));
}

export function assessment(m, now = Date.now()) {
  const points = (m.series || m.recent || [])
    .map((p) => ({
      at: p.at,
      rate: p.successRate ?? p.rate,
    }))
    .filter((p) => p.rate !== null);
  const last = points.at(-1);
  // Hour buckets denote the start of a bucket, not the time of its final call.
  if (last?.at && now / 1000 - last.at > 7200) return "较久无记录";
  if (points.length >= 3 && points.slice(-3).every((p) => p.rate === 0))
    return "近期连续失败";
  if (last?.rate === 0 || m.successRate === 0) return "最近失败";
  if (m.successRate === null || m.successRate === undefined)
    return "无统计数据";
  if (points.length < 3) return "近期数据不足";
  if (
    m.successRate >= 98 &&
    points.length >= 3 &&
    points.slice(-3).every((p) => p.rate >= 98)
  )
    return "优先候选";
  return "表现波动";
}

// Account catalogs and site-wide observations remain separate throughout the scan.
export async function scanSite(
  target,
  { store, fetcher = fetch, hours = 24, detailLimit = Infinity } = {},
) {
  const endpoints = [],
    get = async (path) => {
      const r = await readJson(new URL(path, target.url).href, { fetcher });
      endpoints.push(r);
      return r;
    };
  const pricing = await get("/api/pricing");
  const summary = await get(`/api/perf-metrics/summary?hours=${hours}`);
  const catalog = pricing.status === "ok" ? catalogModels(pricing.data) : null;
  const metrics = summary.status === "ok" ? summaryModels(summary.data) : null;
  if (pricing.status === "ok" && catalog === null)
    pricing.status = "unsupported_format";
  if (summary.status === "ok" && metrics === null)
    summary.status = "unsupported_format";
  const channelCatalogs = [];
  for (const c of target.channels) {
    if (probeBlock(store, store.require("channel", c.id))) continue;
    if (!c.credentialId) {
      channelCatalogs.push({
        channelId: c.id,
        status: "missing_key",
        models: [],
      });
      continue;
    }
    const base = canonicalApi(c.baseUrl, c.protocol);
    if (!["OpenAI", "OpenAI Responses", "Anthropic"].includes(c.protocol)) {
      channelCatalogs.push({
        channelId: c.id,
        status: "unsupported_protocol",
        models: [],
      });
      continue;
    }
    const key = store.reveal(c.credentialId);
    const r = await readJson(`${base}/v1/models`, {
      fetcher,
      headers: {
        ...Object.fromEntries(c.headers.map((h) => [h.name, h.value])),
        ...(c.authType === "api_key"
          ? { "x-api-key": key }
          : { Authorization: `Bearer ${key}` }),
      },
    });
    const rows = r.data?.data;
    const names =
      Array.isArray(rows) && rows.every((m) => typeof m.id === "string")
        ? rows.map((m) => m.id)
        : null;
    channelCatalogs.push({
      channelId: c.id,
      connectionVersion: c.connectionVersion || 1,
      ...r,
      data: undefined,
      message: r.message?.replaceAll(key, "[redacted]"),
      status:
        r.status === "ok" && names === null ? "unsupported_format" : r.status,
      models: names || [],
    });
  }
  const groups = [];
  // Do not mistake historical metrics for models still listed by this site.
  const listed = new Set(
    catalog === null
      ? channelCatalogs.flatMap((c) => c.models)
      : catalog.map((m) => m.name),
  );
  for (const m of [...(metrics || [])]
    .sort((a, b) => (b.successRate ?? -1) - (a.successRate ?? -1))
    .slice(0, detailLimit)) {
    if (!listed.has(m.name)) continue;
    const r = await get(
      `/api/perf-metrics?${new URLSearchParams({ model: m.name, hours })}`,
    );
    const rows = r.status === "ok" ? groupMetrics(r.data) : null;
    if (r.status === "ok" && rows === null) r.status = "unsupported_format";
    for (const g of rows || [])
      groups.push({ model: m.name, ...g, observedAt: r.observedAt });
  }
  return {
    url: target.url,
    name: target.name,
    scannedAt: new Date().toISOString(),
    channels: target.channels.map(({ credentialId, headers, ...c }) => c),
    catalog,
    metrics,
    groups,
    channelCatalogs,
    endpoints: endpoints.map(({ data, ...r }) => r),
    coverage: {
      listed: catalog?.length ?? null,
      withStats:
        catalog === null
          ? null
          : (metrics || []).filter((m) => listed.has(m.name)).length,
      statsNotListed:
        catalog === null
          ? null
          : (metrics || []).filter((m) => !listed.has(m.name)).length,
    },
  };
}
