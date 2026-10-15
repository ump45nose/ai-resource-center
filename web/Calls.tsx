import { useEffect, useState } from "react";
import { api, useStore } from "./store";
import { Badge, Btn, Section, Field, inputCls } from "./ui";

type Metrics = {
  total: number;
  success: number;
  failure: number;
  pending: number;
  latency: number | null;
  ttft: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
};
type Report = {
  summary: Metrics & { unlinked: number; unknownApplication: number };
  groups: (Metrics & { name: string; label: string })[];
  items: {
    source: string;
    source_id: string;
    occurred_at: string;
    channelName: string;
    model: string;
    application: string | null;
    result: string;
    latency: number | null;
    ttft: number | null;
    input_tokens: number | null;
    output_tokens: number | null;
    summary: string | null;
    request_id: string;
    is_stream: number | null;
    stream_status: string | null;
  }[];
  coverage: {
    id: string;
    name: string;
    last?: string;
    error?: string;
    coverage?: string;
  }[];
  options: { models: string[]; applications: string[] };
};
const ms = (n: number | null) => (n == null ? "未采集" : `${Math.round(n)} ms`);
const num = (n: number | null) => (n == null ? "未采集" : n.toLocaleString());
const stamp = (v?: string) =>
  v ? new Date(v).toLocaleString("zh-CN", { hour12: false }) : "尚未同步";
