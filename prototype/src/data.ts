export type Category = 'general' | 'media' | 'rp' | 'client'
export type CheckinStatus = '成功' | '已签到' | '失败' | '待确认' | '需登录' | '需人工操作' | '未执行' | '无法签到'
export type ApplyState = 'synced' | 'pending' | 'saving' | 'failed' | 'diff' | 'conflict'
export type ClientState = 'draft' | 'awaiting' | 'verified'

export interface Header { name: string; value: string }
export interface Channel {
  id: string
  siteId: string
  accountId: string
  category: Category
  name: string
  baseUrl: string
  protocol: string
  models: string[]
  keyMask: string
  bindings: string[]
  enabled: boolean
  mode: 'auto' | 'manual'
  rating: '' | '优' | '良' | '差'
  note: string
  version: number
  apply: ApplyState
  applyMsg?: string
  order: number
  client?: string
  headers: Header[]
  clientState?: ClientState
  samples: number
  success: number | null
  ttft: number | null
  disconnects: number
  lastSeen: string
  priority: number
  reason: string
  media?: { pending: number; done: number; failed: number }
  external?: Partial<Channel>
}
export interface Benefit {
  pool: 'daily' | 'long'
  validity: string
  tz: string
  threshold: string
  drops: string
  window: string
}
export interface Account {
  id: string
  siteId: string
  name: string
  balance: number | null
  unit: string
  quota: 'daily' | 'long'
  confirmedAt: string
  expires?: string
  checkin: Record<string, { status: CheckinStatus; reward?: string; note?: string }>
  benefit: Benefit
}
export interface Site {
  id: string
  name: string
  url: string
  checkinUrl?: string
  issue?: string
  siteDown?: boolean
}
export interface Evaluation {
  id: string
  channelId: string
  model: string
  client: string
  title: string
  state: 'prepared' | 'started' | 'ended'
  startedAt?: string
  endedAt?: string
  summary: string
  rating: '' | '优' | '良' | '差'
}
export interface Integration { name: string; url?: string; kind: 'service' | 'browser'; state: 'ok' | 'failed' | 'pending'; last: string; error?: string; received?: string; queued?: number }
export interface Rules { days: number; samples: number; good: number; warn: number }
export interface AppState {
  sites: Site[]
  accounts: Account[]
  channels: Channel[]
  evals: Evaluation[]
  integrations: Integration[]
  rules: Rules
  tmUrl: string
}

export const TODAY = '2026-10-15'
export const DATES = ['2026-10-15', '2026-10-14', '2026-10-13', '2026-10-12']

const b = (o: Partial<Benefit> = {}): Benefit => ({
  pool: 'daily', validity: '待确认', tz: 'Asia/Shanghai', threshold: '余额 < $5 可签', drops: '', window: '', ...o,
})
const hist = (t: CheckinStatus, reward?: string) => ({
  [DATES[0]]: { status: t, reward },
  [DATES[1]]: { status: '成功' as CheckinStatus, reward: '$2.00' },
  [DATES[2]]: { status: '已签到' as CheckinStatus, reward: '$2.00' },
  [DATES[3]]: { status: '失败' as CheckinStatus, note: '超时' },
})

