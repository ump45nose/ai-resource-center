import { ArrowRight, ExternalLink, Activity } from 'lucide-react'
import { useStore } from '../store'
import { Amount, Badge, Section, Url, chanStatus, PageHead, ApplyBadge, Btn, type Tone } from '../ui'
import { TODAY, catLabel } from '../data'

export default function Today() {
  const { s, go } = useStore()
  const site = (id: string) => s.sites.find((x) => x.id === id)!
  const acct = (id: string) => s.accounts.find((x) => x.id === id)
  const daily = s.accounts.filter((a) => a.quota === 'daily' && a.balance)
  const unknown = s.accounts.filter((a) => a.balance === null).length
  const todo = s.accounts.filter((a) => ['待确认', '需登录', '需人工操作', '未执行', '失败'].includes(a.checkin[TODAY]?.status))
  const expiring = s.accounts.filter((a) => a.expires && a.balance)

  const prio = s.channels
    .filter((c) => c.enabled && !['rp', 'client'].includes(c.category))
    .map((c) => ({ c, st: chanStatus(c, site(c.siteId), acct(c.accountId), s.rules) }))
    .filter((x) => ['开放', '待评价', '观察', '限流'].includes(x.st.label))
    .sort((a, b) => b.c.priority - a.c.priority)
    .slice(0, 5)

  type Todo = { key: string; tone: Tone; title: string; reason: string; act: string; to: () => void }
  const items: Todo[] = []
  const why: Record<string, string> = { 账号验证: '账号需验证，请登录站点完成验证', '缺 key': '账号已有余额，但渠道未填写 key', 网站打不开: '站点无法访问（DNS 无响应），已暂停', 余额耗尽: '余额为 0，已从路由降为 0', 'HTTP 502': '近 1 小时 6 次 HTTP 502，已降权', 限流: '上游返回 429，自动降低频率' }
  s.sites.filter((x) => x.issue).forEach((x) => { items.push({ key: x.id, tone: x.issue === '限流' ? 'warn' : 'err', title: x.name, reason: why[x.issue!], act: '查看', to: () => go('resources', 'issue') }) })
  s.channels.filter((c) => ['failed', 'conflict', 'diff', 'pending'].includes(c.apply)).forEach((c) => { items.push({ key: c.id + 'a', tone: c.apply === 'pending' || c.apply === 'diff' ? 'warn' : 'err', title: `${c.name} 配置`, reason: c.apply === 'conflict' ? '409 版本冲突：酒馆中已被修改' : c.applyMsg || '中心已保存，待在酒馆应用', act: '处理', to: () => go('resources', c.category === 'rp' ? 'rp' : 'issue') }) })
  todo.forEach((a) => { items.push({ key: a.id + 'k', tone: 'warn', title: `${site(a.siteId).name} 签到`, reason: `今日${a.checkin[TODAY].status}`, act: '去签到', to: () => go('checkin') }) })
  s.integrations.filter((i) => i.state === 'failed').forEach((i) => { items.push({ key: i.name, tone: 'err', title: `${i.name} 同步`, reason: i.error || '同步失败', act: '设置', to: () => go('settings') }) })

  return (
    <div>
      <PageHead title="今日" desc={`${TODAY} · 北京时间 · 余额以最后确认时间为准`} extra={<a href={s.tmUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-sm text-blue-700 hover:underline"><Activity size={15} strokeWidth={1.75} />Token Monitor 用量<ExternalLink size={13} /></a>} />
      <div className="mb-5 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-zinc-200 bg-zinc-200 lg:grid-cols-4">
        {[
          { l: '有当日额度的账号', v: String(daily.length), d: `余额待确认 ${unknown} 个 · 各站单位不同，不合计` },
          { l: '待签到', v: String(todo.length), d: todo.map((a) => site(a.siteId).name).slice(0, 3).join('、') || '全部完成' },
          { l: '即将到期', v: String(expiring.length), d: expiring.map((a) => `${site(a.siteId).name} ${a.expires}`).slice(0, 2).join('、') },
          { l: '待处理', v: String(items.length), d: '错误、冲突、待应用' },
        ].map((k) => (
          <div key={k.l} className="bg-white px-4 py-3">
            <div className="text-xs text-zinc-500">{k.l}</div>
            <div className="mt-1 text-2xl font-semibold tabular-nums text-zinc-900">{k.v}</div>
            <div className="mt-0.5 truncate text-xs text-zinc-500">{k.d}</div>
          </div>
        ))}
      </div>
      <div className="grid gap-5 xl:grid-cols-[1.3fr_1fr]">
        <Section title="优先使用" desc="按 New API 当前优先级；RP 与客户端绑定资源不参与" extra={<Btn size="sm" kind="ghost" onClick={() => go('eval')}>渠道评价<ArrowRight size={13} /></Btn>}>
          <ul className="divide-y divide-zinc-100">
            {prio.map(({ c, st }, i) => {
              const a = acct(c.accountId)
              return (
                <li key={c.id} className="grid grid-cols-[24px_1fr] gap-3 px-4 py-3 sm:grid-cols-[24px_1fr_auto]">
                  <span className="pt-0.5 text-sm tabular-nums text-zinc-400">{i + 1}</span>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2"><span className="font-medium text-zinc-900">{c.name}</span><Badge tone={st.tone} icon={st.icon}>{st.label}</Badge><span className="text-xs text-zinc-500">{catLabel[c.category]}</span></div>
                    <div className="mt-0.5 text-xs text-zinc-500"><Url href={site(c.siteId).url} /> · {c.models.slice(0, 2).join(', ')}</div>
                    <div className="mt-0.5 text-xs text-zinc-600">原因：{c.reason}</div>
                  </div>
                  <div className="col-start-2 text-left text-xs sm:col-start-3 sm:text-right">
                    <div className="font-medium tabular-nums text-zinc-900"><Amount a={a} /></div>
                    <div className="text-zinc-500">{a?.quota === 'daily' ? '当日' : '长期'} · 确认 {a?.confirmedAt}</div>
                    <div className="text-zinc-500">观测 {c.success == null ? '—' : c.success + '%'} · {c.samples} 样本</div>
                  </div>
                </li>
              )
            })}
          </ul>
        </Section>
        <Section title="需要处理" desc={`${items.length} 项`}>
          <ul className="divide-y divide-zinc-100">
            {items.map((t) => (
              <li key={t.key} className="flex items-start gap-3 px-4 py-2.5">
                <Badge tone={t.tone}>{t.tone === 'err' ? '错误' : '待办'}</Badge>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-zinc-900">{t.title}</div>
                  <div className="text-xs text-zinc-600">{t.reason}</div>
                </div>
                <Btn size="sm" onClick={t.to}>{t.act}</Btn>
              </li>
            ))}
          </ul>
        </Section>
      </div>
      <div className="mt-5">
        <Section title="RP 与客户端绑定（独立维护）">
          <ul className="divide-y divide-zinc-100">
            {s.channels.filter((c) => ['rp', 'client'].includes(c.category)).map((c) => (
              <li key={c.id} className="flex flex-wrap items-center gap-2 px-4 py-2.5 text-sm">
                <span className="w-28 font-medium">{c.name}</span>
                <span className="text-xs text-zinc-500">{c.category === 'rp' ? '酒馆直连 · 禁测活' : c.client}</span>
                <span className="ml-auto flex gap-2">{c.category === 'rp' ? <ApplyBadge a={c.apply} cat="rp" /> : <Badge tone={c.clientState === 'verified' ? 'ok' : 'warn'}>{c.clientState === 'verified' ? '已验证' : c.clientState === 'awaiting' ? '待客户端确认' : '待生成配置'}</Badge>}{!c.enabled && <Badge>已暂停</Badge>}</span>
              </li>
            ))}
          </ul>
        </Section>
      </div>
    </div>
  )
}