export function Calls() {
  const { s } = useStore();
  const [filters, setFilters] = useState({
    days: "7",
    channelId: "",
    model: "",
    application: "",
    source: "",
    result: "",
    groupBy: "channel",
  });
  const [page, setPage] = useState(1),
    [report, setReport] = useState<Report | null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(false),
    [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    const params = new URLSearchParams({
      ...Object.fromEntries(Object.entries(filters).filter(([, v]) => v)),
      page: String(page),
    });
    api<Report>(`/calls?${params}`)
      .then((r) => {
        if (active) setReport(r);
      })
      .catch((e) => {
        if (active) setError(e.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [filters, page, revision]);
  const change = (name: keyof typeof filters, value: string) => {
    setFilters((f) => ({ ...f, [name]: value }));
    setPage(1);
  };
  const select = (
    name: keyof typeof filters,
    title: string,
    options: { value: string; label: string }[],
  ) => (
    <Field label={title}>
      <select
        className={inputCls}
        value={filters[name]}
        onChange={(e) => change(name, e.target.value)}
      >
        {options.map((x) => (
          <option key={x.value} value={x.value}>
            {x.label}
          </option>
        ))}
      </select>
    </Field>
  );
  const all = (label: string) => ({ value: "", label });
  const summary = report?.summary;
  return (
    <Section
      title="调用统计与明细"
      desc="实际渠道尝试与生成任务；不主动测活，不含任务正文或费用估算"
    >
      <div className="grid gap-3 p-4 sm:grid-cols-3 xl:grid-cols-7">
        {select(
          "days",
          "时间",
          [1, 7, 30, 90].map((n) => ({
            value: String(n),
            label: `近 ${n} 天`,
          })),
        )}
        {select("source", "来源", [
          all("全部来源"),
          ...s.integrations
            .filter((x) => ["newapi", "cpa"].includes(x.kind))
            .map((x) => ({ value: x.id, label: x.name })),
        ])}
        {select("channelId", "渠道", [
          all("全部渠道"),
          { value: "__unknown", label: "待关联渠道" },
          ...s.channels
            .filter((c) => c.category !== "rp" && c.gateway)
            .map((c) => ({ value: c.id, label: c.name })),
        ])}
        {select("model", "模型", [
          all("全部模型"),
          ...(report?.options.models || []).map((x) => ({
            value: x,
            label: x,
          })),
        ])}
        {select("application", "应用身份", [
          all("全部应用"),
          { value: "__unknown", label: "未关联应用" },
          ...(report?.options.applications || []).map((x) => ({
            value: x,
            label: x,
          })),
        ])}
        {select("result", "结果", [
          all("全部结果"),
          { value: "success", label: "成功" },
          { value: "failure", label: "失败" },
          { value: "pending", label: "生成中" },
        ])}
        {select("groupBy", "汇总维度", [
          { value: "channel", label: "按渠道" },
          { value: "model", label: "按模型" },
          { value: "application", label: "按应用" },
        ])}
      </div>
      {error && (
        <p role="alert" className="mx-4 mb-3 text-sm text-red-700">
          {error}
        </p>
      )}
      <div
        className="mx-4 mb-4 grid gap-2 text-sm sm:grid-cols-4"
        aria-busy={loading}
      >
        <div>
          已采集 <b>{summary?.total ?? "—"}</b>
        </div>
        <div>
          成功 {summary?.success ?? 0} · 失败 {summary?.failure ?? 0} · 生成中{" "}
          {summary?.pending ?? 0}
        </div>
        <div>输入 Token {num(summary?.inputTokens ?? null)}</div>
        <div>输出 Token {num(summary?.outputTokens ?? null)}</div>
      </div>
      <div className="mx-4 mb-4 rounded bg-amber-50 p-3 text-xs text-amber-900">
        {(report?.coverage || []).map((x) => (
          <div key={x.id}>
            {x.name} · {stamp(x.last)} ·{" "}
            {x.error || x.coverage || "覆盖范围未确认"}
          </div>
        ))}
        <div>
          待关联渠道 {summary?.unlinked || 0} 条 · 未关联应用{" "}
          {summary?.unknownApplication || 0} 条。应用按推理身份识别；共用 key
          无法拆分客户端。RP 直连记录未接入。
        </div>
      </div>
      <div className="max-h-80 overflow-auto px-4">
        <table className="w-full text-left text-xs">
          <thead className="sticky top-0 bg-zinc-50 text-zinc-500">
            <tr>
              {[
                "汇总",
                "调用",
                "成功 / 失败 / 生成中",
                "成功平均耗时",
                "成功平均首字",
                "输入 / 输出 Token",
              ].map((x) => (
                <th key={x} className="p-2 font-normal whitespace-nowrap">
                  {x}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {report?.groups.map((x, i) => (
              <tr key={x.name || i} className="border-t border-zinc-100">
                <td className="p-2">{x.label}</td>
                <td className="p-2">{x.total}</td>
                <td className="p-2">
                  {x.success} / {x.failure} / {x.pending}
                </td>
                <td className="p-2">{ms(x.latency)}</td>
                <td className="p-2">{ms(x.ttft)}</td>
                <td className="p-2">
                  {num(x.inputTokens)} / {num(x.outputTokens)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-4 overflow-x-auto border-t border-zinc-200 px-4">
        <table className="w-full text-left text-xs">
          <thead className="bg-zinc-50 text-zinc-500">
            <tr>
              {[
                "时间 / 来源",
                "渠道 / 模型",
                "应用",
                "结果",
                "耗时 / 首字",
                "输入 / 输出 Token",
                "流式 / 错误",
              ].map((x) => (
                <th key={x} className="p-2 font-normal whitespace-nowrap">
                  {x}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {report?.items.map((x) => (
              <tr
                key={`${x.source}:${x.source_id}`}
                className="border-t border-zinc-100 align-top"
              >
                <td className="p-2 whitespace-nowrap">
                  {stamp(x.occurred_at)}
                  <div className="text-zinc-500">
                    {s.integrations.find((i) => i.id === x.source)?.name ||
                      x.source}
                  </div>
                </td>
                <td className="p-2 break-all">
                  {x.channelName}
                  <div className="text-zinc-500">{x.model || "模型未采集"}</div>
                </td>
                <td className="p-2">{x.application || "未关联应用"}</td>
                <td className="p-2">
                  <Badge
                    tone={
                      x.result === "success"
                        ? "ok"
                        : x.result === "failure"
                          ? "err"
                          : "warn"
                    }
                  >
                    {x.result === "success"
                      ? "成功"
                      : x.result === "failure"
                        ? "失败"
                        : "生成中"}
                  </Badge>
                </td>
                <td className="p-2 whitespace-nowrap">
                  {ms(x.latency)}
                  <div className="text-zinc-500">{ms(x.ttft)}</div>
                </td>
                <td className="p-2">
                  {num(x.input_tokens)} / {num(x.output_tokens)}
                </td>
                <td className="p-2 max-w-64 break-words">
                  {x.is_stream === 1
                    ? "流式"
                    : x.is_stream === 0
                      ? "非流式"
                      : "流式未采集"}
                  {x.stream_status ? ` · ${x.stream_status}` : ""}
                  {x.summary && <div className="text-red-700">{x.summary}</div>}
                  {x.request_id && (
                    <details className="mt-1 text-zinc-500">
                      <summary>请求关联</summary>
                      {x.request_id}
                    </details>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!loading && report?.summary.total === 0 && (
        <p className="p-4 text-sm text-zinc-500">
          所选范围没有已采集调用；不代表渠道不可用。
        </p>
      )}
      <div className="flex flex-wrap items-center justify-end gap-2 p-4">
        <span className="text-xs text-zinc-500">
          第 {page} 页{loading ? " · 读取中…" : ""}
        </span>
        <Btn
          size="sm"
          disabled={page === 1 || loading}
          onClick={() => setPage((p) => p - 1)}
        >
          上一页
        </Btn>
        <Btn
          size="sm"
          disabled={!summary || page * 30 >= summary.total || loading}
          onClick={() => setPage((p) => p + 1)}
        >
          下一页
        </Btn>
        <Btn
          size="sm"
          disabled={loading}
          onClick={() => setRevision((x) => x + 1)}
        >
          刷新统计
        </Btn>
      </div>
    </Section>
  );
}
