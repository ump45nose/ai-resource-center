import { assessment } from "./model-scan.mjs";

const escape = (v) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
export const scanStatus = {
  ok: "已读取",
  login_required: "需要登录",
  access_denied: "访问受限 / HTTP 403",
  unsupported: "接口不存在",
  rate_limited: "接口限流",
  http_error: "HTTP 错误",
  html_response: "返回网页，未取得接口数据",
  invalid_response: "响应不是 JSON",
  api_error: "接口报错",
  timeout: "读取超时",
  network_error: "网络连接失败",
  unsupported_format: "接口格式待适配",
  missing_key: "缺 key",
  unsupported_protocol: "模型目录协议待适配",
};
const date = (v) =>
  v
    ? new Date(typeof v === "number" ? v * 1000 : v).toLocaleString("zh-CN", {
        timeZone: "Asia/Shanghai",
        hour12: false,
      })
    : "未提供时间";
const number = (v, unit = "") =>
  v === null || v === undefined || (v === 0 && unit !== "%")
    ? "—"
    : `${Number(v.toFixed(2))}${unit}`;

export function modelRows(site, now) {
  const fromKeys = [...new Set(site.channelCatalogs.flatMap((c) => c.models))];
  const models = site.catalog ?? fromKeys.map((name) => ({ name, groups: [] }));
  return models.flatMap((m) => {
    const groups = site.groups.filter((g) => g.model === m.name);
    const summary = site.metrics?.find((x) => x.name === m.name);
    return (groups.length ? groups : [{ group: "跨组汇总", ...summary }]).map(
      (g) => ({
        site: site.url,
        model: m.name,
        group: g.group,
        successRate: g.successRate ?? null,
        ttftMs: g.ttftMs ?? null,
        latencyMs: g.latencyMs ?? null,
        tps: g.tps ?? null,
        recent: (g.series || g.recent || [])
          .slice(-3)
          .map((p) => ({ at: p.at, rate: p.successRate ?? p.rate })),
        samples: g.samples ?? null,
        keyListed: fromKeys.includes(m.name),
        binding: site.channels.length
          ? site.channels.some((c) => c.enabled)
            ? "有启用连接"
            : "人工暂停"
          : "未绑定连接",
        status:
          groups.length && m.groups?.length && !m.groups.includes(g.group)
            ? "目录未列该组"
            : assessment(g, now),
        scope: groups.length
          ? "站方分组统计"
          : summary
            ? "站方跨组统计"
            : site.catalog
              ? "仅站点目录"
              : "仅 key 目录",
      }),
    );
  });
}

