import { useState } from "react";
import { useStore } from "../store";
import { Badge, Btn, Section, PageHead, Field, inputCls, Url } from "../ui";

type PreviewRow = {
  index: number;
  name: string;
  url: string;
  kind: string;
  detail: string;
  channelId?: string;
  channelIds?: string[];
  category?: string;
};
export default function Settings() {
  const { s, act } = useStore();
  const [rules, setRules] = useState(s.rules),
    [tm, setTm] = useState(s.tmUrl),
    [source, setSource] = useState({
      id: "new-api",
      name: "New API",
      kind: "newapi",
      url: "",
      userId: "",
      key: "",
      inferenceUrl: "",
    });
  const [accountTargets, setAccountTargets] = useState<Record<string, string>>(
    {},
  );
  const [file, setFile] = useState<File | null>(null),
    [from, setFrom] = useState("file"),
    [preview, setPreview] = useState<{
      importId: string;
      rows: PreviewRow[];
    } | null>(null),
    [selected, setSelected] = useState<number[]>([]),
    [associated, setAssociated] = useState<Record<number, string>>({}),
    [token, setToken] = useState("");
  async function readImport() {
    let payload: any;
    if (from === "file") {
      if (!file) return;
      const content = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = reject;
        reader.onload = () => resolve(String(reader.result).split(",")[1]);
        reader.readAsDataURL(file);
      });
      payload = { source: file.name, file: { name: file.name, content } };
    } else payload = { source: from, sourceId: from };
    const result = await act("/imports/preview", payload);
    if (result) {
      setPreview(result);
      setSelected(
        result.rows
          .filter((r: PreviewRow) => r.kind !== "待关联")
          .map((r: PreviewRow) => r.index),
      );
    }
  }
  async function accessToken(role: "ingest" | "rp") {
    const r = await act("/access-tokens", {
      role,
      ...(role === "rp"
        ? {
            channelIds: s.channels
              .filter((c) => c.category === "rp")
              .map((c) => c.id),
          }
        : {}),
    });
    if (r) setToken(r.token);
  }
  return (
    <div>
      <PageHead title="设置" />
      <div className="grid gap-5">
        <Section
          title="外部接入"
          desc="同步只读取运行事实；All API Hub 与酒馆主动上报"
        >
          <ul className="divide-y">
            {s.integrations.map((i) => (
              <li
                key={i.id}
                className="grid gap-2 p-4 sm:grid-cols-[150px_1fr_auto]"
              >
                <b className="text-sm">{i.name}</b>
                <div className="text-xs">
                  <Url href={i.url} />
                  <p>最后同步：{i.last}</p>
                  <Badge
                    tone={
                      i.state === "failed"
                        ? "err"
                        : i.state === "ok"
                          ? "ok"
                          : "warn"
                    }
                  >
                    {i.state === "failed"
                      ? "同步失败"
                      : i.state === "ok"
                        ? "已有记录"
                        : "待接入"}
                  </Badge>
                  {i.error && <p className="mt-1 text-red-700">{i.error}</p>}
                </div>
                {["newapi", "cpa"].includes(i.kind) && (
                  <Btn onClick={() => act(`/sources/${i.id}/sync`, {})}>
                    读取调用记录
                  </Btn>
                )}
              </li>
            ))}
          </ul>
          <div className="grid gap-3 border-t p-4 sm:grid-cols-2">
            <Field label="来源类型">
              <select
                className={inputCls}
                value={source.kind}
                onChange={(e) =>
                  setSource({
                    ...source,
                    kind: e.target.value,
                    name:
                      e.target.value === "newapi"
                        ? "New API"
                        : e.target.value === "cpa"
                          ? "CPA"
                          : "酒馆",
                    id: e.target.value,
                  })
                }
              >
                <option value="newapi">New API</option>
                <option value="cpa">CPA</option>
                <option value="sillytavern">酒馆</option>
              </select>
            </Field>
            <Field label="名称">
              <input
                className={inputCls}
                value={source.name}
                onChange={(e) => setSource({ ...source, name: e.target.value })}
              />
            </Field>
            <Field label="管理地址">
              <input
                className={inputCls}
                value={source.url}
                onChange={(e) => setSource({ ...source, url: e.target.value })}
              />
            </Field>
            {source.kind === "cpa" && (
              <Field label="推理地址">
                <input
                  className={inputCls}
                  value={source.inferenceUrl}
                  placeholder="http://192.168.31.201:8317/v1"
                  onChange={(e) =>
                    setSource({ ...source, inferenceUrl: e.target.value })
                  }
                />
              </Field>
            )}
            {source.kind === "newapi" && (
              <Field label="管理员用户 ID">
                <input
                  className={inputCls}
                  value={source.userId}
                  onChange={(e) =>
                    setSource({ ...source, userId: e.target.value })
                  }
                />
              </Field>
            )}
            {source.kind !== "sillytavern" && (
              <Field label="管理凭据（仅保存在 fn）">
                <input
                  type="password"
                  className={inputCls}
                  value={source.key}
                  onChange={(e) =>
                    setSource({ ...source, key: e.target.value })
                  }
                />
              </Field>
            )}
            <div className="flex items-end">
              <Btn
                kind="primary"
                onClick={async () => {
                  const r = await act("/sources", {
                    ...source,
                    userId: source.userId ? Number(source.userId) : undefined,
                    inferenceUrl: source.inferenceUrl || undefined,
                    key: source.key || undefined,
                  });
                  if (r) setSource({ ...source, key: "" });
                }}
              >
                保存接入
              </Btn>
            </div>
          </div>
        </Section>
        <div className="grid gap-5 lg:grid-cols-2">
          <Section title="评价窗口与阈值">
            <div className="grid grid-cols-2 gap-3 p-4">
              {(
                [
                  ["days", "窗口（天）"],
                  ["samples", "最少样本"],
                  ["good", "优先候选阈值 %"],
                  ["warn", "常规候选阈值 %"],
                ] as const
              ).map(([k, l]) => (
                <Field key={k} label={l}>
                  <input
                    type="number"
                    className={inputCls}
                    value={rules[k]}
                    onChange={(e) =>
                      setRules({ ...rules, [k]: Number(e.target.value) })
                    }
                  />
                </Field>
              ))}
              <div className="col-span-2 flex justify-end">
                <Btn
                  kind="primary"
                  onClick={() => act("/settings", { rules }, "PATCH")}
                >
                  保存并计算
                </Btn>
              </div>
            </div>
          </Section>
          <Section title="Token Monitor">
            <div className="grid gap-3 p-4">
              <Field label="用量入口">
                <input
                  className={inputCls}
                  value={tm}
                  onChange={(e) => setTm(e.target.value)}
                />
              </Field>
              <p className="text-xs text-zinc-500">
                中心记录调用结果用于评价；用量和费用在 Token Monitor 查看。
              </p>
              <Btn onClick={() => act("/settings", { tmUrl: tm }, "PATCH")}>
                保存
              </Btn>
            </div>
          </Section>
        </div>
        <Section title="浏览器和酒馆上报" desc="凭据按来源和 RP 连接范围限制">
          <div className="grid gap-3 p-4 text-sm">
            <p>All API Hub 最近接收：{s.received.allApiHub || "尚未上报"}</p>
            <p>酒馆最近保存：{s.received.sillyTavern || "尚未上报"}</p>
            <div className="flex flex-wrap gap-2">
              <Btn onClick={() => accessToken("ingest")}>
                生成 All API Hub 上报凭据
              </Btn>
              <Btn
                disabled={!s.channels.some((c) => c.category === "rp")}
                onClick={() => accessToken("rp")}
              >
                生成现有 RP 连接的酒馆凭据
              </Btn>
            </div>
            {token && (
              <Field label="本次生成的接入凭据">
                <textarea
                  className={inputCls + " h-20 py-2 font-mono text-xs"}
                  readOnly
                  value={token}
                />
              </Field>
            )}
          </div>
        </Section>
        <Section
          title="账号关联"
          desc="同站点的来源账号与网关占位账号关联后，共享余额只显示一次"
        >
          <ul className="divide-y">
            {s.accounts
              .filter(
                (a) =>
                  s.accounts.filter((x) => x.siteId === a.siteId).length > 1,
              )
              .map((a) => (
                <li
                  key={a.id}
                  className="grid gap-2 p-3 sm:grid-cols-[1fr_1fr_auto]"
                >
                  <span className="text-sm">
                    {s.sites.find((x) => x.id === a.siteId)?.name} · {a.name}
                  </span>
                  <select
                    className={inputCls}
                    value={accountTargets[a.id] || ""}
                    onChange={(e) =>
                      setAccountTargets({
                        ...accountTargets,
                        [a.id]: e.target.value,
                      })
                    }
                  >
                    <option value="">选择同一账号的来源记录</option>
                    {s.accounts
                      .filter((x) => x.siteId === a.siteId && x.id !== a.id)
                      .map((x) => (
                        <option key={x.id} value={x.id}>
                          {x.name} · {x.unit}
                        </option>
                      ))}
                  </select>
                  <Btn
                    disabled={!accountTargets[a.id]}
                    onClick={() =>
                      act(`/accounts/${a.id}/merge`, {
                        targetId: accountTargets[a.id],
                      })
                    }
                  >
                    关联并合并
                  </Btn>
                </li>
              ))}
          </ul>
        </Section>
        {!!s.pendingImports?.length && (
          <Section title="待关联导入">
            <div className="grid gap-2 p-4">
              {s.pendingImports.map((p) => (
                <div
                  key={p.id}
                  className="flex items-center justify-between gap-3"
                >
                  <span>
                    {p.source} · {p.count} 项需要选择关联目标
                  </span>
                  <Btn
                    onClick={() => {
                      void act(`/imports/${p.id}`, undefined, "GET").then(
                        (r) => {
                          if (r) {
                            setPreview(r);
                            setSelected([]);
                          }
                        },
                      );
                    }}
                  >
                    继续关联
                  </Btn>
                </div>
              ))}
            </div>
          </Section>
        )}
        <Section
          title="导入与关联"
          desc="历史可用性保留来源和日期，不计入自动评价；导入不测试 RP"
        >
          <div className="grid gap-3 p-4">
            <div className="flex flex-wrap gap-2">
              <select
                className={inputCls + " max-w-xs"}
                value={from}
                onChange={(e) => setFrom(e.target.value)}
              >
                <option value="file">表格或标准 JSON</option>
                {s.integrations
                  .filter((i) => ["newapi", "cpa"].includes(i.kind))
                  .map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.name} 渠道
                    </option>
                  ))}
              </select>
              {from === "file" && (
                <input
                  type="file"
                  accept=".xlsx,.json"
                  onChange={(e) => setFile(e.target.files?.[0] || null)}
                />
              )}
              <Btn
                kind="primary"
                disabled={from === "file" && !file}
                onClick={readImport}
              >
                读取预览
              </Btn>
            </div>
            {preview && (
              <>
                <ul className="divide-y rounded border">
                  {preview.rows.map((r) => (
                    <li
                      key={r.index}
                      className="grid gap-2 p-3 sm:grid-cols-[24px_90px_1fr_200px]"
                    >
                      <input
                        type="checkbox"
                        aria-label={`导入 ${r.name}`}
                        checked={selected.includes(r.index)}
                        onChange={(e) =>
                          setSelected(
                            e.target.checked
                              ? [...selected, r.index]
                              : selected.filter((x) => x !== r.index),
                          )
                        }
                      />
                      <Badge
                        tone={
                          r.kind === "用途冲突" || r.kind === "待关联"
                            ? "warn"
                            : r.kind === "缺 key"
                              ? "err"
                              : "info"
                        }
                      >
                        {r.kind}
                      </Badge>
                      <div className="text-sm">
                        <b>{r.name}</b>
                        <div className="text-xs">
                          <Url href={r.url} />
                        </div>
                        <p className="text-xs text-zinc-600">{r.detail}</p>
                        {r.kind === "用途冲突" && (
                          <p className="text-amber-700">
                            保留中心用途；用途迁移在渠道详情操作
                          </p>
                        )}
                      </div>
                      {r.channelIds && (
                        <select
                          className={inputCls}
                          value={associated[r.index] || ""}
                          onChange={(e) =>
                            setAssociated({
                              ...associated,
                              [r.index]: e.target.value,
                            })
                          }
                        >
                          <option value="">选择已有连接</option>
                          {r.channelIds.map((id) => (
                            <option key={id} value={id}>
                              {s.channels.find((c) => c.id === id)?.name}
                            </option>
                          ))}
                        </select>
                      )}
                    </li>
                  ))}
                </ul>
                <div>
                  <Btn
                    kind="primary"
                    disabled={!selected.length}
                    onClick={async () => {
                      const r = await act(
                        `/imports/${preview.importId}/commit`,
                        {
                          selections: selected.map((index) => ({
                            index,
                            ...(associated[index]
                              ? { channelId: associated[index] }
                              : {}),
                          })),
                        },
                      );
                      if (r) setPreview(null);
                    }}
                  >
                    确认导入 {selected.length} 项
                  </Btn>
                </div>
              </>
            )}
          </div>
        </Section>
      </div>
    </div>
  );
}