export const seed: AppState = {
  sites: [
    { id: 's1', name: 'Daily Gate', url: 'https://daily.example.com' },
    { id: 's13', name: 'AgentRouter', url: 'https://agentrouter.org' },
    { id: 's2', name: 'OpenRouter', url: 'https://openrouter.ai' },
    { id: 's3', name: 'RP 小站', url: 'https://rp.example.com' },
    { id: 's4', name: 'Code 专线', url: 'https://code.example.net' },
    { id: 's5', name: 'Free Pool', url: 'https://freepool.example.org', issue: '余额耗尽' },
    { id: 's6', name: 'Neo Relay', url: 'https://neo.example.com', issue: '缺 key' },
    { id: 's7', name: 'Gamma API', url: 'https://gamma.example.io', issue: 'HTTP 502' },
    { id: 's8', name: 'Lost Hub', url: 'https://lost.example.dev', issue: '网站打不开', siteDown: true },
    { id: 's9', name: 'SiliconFlow', url: 'https://siliconflow.cn', issue: '限流' },
    { id: 's10', name: 'Verify Me', url: 'https://verify.example.com', issue: '账号验证' },
    { id: 's11', name: 'Split Gate', url: 'https://split.example.com', checkinUrl: 'https://checkin.split.example.com/daily' },
    { id: 's12', name: 'Mystery Bonus', url: 'https://bonus.example.net' },
  ],
  accounts: [
    { id: 'a1', siteId: 's1', name: 'main@demo', balance: 18.4, unit: 'USD', quota: 'daily', confirmedAt: '09:12', checkin: hist('成功', '$25.00'), benefit: b({ validity: '站点标注当日有效，清零时刻待确认', threshold: '无门槛' }) },
    { id: 'a13', siteId: 's13', name: 'ar@demo', balance: 200, unit: '额度点', quota: 'daily', confirmedAt: '10:03', checkin: hist('成功'), benefit: b({ drops: '北京时间 10:00、19:00', validity: '待确认', window: '', threshold: '无门槛' }) },
    { id: 'a2', unit: 'USD', siteId: 's2', name: 'work@demo', balance: 42.0, quota: 'long', confirmedAt: '08:40', checkin: hist('无法签到'), benefit: b({ pool: 'long', validity: '长期', threshold: '—' }) },
    { id: 'a3', unit: 'USD', siteId: 's3', name: 'rp@demo', balance: null, quota: 'long', confirmedAt: '—', checkin: hist('已签到', '$1.00'), benefit: b({ pool: 'long', validity: '30 天' }) },
    { id: 'a4', unit: 'USD', siteId: 's4', name: 'dev@demo', balance: 9.8, quota: 'long', confirmedAt: '07:55', expires: '10-18', checkin: hist('未执行'), benefit: b({ pool: 'long', validity: '至 10-18' }) },
    { id: 'a5', unit: 'USD', siteId: 's5', name: 'free@demo', balance: 0, quota: 'daily', confirmedAt: '09:30', checkin: hist('失败'), benefit: b() },
    { id: 'a6', unit: 'USD', siteId: 's6', name: 'neo@demo', balance: 5.0, quota: 'long', confirmedAt: '昨日 22:10', checkin: hist('待确认'), benefit: b({ pool: 'long', validity: '长期' }) },
    { id: 'a7', unit: 'USD', siteId: 's7', name: 'g@demo', balance: 12.0, quota: 'daily', confirmedAt: '09:01', checkin: hist('成功', '$3.00'), benefit: b() },
    { id: 'a8', unit: 'USD', siteId: 's8', name: 'lost@demo', balance: null, quota: 'long', confirmedAt: '—', checkin: hist('未执行'), benefit: b({ pool: 'long', validity: '未知' }) },
    { id: 'a9', unit: 'CNY', siteId: 's9', name: 'sf@demo', balance: 14.0, quota: 'long', confirmedAt: '09:20', expires: '10-16', checkin: hist('已签到', '¥2'), benefit: b({ pool: 'long', validity: '至 10-16', tz: 'Asia/Shanghai' }) },
    { id: 'a10', unit: 'USD', siteId: 's10', name: 'v@demo', balance: null, quota: 'daily', confirmedAt: '—', checkin: hist('需人工操作'), benefit: b() },
    { id: 'a11', unit: 'USD', siteId: 's11', name: 'split@demo', balance: 6.5, quota: 'daily', confirmedAt: '08:05', checkin: hist('需登录'), benefit: b({ threshold: '余额 < $2 可签' }) },
    { id: 'a12', unit: '积分', siteId: 's12', name: 'bonus@demo', balance: null, quota: 'daily', confirmedAt: '—', checkin: hist('成功'), benefit: b({ drops: '每日 00:00' }) },
  ],
  channels: [],
  evals: [
    { id: 'e1', channelId: 'c1', model: 'claude-sonnet-4', client: 'Claude Code', title: '重构登录模块', state: 'ended', startedAt: '10-14 14:02', endedAt: '10-14 14:40', summary: '完成，PR 已提交（不代表渠道质量）', rating: '良' },
  ],
  integrations: [
    { kind: 'service', name: 'New API', url: 'http://192.168.1.10:3000', state: 'ok', last: '09:42' },
    { kind: 'service', name: 'CPA', url: 'http://192.168.1.10:8317', state: 'ok', last: '09:40' },
    { name: 'All API Hub', kind: 'browser', state: 'failed', last: '10-14 23:10', received: '10-14 23:10', queued: 7, error: '浏览器未上报：执行设备离线（最后心跳 10-14 23:10），7 个事件待交' },
    { kind: 'service', name: '酒馆 SillyTavern', url: 'http://192.168.1.10:8000', state: 'pending', last: '09:15' },
  ],
  rules: { days: 7, samples: 30, good: 98, warn: 95 },
  tmUrl: 'http://192.168.1.10:9090',
}

