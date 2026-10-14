import { type ReactNode, useEffect } from 'react'
import { X, CheckCircle2, AlertTriangle, XCircle, Clock, CircleDashed, Loader2, PauseCircle, GitCompare, CircleHelp } from 'lucide-react'
import type { Channel, Site, Account, Rules, ApplyState } from './data'

export type Tone = 'ok' | 'warn' | 'err' | 'info' | 'mute'
const toneCls: Record<Tone, string> = {
  ok: 'text-emerald-700 bg-emerald-50 ring-emerald-200',
  warn: 'text-amber-700 bg-amber-50 ring-amber-200',
  err: 'text-red-700 bg-red-50 ring-red-200',
  info: 'text-blue-700 bg-blue-50 ring-blue-200',
  mute: 'text-zinc-600 bg-zinc-100 ring-zinc-200',
}
const toneIcon: Record<Tone, typeof CheckCircle2> = { ok: CheckCircle2, warn: AlertTriangle, err: XCircle, info: Clock, mute: CircleDashed }

export function Badge({ tone = 'mute', children, icon }: { tone?: Tone; children: ReactNode; icon?: typeof CheckCircle2 | null }) {
  const I = icon === null ? null : icon || toneIcon[tone]
  return (
    <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium ring-1 ring-inset whitespace-nowrap ${toneCls[tone]}`}>
      {I && <I size={12} strokeWidth={1.75} />}
      {children}
    </span>
  )
}

export function Btn({ children, onClick, kind = 'default', size = 'md', disabled, type = 'button' }: { children: ReactNode; onClick?: () => void; kind?: 'default' | 'primary' | 'ghost' | 'danger'; size?: 'sm' | 'md'; disabled?: boolean; type?: 'button' | 'submit' }) {
  const k = {
    default: 'bg-white ring-1 ring-zinc-300 text-zinc-800 hover:bg-zinc-50',
    primary: 'bg-blue-600 text-white hover:bg-blue-700',
    ghost: 'text-zinc-700 hover:bg-zinc-100',
    danger: 'bg-white ring-1 ring-red-300 text-red-700 hover:bg-red-50',
  }[kind]
  return (
    <button type={type} disabled={disabled} onClick={onClick} className={`inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition disabled:opacity-40 disabled:cursor-not-allowed ${size === 'sm' ? 'h-7 px-2 text-xs' : 'h-8 px-3 text-sm'} ${k}`}>
      {children}
    </button>
  )
}

export const inputCls = 'h-8 w-full rounded-md border border-zinc-300 bg-white px-2.5 text-sm text-zinc-900 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100'

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-zinc-600">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-zinc-500">{hint}</span>}
    </label>
  )
}

export function Drawer({ open, onClose, title, sub, children, footer, wide }: { open: boolean; onClose: () => void; title: string; sub?: ReactNode; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onClose])
  if (!open) return null
  return (
    <div className="fixed inset-0 z-50">
      <div className="absolute inset-0 bg-zinc-900/30" onClick={onClose} />
      <aside className={`absolute right-0 top-0 flex h-full w-full flex-col bg-white shadow-xl ${wide ? 'sm:w-[720px]' : 'sm:w-[520px]'}`}>
        <header className="flex items-start justify-between gap-3 border-b border-zinc-200 px-5 py-4">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-zinc-900">{title}</h2>
            {sub && <div className="mt-0.5 text-xs text-zinc-500">{sub}</div>}
          </div>
          <button onClick={onClose} className="rounded p-1 text-zinc-500 hover:bg-zinc-100" aria-label="关闭">
            <X size={18} strokeWidth={1.75} />
          </button>
        </header>
        <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-zinc-200 px-5 py-3">{footer}</footer>}
      </aside>
    </div>
  )
}

export function Section({ title, extra, children, desc }: { title: string; extra?: ReactNode; children: ReactNode; desc?: ReactNode }) {
  return (
    <section className="rounded-lg border border-zinc-200 bg-white">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-200 px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold text-zinc-900">{title}</h2>
          {desc && <p className="mt-0.5 text-xs text-zinc-500">{desc}</p>}
        </div>
        {extra}
      </div>
      {children}
    </section>
  )
}

export function Url({ href, children }: { href: string; children?: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="break-all text-blue-700 hover:underline" onClick={(e) => e.stopPropagation()}>
      {children || href.replace(/^https?:\/\//, '')}
    </a>
  )
}

export function PageHead({ title, desc, extra }: { title: string; desc?: string; extra?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold text-zinc-900">{title}</h1>
        {desc && <p className="mt-1 text-sm text-zinc-500">{desc}</p>}
      </div>
      {extra}
    </div>
  )
}

export function chanStatus(c: Channel, site: Site, acct: Account | undefined, rules: Rules): { label: string; tone: Tone; icon?: typeof CheckCircle2 } {
  if (!c.enabled) return { label: c.keyMask === '未填写' ? '缺 key · 暂停' : '已暂停', tone: 'mute', icon: PauseCircle }
  if (site.issue === '限流') return { label: '限流', tone: 'warn' }
  if (site.issue) return { label: site.issue, tone: 'err' }
  if (acct && acct.balance === 0) return { label: '余额耗尽', tone: 'err' }
  if (site.category === 'rp') return { label: '人工固定', tone: 'info', icon: CheckCircle2 }
  if (site.category === 'client') return c.clientState === 'verified' ? { label: '已验证', tone: 'ok' } : { label: '待客户端确认', tone: 'warn', icon: Clock }
  if (c.samples < rules.samples) return { label: '待评价', tone: 'info', icon: CircleHelp }
  if ((c.success ?? 0) < rules.warn) return { label: '降级', tone: 'err' }
  if ((c.success ?? 0) < rules.good) return { label: '观察', tone: 'warn' }
  return { label: '开放', tone: 'ok' }
}

export function ApplyBadge({ a, cat }: { a: ApplyState; cat?: string }) {
  const tav = cat === 'rp'
  switch (a) {
    case 'saving':
      return <Badge tone="info" icon={Loader2}>保存中</Badge>
    case 'synced':
      return <Badge tone="ok">{tav ? '酒馆已同步' : '已生效'}</Badge>
    case 'pending':
      return <Badge tone="warn" icon={Clock}>{tav ? '待应用' : '待同步'}</Badge>
    case 'failed':
      return <Badge tone="err">{tav ? '同步失败' : '网关生效失败'}</Badge>
    case 'diff':
      return <Badge tone="warn" icon={GitCompare}>外部配置差异</Badge>
    case 'conflict':
      return <Badge tone="err" icon={GitCompare}>409 版本冲突</Badge>
  }
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="px-4 py-10 text-center text-sm text-zinc-500">{children}</div>
}

