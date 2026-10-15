import { useState } from 'react'
import { Sun, Boxes, CalendarCheck, Gauge, Settings as Cog, Search, Menu, X, RefreshCw } from 'lucide-react'
import { StoreProvider, useStore } from './store'
import Today from './pages/Today'
import Resources from './pages/Resources'
import Checkin from './pages/Checkin'
import Eval from './pages/Eval'
import Settings from './pages/Settings'

const nav = [
  { k: 'today', l: '今日', i: Sun },
  { k: 'resources', l: '资源与连接', i: Boxes },
  { k: 'checkin', l: '签到与权益', i: CalendarCheck },
  { k: 'eval', l: '渠道评价', i: Gauge },
  { k: 'settings', l: '设置', i: Cog },
]

function Shell() {
  const { page, go, query, setQuery, toasts, s } = useStore()
  const [menu, setMenu] = useState(false)
  const failed = s.integrations.filter((i) => i.state === 'failed').length
  const Nav = (
    <nav className="flex flex-col gap-0.5 p-3">
      {nav.map(({ k, l, i: I }) => (
        <button key={k} onClick={() => { go(k); setMenu(false) }} className={`flex h-9 items-center gap-2.5 rounded-md px-3 text-sm ${page === k ? 'bg-blue-50 font-medium text-blue-700' : 'text-zinc-700 hover:bg-zinc-100'}`}>
          <I size={17} strokeWidth={1.6} />{l}
        </button>
      ))}
    </nav>
  )
  return (
    <div className="min-h-screen bg-zinc-100/70 text-zinc-900">
      <aside className="fixed inset-y-0 left-0 hidden w-56 border-r border-zinc-200 bg-white lg:block">
        <div className="flex h-14 items-center border-b border-zinc-200 px-5 text-[15px] font-semibold">AI 资源中心</div>
        {Nav}
      </aside>
      {menu && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-zinc-900/30" onClick={() => setMenu(false)} />
          <aside className="absolute inset-y-0 left-0 w-64 bg-white shadow-xl">
            <div className="flex h-14 items-center justify-between border-b border-zinc-200 px-5 font-semibold">AI 资源中心<button aria-label="关闭菜单" onClick={() => setMenu(false)}><X size={18} /></button></div>
            {Nav}
          </aside>
        </div>
      )}
      <div className="min-w-0 lg:pl-56">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-zinc-200 bg-white/95 px-4 backdrop-blur sm:px-6">
          <button className="lg:hidden" aria-label="菜单" onClick={() => setMenu(true)}><Menu size={20} strokeWidth={1.6} /></button>
          <span className="font-semibold lg:hidden">AI 资源中心</span>
          <div className="relative ml-auto w-full max-w-sm max-sm:hidden lg:ml-0">
            <Search size={15} className="absolute left-2.5 top-2 text-zinc-400" />
            <input value={query} onChange={(e) => { setQuery(e.target.value); if (page !== 'resources') go('resources') }} placeholder="搜索站点、网址、模型" className="h-8 w-full rounded-md border border-zinc-200 bg-zinc-50 pl-8 pr-2 text-sm outline-none focus:border-blue-500 focus:bg-white" />
          </div>
          <div className="ml-auto flex items-center gap-3 text-xs text-zinc-500">
            <span className="hidden items-center gap-1 md:flex"><RefreshCw size={13} />同步 09:42{failed > 0 && <button onClick={() => go('settings')} className="text-red-700 hover:underline">· {failed} 个失败</button>}</span>
            <span className="text-zinc-400">演示数据</span>
          </div>
        </header>
        <div className="border-b border-zinc-200 bg-white px-4 py-2 sm:hidden">
          <div className="relative"><Search size={15} className="absolute left-2.5 top-2 text-zinc-400" /><input value={query} onChange={(e) => { setQuery(e.target.value); if (page !== 'resources') go('resources') }} placeholder="搜索站点、网址、模型" className="h-8 w-full rounded-md border border-zinc-200 bg-zinc-50 pl-8 text-sm outline-none" /></div>
        </div>
        <main className="mx-auto min-w-0 max-w-[1360px] px-4 py-6 sm:px-6">
          {page === 'today' && <Today />}
          {page === 'resources' && <Resources />}
          {page === 'checkin' && <Checkin />}
          {page === 'eval' && <Eval />}
          {page === 'settings' && <Settings />}
        </main>
      </div>
      <div className="fixed bottom-4 left-1/2 z-[60] flex w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 flex-col gap-2">
        {toasts.map((t) => (
          <div key={t.id} role="status" className={`rounded-md px-3 py-2 text-sm shadow-lg ring-1 ${t.tone === 'err' ? 'bg-red-50 text-red-800 ring-red-200' : t.tone === 'info' ? 'bg-white text-zinc-800 ring-zinc-200' : 'bg-zinc-900 text-white ring-zinc-900'}`}>{t.text}</div>
        ))}
      </div>
    </div>
  )
}

export default function App() {
  return <StoreProvider><Shell /></StoreProvider>
}

