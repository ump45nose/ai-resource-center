import { useState } from 'react'
import { ClipboardCheck, Play, Square } from 'lucide-react'
import { useStore } from '../store'
import { Badge, Btn, Section, PageHead, Field, inputCls, chanStatus } from '../ui'
import { ConfigDrawer } from '../shared'
import type { Evaluation } from '../data'

export default function Eval() {
  const { s, set, toast } = useStore()
  const r = s.rules
  const site = (id: string) => s.sites.find((x) => x.id === id)!
  const pub = s.channels.filter((c) => ['general', 'media'].includes(c.category)).sort((a, b) => b.priority - a.priority)
  // RP 连接只人工维护：不参与任务评估，也不进入公共网关评分
  const evalable = s.channels.filter((c) => c.category !== 'rp' && (c.enabled || c.category === 'client'))
  const [chId, setChId] = useState('c1')
  const ch = s.channels.find((c) => c.id === chId)!
  const [model, setModel] = useState(ch.models[0])
  const [client, setClient] = useState('Claude Code')
  const [title, setTitle] = useState('修复设置页表单校验')
  const [cfg, setCfg] = useState(false)
  const [endDraft, setEndDraft] = useState<Record<string, { summary: string; rating: Evaluation['rating'] }>>({})
  const updE = (id: string, p: Partial<Evaluation>) => set((x) => ({ ...x, evals: x.evals.map((e) => (e.id === id ? { ...e, ...p } : e)) }))
  const now = () => new Date().toTimeString().slice(0, 5)

  return (
    <div>
      <PageHead title="渠道评价" desc={`优先级：当日优 400 · 当日常规 300 · 长期优 200 · 长期常规 100 · 备用 0；默认规则：近 ${r.days} 天 · 至少 ${r.samples} 样本 · 观测成功率 ≥${r.good}% 开放，<${r.warn}% 降级；样本不足保留原路由`} />
      <Section title="公共网关渠道（New API 自动调整）" desc="RP 与客户端绑定资源不进入公共网关调整">
        <div className="overflow-x-auto">
          <table className="hidden w-full text-sm md:table">
            <thead className="bg-zinc-50 text-xs text-zinc-500"><tr className="[&>th]:px-3 [&>th]:py-2 [&>th]:text-left [&>th]:font-normal">
              <th>渠道</th><th className="!text-right">样本</th><th className="!text-right">观测成功率</th><th className="!text-right">首字延迟</th><th className="!text-right">流式断连</th><th>最后观察</th><th>人工评价</th><th className="!text-right">优先级</th><th>调整理由</th>
            </tr></thead>
            <tbody className="divide-y divide-zinc-100">
              {pub.map((c) => {
                const st = chanStatus(c, site(c.siteId), undefined, r)
                return (
                  <tr key={c.id} className="[&>td]:px-3 [&>td]:py-2.5 align-top">
                    <td><div className="font-medium">{c.name}</div><Badge tone={st.tone} icon={st.icon}>{st.label}</Badge></td>
                    <td className="text-right tabular-nums">{c.samples}</td>
                    <td className="text-right tabular-nums">{c.media ? <span className="text-xs">完成 {c.media.done} · 失败 {c.media.failed} · pending {c.media.pending}</span> : c.samples < r.samples || c.success == null ? <span className="text-blue-700">待评价</span> : `${c.success}%`}</td>
                    <td className="text-right tabular-nums">{c.ttft ? `${c.ttft} ms` : '—'}</td>
                    <td className="text-right tabular-nums">{c.disconnects}</td>
                    <td className="text-xs text-zinc-600">{c.lastSeen}</td>
                    <td>{c.rating || <span className="text-zinc-400">未评</span>}</td>
                    <td className="text-right tabular-nums">{c.priority}</td>
                    <td className="max-w-56 text-xs text-zinc-600">{c.reason}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          <ul className="divide-y divide-zinc-100 md:hidden">
            {pub.map((c) => {
              const st = chanStatus(c, site(c.siteId), undefined, r)
              return (
                <li key={c.id} className="px-4 py-3 text-sm">
                  <div className="flex items-center justify-between"><span className="font-medium">{c.name}</span><Badge tone={st.tone} icon={st.icon}>{st.label}</Badge></div>
                  <div className="mt-1 grid grid-cols-2 gap-x-3 text-xs text-zinc-600">
                    <span>样本 {c.samples}</span><span>观测 {c.media ? `完成${c.media.done}/失败${c.media.failed}/pending${c.media.pending}` : c.samples < r.samples ? '待评价' : c.success + '%'}</span>
                    <span>首字 {c.ttft ?? '—'} ms</span><span>断连 {c.disconnects}</span><span>优先级 {c.priority}</span><span>最后 {c.lastSeen}</span>
                  </div>
                  <div className="mt-1 text-xs text-zinc-500">理由：{c.reason}</div>
                </li>
              )
            })}
          </ul>
        </div>
        <p className="border-t border-zinc-100 px-4 py-2 text-xs text-zinc-500">图像/视频：提交成功不等于生成成功，按任务完成/失败计。观测成功率只反映已采集样本，不构成可用性承诺。</p>
      </Section>

      <div className="mt-5 grid gap-5 xl:grid-cols-[360px_1fr]">
        <Section title="人工任务评估" desc="在你现有的 Agent 中执行；中心只登记，不启动 Agent。RP 连接不参与评估">
          <div className="grid gap-3 p-4">
            <Field label="渠道"><select className={inputCls} value={chId} onChange={(e) => { setChId(e.target.value); setModel(s.channels.find((c) => c.id === e.target.value)!.models[0]) }}>{evalable.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
            <Field label="模型"><select className={inputCls} value={model} onChange={(e) => setModel(e.target.value)}>{ch.models.map((m) => <option key={m}>{m}</option>)}</select></Field>
            <Field label="客户端"><select className={inputCls} value={client} onChange={(e) => setClient(e.target.value)}>{['Claude Code', 'Codex', 'OpenCode', 'Magpie', 'Hermes Chat', 'Hermes Cron'].map((m) => <option key={m}>{m}</option>)}</select></Field>
            <Field label="任务标题"><input className={inputCls} value={title} onChange={(e) => setTitle(e.target.value)} /></Field>
            <Btn kind="primary" disabled={!title.trim()} onClick={() => setCfg(true)}><ClipboardCheck size={14} />准备评估配置</Btn>
          </div>
        </Section>
        <Section title="评估登记">
          <ul className="divide-y divide-zinc-100">
            {s.evals.map((e) => {
              const c = s.channels.find((x) => x.id === e.channelId)
              const d = endDraft[e.id] || { summary: '', rating: '' as const }
              return (
                <li key={e.id} className="px-4 py-3 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{e.title}</span>
                    <Badge tone={e.state === 'ended' ? 'ok' : e.state === 'started' ? 'info' : 'mute'}>{e.state === 'ended' ? '已结束' : e.state === 'started' ? '进行中' : '已准备'}</Badge>
                    {e.rating && <Badge tone={e.rating === '差' ? 'err' : 'ok'} icon={null}>人工评价 {e.rating}</Badge>}
                  </div>
                  <div className="mt-0.5 text-xs text-zinc-500">{c?.name} · {e.model} · {e.client} · 请求级记录：<span className="text-amber-700">未采集</span></div>
                  <div className="text-xs text-zinc-500">开始 {e.startedAt || '—'} · 结束 {e.endedAt || '—'}</div>
                  {e.summary && <div className="mt-1 text-xs text-zinc-700">摘要：{e.summary}</div>}
                  {e.state === 'prepared' && <div className="mt-2"><Btn size="sm" onClick={() => { updE(e.id, { state: 'started', startedAt: now() }); toast('已登记开始') }}><Play size={13} />登记已开始</Btn></div>}
                  {e.state === 'started' && (
                    <div className="mt-2 grid gap-2 sm:grid-cols-[1fr_90px_auto]">
                      <input className={inputCls} placeholder="任务摘要（如：完成，需 2 次人工修正）" value={d.summary} onChange={(x) => setEndDraft({ ...endDraft, [e.id]: { ...d, summary: x.target.value } })} />
                      <select className={inputCls} value={d.rating} onChange={(x) => setEndDraft({ ...endDraft, [e.id]: { ...d, rating: x.target.value as Evaluation['rating'] } })}><option value="">评价</option><option>优</option><option>良</option><option>差</option></select>
                      <Btn size="sm" kind="primary" disabled={!d.summary || !d.rating} onClick={() => { updE(e.id, { state: 'ended', endedAt: now(), ...d }); toast('已登记结束与人工评价') }}><Square size={12} />登记结束</Btn>
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
          <p className="border-t border-zinc-100 px-4 py-2 text-xs text-zinc-500">任务完成与 PR 合入不等于渠道质量；人工评价仅作为调整参考。</p>
        </Section>
      </div>
      {cfg && <ConfigDrawer id={chId} client={client} title={`评估配置 · ${title}`} note="指定渠道，不可切换备用" onClose={() => setCfg(false)} onDone={() => {
        set((x) => ({ ...x, evals: [{ id: 'e' + Date.now(), channelId: chId, model, client, title, state: 'prepared', summary: '', rating: '' }, ...x.evals] }))
        setCfg(false); toast('评估已准备，请在你的 Agent 中执行', 'info')
      }} />}
    </div>
  )
}