export function renderScan(report) {
  const rows = report.sites.flatMap((s) =>
    modelRows(s, Date.parse(report.finishedAt)),
  );
  const links = report.sites
    .map(
      (s) =>
        `<article><h2><a href="${escape(s.url)}" target="_blank" rel="noreferrer">${escape(new URL(s.url).host)}</a></h2><p>${s.channels.length} 条连接 · ${s.channels.filter((c) => !c.enabled).length} 条人工暂停 · 站点目录 ${s.coverage.listed ?? "未读取"} · 有统计 ${s.coverage.withStats ?? "未知"}</p>${s.endpoints
          .filter((e) => !e.url.includes("?model="))
          .map(
            (e) =>
              `<div class="endpoint"><a href="${escape(e.url)}" target="_blank" rel="noreferrer">${escape(new URL(e.url).pathname)}</a><span>${escape(scanStatus[e.status] || e.status)}${e.httpStatus ? ` · ${e.httpStatus}` : ""}</span></div>`,
          )
          .join(
            "",
          )}<details><summary>key 目录与采集明细</summary>${s.channelCatalogs.map((c) => `<p>${escape(s.channels.find((x) => x.id === c.channelId)?.name)}：${escape(scanStatus[c.status] || c.status)} · ${c.models.length} 个模型</p>`).join("")}<p>读取时间：${escape(date(s.scannedAt))}。未提供的样本数保留未知。</p>${s.endpoints
          .filter((e) => e.url.includes("?model=") && e.status !== "ok")
          .map(
            (e) =>
              `<p>${escape(e.url)}：${escape(scanStatus[e.status] || e.status)}</p>`,
          )
          .join("")}</details></article>`,
    )
    .join("");
  const table = rows
    .map(
      (r) =>
        `<tr data-status="${escape(r.status)}" data-search="${escape(`${r.site} ${r.model} ${r.group}`.toLowerCase())}"><td><a href="${escape(r.site)}/pricing" target="_blank" rel="noreferrer">${escape(new URL(r.site).host)}</a><small>${escape(r.scope)} · ${escape(r.binding)}</small></td><td><strong>${escape(r.model)}</strong><small>${r.keyListed ? "key 目录已列出" : "key 目录未确认"}</small></td><td>${escape(r.group)}</td><td><span class="state ${r.status === "优先候选" ? "good" : /失败/.test(r.status) ? "bad" : "neutral"}">${escape(r.status)}</span></td><td>${number(r.successRate, "%")}</td><td>${number(r.ttftMs === null ? null : r.ttftMs / 1000, "s")}</td><td>${number(r.tps, " t/s")}</td><td>${r.recent.map((p) => `<span class="point ${p.rate === null ? "neutral" : p.rate >= 98 ? "good" : p.rate < 90 ? "bad" : "neutral"}" title="${escape(date(p.at))}">${number(p.rate, "%")}</span>`).join(" ") || "—"}<small>${escape(date(r.recent.at(-1)?.at))}</small></td></tr>`,
    )
    .join("");
  const statuses = [...new Set(rows.map((r) => r.status))];
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>渠道模型可用性</title><style>
  *{box-sizing:border-box}body{margin:0;background:#f6f7f9;color:#18212e;font:15px/1.6 system-ui,-apple-system,sans-serif}main{max-width:1500px;margin:40px auto;padding:0 24px}h1{font-size:30px;margin:0 0 8px}h2{font-size:16px;margin:0 0 8px}a{color:#155bd6;text-decoration:none}a:hover{text-decoration:underline}p{margin:6px 0;color:#526174}header{margin-bottom:24px}.intro{max-width:1000px}.summary{display:flex;gap:24px;flex-wrap:wrap;margin:24px 0}.summary b{font-size:25px;color:#142b4c}.filters{display:flex;gap:12px;flex-wrap:wrap;margin:20px 0}input,select{border:1px solid #ced6e0;background:white;border-radius:7px;padding:10px;font:inherit}input{min-width:220px;flex:1}.table{overflow:auto;background:white;border:1px solid #dee4ec;border-radius:9px}table{border-collapse:collapse;width:100%;min-width:1150px;font-size:14px}th,td{padding:14px 16px;text-align:left;border-bottom:1px solid #edf0f5;vertical-align:top}th{background:#edf2f8;font-weight:600;white-space:nowrap}td:nth-child(2){min-width:230px;max-width:370px;overflow-wrap:anywhere}small{display:block;font-size:12px;color:#65758b;margin-top:5px}.state,.point{display:inline-block;padding:2px 6px;border-radius:4px;white-space:nowrap}.good{color:#11734c;background:#e8f7ef}.bad{color:#b33c35;background:#fff0ee}.neutral{color:#665b30;background:#f5f1e6}.sites{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:16px;margin-top:20px}article{background:white;padding:18px;border:1px solid #dee4ec;border-radius:9px;overflow-wrap:anywhere}.endpoint{display:flex;gap:10px;justify-content:space-between;font-size:13px;margin:8px 0}details{margin-top:12px;font-size:13px}summary{color:#155bd6;cursor:pointer}section{margin-top:32px}.empty{padding:24px;color:#65758b}footer{margin:30px 0;font-size:13px;color:#65758b}@media(max-width:500px){main{margin:24px auto;padding:0 14px}.sites{grid-template-columns:1fr}h1{font-size:25px}.summary{gap:16px}}
  </style><main><header><h1>渠道模型可用性</h1><p>${escape(date(report.finishedAt))} · 读取站方近 ${report.hours} 小时统计</p><p class="intro">按站点、模型和分组筛选成功率与近期走势。key 目录标注你能看到的模型；站方指标用于初筛，最终结合你的真实调用选用。</p></header>
  <div class="summary"><span><b>${report.sites.length}</b> 个站点</span><span><b>${report.sites.reduce((n, s) => n + s.channels.length, 0)}</b> 条连接</span><span><b>${rows.length}</b> 条模型 / 分组记录</span><span><b>${report.excluded.length}</b> 条已排除</span></div>
  <div class="filters"><input id="search" aria-label="搜索" placeholder="搜索站点、模型、分组"><select id="state" aria-label="筛选状态"><option value="">全部状态</option>${statuses.map((s) => `<option${s === "优先候选" ? " selected" : ""}>${escape(s)}</option>`).join("")}</select><select id="focus" aria-label="模型范围"><option value="all">全部模型</option><option value="focus" selected>重点模型系列</option></select></div><p id="count">${rows.length} 条记录</p><div class="table"><table><thead><tr><th>站点</th><th>模型</th><th>分组</th><th>近期判断</th><th>成功率</th><th>首字延迟</th><th>吞吐</th><th>最近三个统计点</th></tr></thead><tbody>${table}</tbody></table><div class="empty" id="empty" hidden>没有匹配的模型。</div></div>
  <section><h2>站点采集情况</h2><p>登录、网络与接口问题分别列出；模型调用状态以性能记录为准。</p><div class="sites">${links}</div></section>
  <section><details><summary>筛选口径</summary><p>优先候选：站方成功率 ≥98%，最近三个统计点均 ≥98%。连续三点为 0 单列；最后一个有时间的统计桶超过两小时则显示较久无记录。桶时间是起始时间，数据中断的小时不会补成成功或失败。样本数未提供时，100% 仅作为候选依据。重点系列只作搜索快捷方式，不是模型能力评级。</p><p>采集接口：New API /api/pricing、/api/perf-metrics/summary?hours=${report.hours}、/api/perf-metrics；个人目录使用已有 key 的 GET /v1/models。</p></details></section>
  <footer>来源：各站点自身接口；生成时间 ${escape(date(report.finishedAt))}。再次运行命令可更新快照。</footer></main><script>
  const search=document.querySelector('#search'),state=document.querySelector('#state'),focus=document.querySelector('#focus'),rows=[...document.querySelectorAll('tbody tr')];
  function filter(){let n=0;for(const r of rows){const match=r.dataset.search.includes(search.value.trim().toLowerCase())&&(!state.value||r.dataset.status===state.value)&&(focus.value==='all'||(!/(?:^|[-/])(?:nano|mini|lite|haiku)(?:[-/]|$)/i.test(r.children[1].querySelector('strong').textContent)&&/deepseek|gpt-[5-9]|claude-(opus|sonnet|fable|mythos)|minimax-m[3-9]|kimi-k[3-9]|glm-[5-9]|grok-[4-9]|gemini-[3-9]|42-pro/i.test(r.children[1].textContent)));r.hidden=!match;n+=match}document.querySelector('#count').textContent=n+' 条记录';document.querySelector('#empty').hidden=n>0}search.oninput=filter;state.onchange=filter;focus.onchange=filter;filter();
  </script></html>`;
}
