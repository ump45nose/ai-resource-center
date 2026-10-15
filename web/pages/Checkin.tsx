import { useState } from "react";
import { Pencil, CalendarDays } from "lucide-react";
import { useStore } from "../store";
import {
  Badge,
  Btn,
  Section,
  Url,
  PageHead,
  Drawer,
  Field,
  inputCls,
  type Tone,
} from "../ui";
import { DATES, TODAY, type CheckinStatus, type Benefit } from "../data";

const tone: Record<CheckinStatus, Tone> = {
  成功: "ok",
  已签到: "ok",
  失败: "err",
  待确认: "info",
  需登录: "warn",
  需人工操作: "warn",
  未执行: "mute",
  无法签到: "mute",
};

export default function Checkin() {
  const { s, updAccount, toast, act } = useStore();
  const TODAY = s.today;
  const [date, setDate] = useState(TODAY);
  const [stf, setStf] = useState("");
  const [edit, setEdit] = useState<string | null>(null);
  const [bf, setBf] = useState<Benefit | null>(null);
  const [until, setUntil] = useState("");
  const rows = s.accounts.filter(
    (a) => !stf || a.checkin[date]?.status === stf,
  );
  const ea = s.accounts.find((a) => a.id === edit);
  const counts = s.accounts.reduce<Record<string, number>>((m, a) => {
    const k = a.checkin[date]?.status || "未执行";
    m[k] = (m[k] || 0) + 1;
    return m;
  }, {});
  return (
    <div>
      <PageHead
        title="签到与权益"
        desc="逐账号签到结果；网站入口与签到入口可分离"
      />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <CalendarDays size={16} className="text-zinc-500" />
        {DATES.map((d) => (
          <Btn
            key={d}
            size="sm"
            kind={d === date ? "primary" : "default"}
            onClick={() => setDate(d)}
          >
            {d === TODAY ? "今日" : d.slice(5)}
          </Btn>
        ))}
        <select
          className={inputCls + " ml-auto w-40"}
          value={stf}
          onChange={(e) => setStf(e.target.value)}
        >
          <option value="">全部状态</option>
          {(Object.keys(tone) as CheckinStatus[]).map((k) => (
            <option key={k} value={k}>
              {k}（{counts[k] || 0}）
            </option>
          ))}
        </select>
      </div>
      <div className="grid gap-5 xl:grid-cols-[1fr_320px]">
        <Section
          title={`${date === TODAY ? "今日" : date} 签到结果`}
          desc={Object.entries(counts)
            .map(([k, v]) => `${k} ${v}`)
            .join(" · ")}
        >
          <div className="hidden grid-cols-[1.1fr_1.3fr_90px_110px_1.2fr_auto] gap-3 border-b border-zinc-200 bg-zinc-50 px-4 py-2 text-xs text-zinc-500 lg:grid">
            <span>站点 / 账号</span>
            <span>签到入口</span>
            <span>结果</span>
            <span>奖励</span>
            <span>权益</span>
            <span />
          </div>
          {rows.map((a) => {
            const site = s.sites.find((x) => x.id === a.siteId)!;
            const r = a.checkin[date] || {
              status: (a.benefit.checkinSupported === false
                ? "无法签到"
                : "待确认") as CheckinStatus,
            };
            const ok = r.status === "成功" || r.status === "已签到";
            return (
              <div
                key={a.id}
                className="grid gap-x-3 gap-y-1.5 border-b border-zinc-100 px-4 py-3 text-sm last:border-0 lg:grid-cols-[1.1fr_1.3fr_90px_110px_1.2fr_auto] lg:items-center"
              >
                <div>
                  <div className="font-medium">{site.name}</div>
                  <div className="text-xs">
                    <Url href={site.url} /> · {a.name}
                  </div>
                </div>
                <div className="text-xs">
                  {site.checkinUrl ? (
                    <>
                      <span className="text-zinc-500">独立入口 </span>
                      <Url href={site.checkinUrl} />
                    </>
                  ) : (
                    <Url href={site.url}>
                      {site.url.replace(/^https?:\/\//, "")}
                    </Url>
                  )}
                </div>
                <div>
                  <Badge tone={tone[r.status]}>{r.status}</Badge>
                </div>
                <div className="text-xs">
                  {ok ? (
                    r.reward ? (
                      <span className="tabular-nums">{r.reward}</span>
                    ) : (
                      <Badge tone="warn">奖励待确认</Badge>
                    )
                  ) : r.note ? (
                    <span className="text-red-700">{r.note}</span>
                  ) : (
                    "—"
                  )}
                </div>
                <div className="text-xs text-zinc-600">
                  {a.benefit.pool === "daily" ? "每日池" : "长期池"} ·{" "}
                  {a.benefit.validity}
                  {a.benefit.drops && <div>投放 {a.benefit.drops}</div>}
                </div>
                <div className="flex flex-wrap gap-1 lg:justify-end">
                  {date === TODAY && !ok && r.status !== "无法签到" && (
                    <Btn
                      size="sm"
                      onClick={() => {
                        void act(`/accounts/${a.id}/checkins`, {
                          result: "成功",
                        });
                      }}
                    >
                      登记已签
                    </Btn>
                  )}
                  {date === TODAY && ok && !r.reward && (
                    <Btn
                      size="sm"
                      onClick={() => {
                        const reward = window.prompt("已确认的奖励及单位");
                        if (reward)
                          void act(`/accounts/${a.id}/checkins`, {
                            result: r.status,
                            reward,
                          });
                      }}
                    >
                      确认奖励
                    </Btn>
                  )}
                  <Btn
                    size="sm"
                    onClick={() => {
                      setEdit(a.id);
                      setBf(a.benefit);
                      setUntil(
                        a.validUntil
                          ? new Date(
                              new Date(a.validUntil).getTime() -
                                new Date(a.validUntil).getTimezoneOffset() *
                                  60000,
                            )
                              .toISOString()
                              .slice(0, 16)
                          : "",
                      );
                    }}
                  >
                    <Pencil size={13} />
                    权益
                  </Btn>
                </div>
              </div>
            );
          })}
        </Section>
        <Section title="投放与限时规则">
          <div className="space-y-3 p-4 text-sm">
            {s.accounts
              .filter((a) => a.benefit.drops || a.benefit.window)
              .map((a) => (
                <div key={a.id}>
                  <b>{s.sites.find((x) => x.id === a.siteId)?.name}</b>
                  <p>投放：{a.benefit.drops || "待确认"}</p>
                  <p>窗口：{a.benefit.window || "待确认"}</p>
                  <p>时区：{a.benefit.tz || "待确认"}</p>
                </div>
              ))}
            <p className="text-xs text-amber-700">
              投放时刻不推导结束时刻；有效期与重置时区未确认时保留待确认。
            </p>
          </div>
        </Section>
      </div>
      <Drawer
        open={!!ea && !!bf}
        onClose={() => setEdit(null)}
        title={`编辑权益 · ${s.sites.find((x) => x.id === ea?.siteId)?.name}`}
        sub={ea?.name}
        footer={
          <>
            <Btn onClick={() => setEdit(null)}>取消</Btn>
            <Btn
              kind="primary"
              onClick={() => {
                void updAccount(ea!.id, {
                  benefit: bf!,
                  validUntil: until ? new Date(until).toISOString() : null,
                }).then((r) => {
                  if (r) setEdit(null);
                });
              }}
            >
              保存
            </Btn>
          </>
        }
      >
        {bf && (
          <div className="grid gap-4">
            <Field label="额度池">
              <select
                className={inputCls}
                value={bf.pool}
                onChange={(e) =>
                  setBf({ ...bf, pool: e.target.value as Benefit["pool"] })
                }
              >
                <option value="daily">每日池</option>
                <option value="long">长期池</option>
              </select>
            </Field>
            <Field label="是否可以签到">
              <select
                className={inputCls}
                value={
                  bf.checkinSupported === true
                    ? "yes"
                    : bf.checkinSupported === false
                      ? "no"
                      : "unknown"
                }
                onChange={(e) =>
                  setBf({
                    ...bf,
                    checkinSupported:
                      e.target.value === "yes"
                        ? true
                        : e.target.value === "no"
                          ? false
                          : null,
                  })
                }
              >
                <option value="unknown">待确认</option>
                <option value="yes">可以签到</option>
                <option value="no">无法签到（仅标注）</option>
              </select>
            </Field>
            <Field
              label="每日重置时刻"
              hint="确认每日池及时区后填写，新的余额观察会计算下一次重置；未知时留空"
            >
              <input
                type="time"
                className={inputCls}
                value={bf.resetAt || ""}
                onChange={(e) =>
                  setBf({ ...bf, resetAt: e.target.value || undefined })
                }
              />
            </Field>
            <Field
              label={`明确截止时间（浏览器时区 ${Intl.DateTimeFormat().resolvedOptions().timeZone}）`}
            >
              <input
                type="datetime-local"
                className={inputCls}
                value={until}
                onChange={(e) => setUntil(e.target.value)}
              />
            </Field>
            {bf.ruleText && (
              <div className="whitespace-pre-wrap rounded bg-zinc-50 p-3 text-sm">
                来源规则：{bf.ruleText}
              </div>
            )}
            <Field label="有效期">
              <input
                className={inputCls}
                value={bf.validity}
                onChange={(e) => setBf({ ...bf, validity: e.target.value })}
              />
            </Field>
            <Field label="重置时区">
              <select
                className={inputCls}
                value={bf.tz}
                onChange={(e) => setBf({ ...bf, tz: e.target.value })}
              >
                <option value="">待确认</option>
                {["Asia/Shanghai", "UTC", "America/Los_Angeles"].map((t) => (
                  <option key={t}>{t}</option>
                ))}
              </select>
            </Field>
            <Field label="签到余额门槛">
              <input
                className={inputCls}
                value={bf.threshold}
                onChange={(e) => setBf({ ...bf, threshold: e.target.value })}
              />
            </Field>
            <Field label="投放时刻" hint="只记录投放时刻，不推导结束时刻">
              <input
                className={inputCls}
                placeholder="如 北京时间 10:00、19:00"
                value={bf.drops}
                onChange={(e) => setBf({ ...bf, drops: e.target.value })}
              />
            </Field>
            <Field
              label="可用窗口说明"
              hint="仅填写站点明确公布的窗口；留空显示「窗口未知」"
            >
              <input
                className={inputCls}
                value={bf.window}
                onChange={(e) => setBf({ ...bf, window: e.target.value })}
              />
            </Field>
            <Field
              label="已确认的可用窗口"
              hint="填写开始与结束时刻，使用上面的重置时区；跨午夜窗口支持。留空不限制调用。"
            >
              {(bf.windows || []).map((w, i) => (
                <div key={i} className="flex gap-2">
                  <input
                    aria-label="窗口开始"
                    type="time"
                    className={inputCls}
                    value={w.start}
                    onChange={(e) =>
                      setBf({
                        ...bf,
                        windows: bf.windows!.map((x, j) =>
                          j === i ? { ...x, start: e.target.value } : x,
                        ),
                      })
                    }
                  />
                  <input
                    aria-label="窗口结束"
                    type="time"
                    className={inputCls}
                    value={w.end}
                    onChange={(e) =>
                      setBf({
                        ...bf,
                        windows: bf.windows!.map((x, j) =>
                          j === i ? { ...x, end: e.target.value } : x,
                        ),
                      })
                    }
                  />
                  <Btn
                    onClick={() =>
                      setBf({
                        ...bf,
                        windows: bf.windows!.filter((_, j) => j !== i),
                      })
                    }
                  >
                    移除
                  </Btn>
                </div>
              ))}
              <Btn
                onClick={() =>
                  setBf({
                    ...bf,
                    windows: [
                      ...(bf.windows || []),
                      { start: "10:00", end: "19:00" },
                    ],
                  })
                }
              >
                添加已确认窗口
              </Btn>
            </Field>
          </div>
        )}
      </Drawer>
    </div>
  );
}
