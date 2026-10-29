import { ArrowUpRight, CalendarCheck2 } from "lucide-react";
import { Badge, EmptyState, SectionHeading } from "../components";
import { amount, dateTime, hubCheckinStatus, isHubAccount } from "../data";
import { useWorkspace } from "../workspace";
export default function Benefits() {
  const { sites, query, inspectSite } = useWorkspace();
  const rows = sites.filter((s) =>
    `${s.name} ${s.websiteUrl}`.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <>
      <SectionHeading
        title="账号与签到"
        meta="余额保留原单位；签到历史来自已收到的记录"
      />
      <div className="benefit-list">
        {rows.map((s) => (
          <article className="benefit-row" key={s.id}>
            <div className="benefit-row-head">
              <button className="site-title" onClick={() => inspectSite(s.id)}>
                {s.name}
              </button>
              {s.checkinUrl && (
                <a
                  className="text-link"
                  href={s.checkinUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  签到入口
                  <ArrowUpRight size={14} />
                </a>
              )}
            </div>
            {s.accounts.map((a) => {
              const executor = a.checkinAccount || a;
              const status = isHubAccount(executor)
                ? hubCheckinStatus(executor)
                : null;
              return (
                <div key={a.id}>
                  <div className="benefit-account">
                    <div>
                      <strong>{a.name}</strong>
                      <span>{a.entitlement.balanceBasis === "fixed_daily" ? "每日固定额度" : "余额"} {amount(a.balance, a.unit)}</span>
                    </div>
                    <Badge tone={status?.tone || "neutral"}>
                      {status
                        ? status.label
                        : a.checkins[0]
                          ? `${a.checkins[0].businessDate} · ${a.checkins[0].result}`
                          : "暂无签到结果"}
                    </Badge>
                    <div className="benefit-expiry">
                      <strong>
                        {a.benefit?.renewal === "automatic"
                          ? `每日自动刷新 ${a.benefit.dailyLimit ?? "待确认"} ${a.unit || ""} · 无需签到`
                          : a.quota === "daily"
                            ? "当日额度"
                            : "长期 / 待确认"}
                      </strong>
                      {a.entitlement.balanceBasis !== "fixed_daily" &&
                        <span>余额观察 {dateTime(a.confirmedAt)}</span>}
                    </div>
                  </div>
                  {a.checkins.length > 0 && (
                    <details className="model-disclosure">
                      <summary>签到历史 · 最近 {a.checkins.length} 条</summary>
                      {a.checkins.map((checkin) => (
                        <div className="account-row" key={checkin.eventId}>
                          <span>{checkin.businessDate}</span>
                          <span>{checkin.method || "签到"}</span>
                          <Badge
                            tone={
                              ["成功", "已签到"].includes(checkin.result)
                                ? "green"
                                : checkin.result === "失败"
                                  ? "red"
                                  : "neutral"
                            }
                          >
                            {checkin.result}
                          </Badge>
                          {checkin.reward && <span>{checkin.reward}</span>}
                          {checkin.reason && (
                            <span className="muted">{checkin.reason}</span>
                          )}
                        </div>
                      ))}
                    </details>
                  )}
                  {a.benefit?.ruleText && (
                    <details className="model-disclosure">
                      <summary>签到与额度规则</summary>
                      <p className="rule-line preserve-lines">
                        {a.benefit.ruleText}
                      </p>
                    </details>
                  )}
                </div>
              );
            })}
          </article>
        ))}
      </div>
      {!rows.length && (
        <EmptyState
          icon={CalendarCheck2}
          title="暂无匹配账号"
          description="在“接入与同步”配对 All API Hub，或调整搜索条件。"
        />
      )}
    </>
  );
}
