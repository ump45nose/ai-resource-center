import { createContext, useContext, useState, type ReactNode } from 'react'
import { seed, type AppState, type Channel, type Account } from './data'

type Toast = { id: number; tone: 'ok' | 'err' | 'info'; text: string }
interface Store {
  s: AppState
  set: (f: (s: AppState) => AppState) => void
  updChannel: (id: string, p: Partial<Channel>) => void
  updAccount: (id: string, p: Partial<Account>) => void
  saveChannel: (id: string, p: Partial<Channel>) => void
  toast: (text: string, tone?: Toast['tone']) => void
  toasts: Toast[]
  query: string
  setQuery: (q: string) => void
  page: string
  go: (p: string, sub?: string) => void
  sub: string
}
const Ctx = createContext<Store>(null!)
export const useStore = () => useContext(Ctx)

export function StoreProvider({ children }: { children: ReactNode }) {
  const [s, setS] = useState<AppState>(seed)
  const [toasts, setToasts] = useState<Toast[]>([])
  const [query, setQuery] = useState('')
  const [page, setPage] = useState('today')
  const [sub, setSub] = useState('all')
  const toast = (text: string, tone: Toast['tone'] = 'ok') => {
    const id = Date.now() + Math.random()
    setToasts((t) => [...t, { id, tone, text }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3800)
  }
  const updChannel = (id: string, p: Partial<Channel>) =>
    setS((x) => ({ ...x, channels: x.channels.map((c) => (c.id === id ? { ...c, ...p } : c)) }))
  const updAccount = (id: string, p: Partial<Account>) =>
    setS((x) => ({ ...x, accounts: x.accounts.map((a) => (a.id === id ? { ...a, ...p } : a)) }))
  const saveChannel = (id: string, p: Partial<Channel>) => {
    const c = s.channels.find((x) => x.id === id)!
    const site = s.sites.find((x) => x.id === c.siteId)!
    updChannel(id, { ...p, apply: 'saving', applyMsg: undefined })
    setTimeout(() => {
      const v = c.version + 1
      if (site.category === 'rp') {
        updChannel(id, { version: v, apply: 'pending', applyMsg: '已保存到中心，待在酒馆应用' })
        toast(`已保存 v${v}，酒馆待应用`, 'info')
      } else if (site.category === 'client') {
        updChannel(id, { version: v, apply: 'synced', clientState: 'draft', applyMsg: '配置已变更，需重新生成并由客户端确认' })
        toast(`已保存 v${v}，需重新生成客户端配置`, 'info')
      } else if (c.id === 'c7') {
        updChannel(id, { version: v, apply: 'failed', applyMsg: 'New API 返回：渠道 #7 更新失败，上游权重字段被锁定，请在 New API 后台解锁后重试' })
        toast(`中心已保存 v${v}，但网关生效失败`, 'err')
      } else {
        updChannel(id, { version: v, apply: 'synced', applyMsg: `v${v} 已在 New API 生效` })
        toast(`保存成功 v${v}，New API 已生效`)
      }
    }, 1000)
  }
  const go = (p: string, sb = 'all') => {
    setPage(p)
    setSub(sb)
    window.scrollTo(0, 0)
  }
  return (
    <Ctx.Provider value={{ s, set: setS, updChannel, updAccount, saveChannel, toast, toasts, query, setQuery, page, go, sub }}>
      {children}
    </Ctx.Provider>
  )
}

