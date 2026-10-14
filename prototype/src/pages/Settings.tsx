import { useState } from 'react'
import { RefreshCw, ExternalLink, Upload, Check } from 'lucide-react'
import { useStore } from '../store'
import { Badge, Btn, Section, PageHead, Field, inputCls, Url, type Tone } from '../ui'
import type { Site, Account, Channel } from '../data'

type Row = { id: string; name: string; url: string; kind: '新增' | '合并' | '用途冲突' | '缺 key'; detail: string; pick: boolean; use?: string }
const preview = (): Row[] => [
  { id: 'i1', name: 'Nova AI', url: 'https://nova.example.com', kind: '新增', detail: '1 账号 · 1 渠道 · 通用', pick: true },
  { id: 'i2', name: 'OpenRouter', url: 'https://openrouter.ai', kind: '合并', detail: '与现有站点同网址，合并 1 个新账号', pick: true },
  { id: 'i3', name: 'RP 小站', url: 'https://rp.example.com', kind: '用途冲突', detail: '导入标记为「通用」，中心为「RP」', pick: true, use: 'RP（保留中心）' },
  { id: 'i4', name: 'Echo Relay', url: 'https://echo.example.org', kind: '缺 key', detail: '仅有站点和余额，无凭据；导入后渠道为暂停', pick: false },
]
const kt: Record<Row['kind'], Tone> = { 新增: 'ok', 合并: 'info', 用途冲突: 'warn', '缺 key': 'err' }