const ch = (o: Partial<Channel> & Pick<Channel, 'id' | 'siteId' | 'accountId' | 'name' | 'category'>): Channel => ({
  baseUrl: 'https://api.example.com/v1', protocol: 'OpenAI', models: [], keyMask: 'sk-demo-••••0000', bindings: [], enabled: true, mode: 'auto', rating: '', note: '', version: 1, apply: 'synced', order: 0, headers: [], samples: 0, success: null, ttft: null, disconnects: 0, lastSeen: '—', priority: 0, reason: '', ...o,
})
seed.channels = [
  ch({ id: 'c1', siteId: 's1', category: 'general', accountId: 'a1', name: 'DG-Claude', baseUrl: 'https://daily.example.com/v1', protocol: 'Anthropic', models: ['claude-sonnet-4', 'claude-haiku-4'], keyMask: 'sk-demo-••••a1b2', bindings: ['Code', 'Hermes Chat'], samples: 128, success: 99.2, ttft: 820, disconnects: 1, lastSeen: '09:40', priority: 400, reason: '当日优：当日额度 + 观测成功率 ≥98%', version: 4 }),
  ch({ id: 'c2', siteId: 's2', category: 'general', accountId: 'a2', name: 'OR-主力', baseUrl: 'https://openrouter.ai/api/v1', models: ['gpt-4.1', 'gemini-2.5-pro', 'deepseek-v3'], keyMask: 'sk-demo-••••c3d4', bindings: ['Code', 'Hermes Chat', 'Hermes Cron'], samples: 342, success: 98.6, ttft: 640, disconnects: 2, lastSeen: '09:38', priority: 200, reason: '长期优：观测成功率 ≥98%', version: 7 }),
  ch({ id: 'c2rp', siteId: 's2', category: 'rp', accountId: 'a2', name: 'OR-RP', baseUrl: 'https://openrouter.ai/api/v1', models: ['claude-opus-4'], keyMask: 'sk-demo-••••orrp', bindings: ['酒馆'], mode: 'manual', rating: '良', note: '同站点的 RP 专用连接', order: 4, version: 1, reason: 'RP 人工固定' }),
  ch({ id: 'c3', siteId: 's3', category: 'rp', accountId: 'a3', name: 'RP-主线', baseUrl: 'https://rp.example.com/v1', models: ['claude-opus-4'], keyMask: 'sk-demo-••••rp01', bindings: ['酒馆'], mode: 'manual', rating: '优', note: '长剧情稳定', order: 1, apply: 'synced', version: 3, reason: 'RP 人工固定' }),
  ch({ id: 'c3b', siteId: 's3', category: 'rp', accountId: 'a3', name: 'RP-备用', baseUrl: 'https://rp.example.com/v1', models: ['claude-sonnet-4'], keyMask: 'sk-demo-••••rp02', bindings: ['酒馆'], mode: 'manual', rating: '良', order: 2, apply: 'pending', version: 2, reason: 'RP 人工固定' }),
  ch({ id: 'c11', siteId: 's11', category: 'rp', accountId: 'a11', name: 'Split-RP', baseUrl: 'https://split.example.com/v1', models: ['gemini-2.5-pro'], keyMask: 'sk-demo-••••sp11', bindings: ['酒馆'], mode: 'manual', order: 3, apply: 'conflict', version: 5, reason: 'RP 人工固定', external: { models: ['gemini-2.5-flash'], baseUrl: 'https://split.example.com/v2', version: 6 } }),
  ch({ id: 'c3g', siteId: 's3', category: 'general', accountId: 'a3', name: 'RP站-通用', baseUrl: 'https://rp.example.com/v1', models: ['gpt-4.1-mini'], keyMask: 'sk-demo-••••rpg1', bindings: ['Hermes Chat'], samples: 12, lastSeen: '08:50', priority: 100, reason: '长期常规：样本不足 · 待评价，保留原路由' }),
  ch({ id: 'c4', siteId: 's4', category: 'client', accountId: 'a4', name: 'Code-专线', baseUrl: 'https://code.example.net/anthropic', protocol: 'Anthropic', models: ['claude-sonnet-4'], keyMask: 'sk-demo-••••cd04', bindings: ['Claude Code'], mode: 'manual', client: 'Claude Code', clientState: 'awaiting', headers: [{ name: 'User-Agent', value: 'claude-cli/1.0' }, { name: 'X-Client', value: 'claude-code' }], reason: '仅限 Claude Code 客户端' }),
  ch({ id: 'c4b', siteId: 's4', category: 'client', accountId: 'a4', name: 'Codex-专线', baseUrl: 'https://code.example.net/openai', protocol: 'OpenAI Responses', models: ['gpt-5-codex'], keyMask: 'sk-demo-••••cx05', bindings: ['Codex'], mode: 'manual', client: 'Codex', clientState: 'verified', headers: [{ name: 'originator', value: 'codex_cli_rs' }], reason: '仅限 Codex' }),
  ch({ id: 'c13', siteId: 's13', category: 'client', accountId: 'a13', name: 'AR-Claude Code', baseUrl: 'https://agentrouter.org', protocol: 'Anthropic', models: ['claude-sonnet-4'], keyMask: 'sk-demo-••••ar13', bindings: ['Claude Code'], mode: 'manual', client: 'Claude Code', clientState: 'draft', headers: [{ name: 'User-Agent', value: 'claude-cli/1.0' }], reason: '站点限制仅 Claude Code 客户端' }),
  ch({ id: 'c5', siteId: 's5', category: 'general', accountId: 'a5', name: 'Free-通用', models: ['gpt-4o-mini'], samples: 80, success: 97.0, ttft: 900, lastSeen: '09:30', priority: 0, reason: '备用：余额耗尽' }),
  ch({ id: 'c6', siteId: 's6', category: 'general', accountId: 'a6', name: 'Neo-通用', models: ['deepseek-r1'], keyMask: '未填写', enabled: false, reason: '缺 key，无法启用' }),
  ch({ id: 'c7', siteId: 's7', category: 'general', accountId: 'a7', name: 'Gamma-通用', models: ['gpt-4.1'], samples: 45, success: 88.0, ttft: 1500, disconnects: 6, lastSeen: '09:35', priority: 0, reason: '备用：最近返回 HTTP 502，观测成功率 <95%', apply: 'failed', applyMsg: 'New API 返回：渠道 #7 更新失败，上游权重字段被锁定' }),
  ch({ id: 'c8', siteId: 's8', category: 'general', accountId: 'a8', name: 'Lost-通用', models: ['gpt-4o'], enabled: false, reason: '网站打不开，暂停' }),
  ch({ id: 'c9', siteId: 's9', category: 'media', accountId: 'a9', name: 'SF-生图', models: ['flux-1.1-pro', 'wan-2.1-video'], samples: 22, success: null, lastSeen: '09:20', priority: 100, reason: '长期常规：限流 · 样本不足，保留原路由', media: { pending: 3, done: 16, failed: 3 } }),
  ch({ id: 'c10', siteId: 's10', category: 'general', accountId: 'a10', name: 'Verify-通用', models: ['qwen3-max'], enabled: false, reason: '账号需验证' }),
  ch({ id: 'c12', siteId: 's12', category: 'media', accountId: 'a12', name: 'Bonus-视频', models: ['kling-2.1'], samples: 4, lastSeen: '08:12', priority: 300, reason: '当日常规：样本不足 · 待评价，保留原路由', media: { pending: 1, done: 2, failed: 1 }, apply: 'diff', applyMsg: '外部 New API 中模型列表与中心不一致' }),
]

export const catLabel: Record<Category, string> = { general: '通用', media: '生图视频', rp: 'RP', client: '客户端绑定' }