export default function Settings() {
  const { s, set, toast } = useStore()
  const [rules, setRules] = useState(s.rules)
  const [tm, setTm] = useState(s.tmUrl)
  const [step, setStep] = useState(1)
  const [src, setSrc] = useState('All API Hub 导出')
  const [file, setFile] = useState('')
  const [rows, setRows] = useState<Row[]>(preview)
  const retry = (name: string) => {
    set((x) => ({ ...x, integrations: x.integrations.map((i) => (i.name === name ? { ...i, state: 'pending' } : i)) }))
    setTimeout(() => {
      set((x) => ({ ...x, integrations: x.integrations.map((i) => (i.name === name ? { ...i, state: 'ok', last: '刚刚', error: undefined } : i)) }))
      toast(`${name} 同步成功`)
    }, 900)
  }
  const confirm = () => {
    const picked = rows.filter((r) => r.pick)
    set((x) => {
      const sites: Site[] = [...x.sites], accounts: Account[] = [...x.accounts], channels: Channel[] = [...x.channels]
      picked.filter((r) => r.kind === '新增' || r.kind === '缺 key').forEach((r) => {
        const id = 'imp' + r.id
        if (sites.some((z) => z.id === id)) return
        sites.push({ id, name: r.name, url: r.url, category: 'general', issue: r.kind === '缺 key' ? '缺 key' : undefined })
        accounts.push({ ...x.accounts[1], id: 'a' + id, siteId: id, name: 'import@demo', balance: null, confirmedAt: '—' })
        channels.push({ ...x.channels[1], id: 'c' + id, siteId: id, accountId: 'a' + id, name: r.name + '-通用', baseUrl: r.url + '/v1', keyMask: r.kind === '缺 key' ? '未填写' : 'sk-demo-••••imp1', enabled: r.kind !== '缺 key', samples: 0, success: null, priority: 0, reason: '新导入 · 待评价', version: 1, apply: 'pending', applyMsg: '新导入，待同步到 New API' })
      })
      return { ...x, sites, accounts, channels }
    })
    toast(`已导入 ${picked.length} 项（未测试 RP）`)
    setStep(1); setRows(preview()); setFile('')
  }
  return (
    <div>
      <PageHead title="设置" />
      <div className="grid gap-5">
        <Section title="外部接入" desc="中心只读取与写入配置；实际调用由各服务处理">
          <ul className="divide-y divide-zinc-100">
            {s.integrations.map((i) => (
              <li key={i.name} className="grid gap-2 px-4 py-3 text-sm sm:grid-cols-[160px_1fr_auto] sm:items-center">
                <div className="font-medium">{i.name}</div>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2 text-xs"><Url href={i.url} />{i.state === 'ok' ? <Badge tone="ok">已连接</Badge> : i.state === 'failed' ? <Badge tone="err">同步失败</Badge> : <Badge tone="warn">待同步</Badge>}<span className="text-zinc-500">最后同步 {i.last}</span></div>
                  {i.error && <div className="mt-1 text-xs text-red-700">原因：{i.error}</div>}
                </div>
                <Btn size="sm" onClick={() => retry(i.name)}><RefreshCw size={13} />{i.state === 'failed' ? '重试' : '同步'}</Btn>
              </li>
            ))}
          </ul>
        </Section>
        <div className="grid gap-5 lg:grid-cols-2">
          <Section title="评价窗口与阈值">
            <div className="grid grid-cols-2 gap-3 p-4">
              <Field label="窗口（天）"><input type="number" className={inputCls} value={rules.days} onChange={(e) => setRules({ ...rules, days: +e.target.value })} /></Field>
              <Field label="最少样本"><input type="number" className={inputCls} value={rules.samples} onChange={(e) => setRules({ ...rules, samples: +e.target.value })} /></Field>
              <Field label="开放阈值 %"><input type="number" className={inputCls} value={rules.good} onChange={(e) => setRules({ ...rules, good: +e.target.value })} /></Field>
              <Field label="降级阈值 %"><input type="number" className={inputCls} value={rules.warn} onChange={(e) => setRules({ ...rules, warn: +e.target.value })} /></Field>
              <div className="col-span-2 flex justify-end gap-2"><Btn onClick={() => setRules({ days: 7, samples: 30, good: 98, warn: 95 })}>恢复默认</Btn><Btn kind="primary" onClick={() => { set((x) => ({ ...x, rules })); toast('评价规则已保存，状态已重新计算') }}>保存</Btn></div>
            </div>
          </Section>
          <Section title="Token Monitor">
            <div className="grid gap-3 p-4">
              <Field label="地址" hint="用量与费用在 Token Monitor 查看，中心不重复统计"><input className={inputCls} value={tm} onChange={(e) => setTm(e.target.value)} /></Field>
              <div className="flex justify-between"><a href={tm} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm text-blue-700 hover:underline">打开 Token Monitor<ExternalLink size={13} /></a><Btn kind="primary" onClick={() => { set((x) => ({ ...x, tmUrl: tm })); toast('已保存') }}>保存</Btn></div>
            </div>
          </Section>
        </div>
        <Section title="导入" desc="导入只写入中心，不自动测试 RP 连接">
          <div className="p-4">
            <ol className="mb-4 flex flex-wrap gap-4 text-sm">
              {['选择来源', '预览', '确认导入'].map((l, i) => (
                <li key={l} className={`flex items-center gap-2 ${step === i + 1 ? 'font-medium text-zinc-900' : step > i + 1 ? 'text-emerald-700' : 'text-zinc-400'}`}>
                  <span className={`flex h-5 w-5 items-center justify-center rounded-full text-xs ring-1 ${step === i + 1 ? 'bg-blue-600 text-white ring-blue-600' : 'ring-current'}`}>{step > i + 1 ? <Check size={12} /> : i + 1}</span>{l}
                </li>
              ))}
            </ol>
            {step === 1 && (
              <div className="grid max-w-xl gap-3">
                <Field label="来源"><select className={inputCls} value={src} onChange={(e) => setSrc(e.target.value)}><option>All API Hub 导出</option><option>New API 渠道</option><option>上传 JSON 文件</option></select></Field>
                {src === '上传 JSON 文件' && <label className="flex cursor-pointer items-center gap-2 rounded-md border border-dashed border-zinc-300 px-3 py-4 text-sm text-zinc-600 hover:bg-zinc-50"><Upload size={16} />{file || '选择 .json 文件（仅本地解析，演示）'}<input type="file" accept=".json" className="hidden" onChange={(e) => setFile(e.target.files?.[0]?.name || '')} /></label>}
                <div><Btn kind="primary" disabled={src === '上传 JSON 文件' && !file} onClick={() => setStep(2)}>读取并预览</Btn></div>
              </div>
            )}
            {step === 2 && (
              <div>
                <div className="mb-2 text-xs text-zinc-500">来源：{src}{file && ` · ${file}`} · 共 {rows.length} 项</div>
                <ul className="divide-y divide-zinc-100 rounded-md ring-1 ring-zinc-200">
                  {rows.map((r) => (
                    <li key={r.id} className="grid gap-2 px-3 py-2.5 text-sm sm:grid-cols-[24px_80px_1fr_200px] sm:items-center">
                      <input type="checkbox" checked={r.pick} onChange={(e) => setRows(rows.map((x) => (x.id === r.id ? { ...x, pick: e.target.checked } : x)))} />
                      <Badge tone={kt[r.kind]}>{r.kind}</Badge>
                      <div><div className="font-medium">{r.name} <span className="text-xs font-normal"><Url href={r.url} /></span></div><div className="text-xs text-zinc-500">{r.detail}</div></div>
                      {r.kind === '用途冲突' ? <select className={inputCls} value={r.use} onChange={(e) => setRows(rows.map((x) => (x.id === r.id ? { ...x, use: e.target.value } : x)))}><option>RP（保留中心）</option><option>通用（采用导入）</option></select> : <span />}
                    </li>
                  ))}
                </ul>
                <div className="mt-3 flex gap-2"><Btn onClick={() => setStep(1)}>上一步</Btn><Btn kind="primary" disabled={!rows.some((r) => r.pick)} onClick={() => setStep(3)}>下一步</Btn></div>
              </div>
            )}
            {step === 3 && (
              <div className="max-w-xl text-sm">
                <ul className="mb-3 space-y-1 text-zinc-700">
                  {(['新增', '合并', '用途冲突', '缺 key'] as const).map((k) => <li key={k}>{k}：{rows.filter((r) => r.pick && r.kind === k).length} 项</li>)}
                </ul>
                <p className="mb-3 rounded bg-zinc-50 px-3 py-2 text-xs text-zinc-600">确认后写入中心演示数据；通用渠道标记为「待同步」，RP 连接不发出任何测试请求。</p>
                <div className="flex gap-2"><Btn onClick={() => setStep(2)}>上一步</Btn><Btn kind="primary" onClick={confirm}>确认导入</Btn></div>
              </div>
            )}
          </div>
        </Section>
      </div>
    </div>
  )
}

