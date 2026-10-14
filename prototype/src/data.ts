export type Category = 'general' | 'media' | 'rp' | 'client'
export type CheckinStatus = '成功' | '已签到' | '失败' | '待确认' | '需登录' | '需人工操作' | '未执行' | '无法签到'
export type ApplyState = 'synced' | 'pending' | 'saving' | 'failed' | 'diff' | 'conflict'
export type ClientState = 'draft' | 'awaiting' | 'verified'

export interface Header { name: string; value: string }
export interface Channel {
  id: string
  siteId: string
  accountId: string
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
  category: Category
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
export interface Integration { name: string; url: string; state: 'ok' | 'failed' | 'pending'; last: string; error?: string }
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

export const TODAY = '2025-06-12'
export const DATES = ['2025-06-12', '2025-06-11', '2025-06-10', '2025-06-09']

const b = (o: Partial<Benefit> = {}): Benefit => ({
  pool: 'daily', validity: '当日 24:00 清零', tz: 'Asia/Shanghai', threshold: '余额 < $5 可签', drops: '', window: '', ...o,
})
const hist = (t: CheckinStatus, reward?: string) => ({
  [DATES[0]]: { status: t, reward },
  [DATES[1]]: { status: '成功' as CheckinStatus, reward: '$2.00' },
  [DATES[2]]: { status: '已签到' as CheckinStatus, reward: '$2.00' },
  [DATES[3]]: { status: '失败' as CheckinStatus, note: '超时' },
})

export const seed: AppState = {
  sites: [
    { id: 's1', name: 'AgentRouter', url: 'https://agentrouter.org', category: 'general' },
    { id: 's2', name: 'OpenRouter', url: 'https://openrouter.ai', category: 'general' },
    { id: 's3', name: 'RP 小站', url: 'https://rp.example.com', category: 'rp' },
    { id: 's4', name: 'Code 专线', url: 'https://code.example.net', category: 'client' },
    { id: 's5', name: 'Free Pool', url: 'https://freepool.example.org', category: 'general', issue: '余额耗尽' },
    { id: 's6', name: 'Neo Relay', url: 'https://neo.example.com', category: 'general', issue: '缺 key' },
    { id: 's7', name: 'Gamma API', url: 'https://gamma.example.io', category: 'general', issue: 'HTTP 502' },
    { id: 's8', name: 'Lost Hub', url: 'https://lost.example.dev', category: 'general', issue: '网站打不开', siteDown: true },
    { id: 's9', name: 'SiliconFlow', url: 'https://siliconflow.cn', category: 'media', issue: '限流' },
    { id: 's10', name: 'Verify Me', url: 'https://verify.example.com', category: 'general', issue: '账号验证' },
    { id: 's11', name: 'Split Gate', url: 'https://split.example.com', checkinUrl: 'https://checkin.split.example.com/daily', category: 'rp' },
    { id: 's12', name: 'Mystery Bonus', url: 'https://bonus.example.net', category: 'media' },
  ],
  accounts: [
    { id: 'a1', siteId: 's1', name: 'main@demo', balance: 18.4, quota: 'daily', confirmedAt: '09:12', expires: '今日 24:00', checkin: hist('成功', '$25.00'), benefit: b({ drops: '北京时间 10:00、19:00', window: '投放后至当日 24:00（站点公告明确）', threshold: '无门槛' }) },
    { id: 'a2', siteId: 's2', name: 'work@demo', balance: 42.0, quota: 'long', confirmedAt: '08:40', checkin: hist('无法签到'), benefit: b({ pool: 'long', validity: '长期', threshold: '—' }) },
    { id: 'a3', siteId: 's3', name: 'rp@demo', balance: null, quota: 'long', confirmedAt: '—', checkin: hist('已签到', '$1.00'), benefit: b({ pool: 'long', validity: '30 天' }) },
    { id: 'a4', siteId: 's4', name: 'dev@demo', balance: 9.8, quota: 'long', confirmedAt: '07:55', expires: '06-15', checkin: hist('未执行'), benefit: b({ pool: 'long', validity: '至 06-15' }) },
    { id: 'a5', siteId: 's5', name: 'free@demo', balance: 0, quota: 'daily', confirmedAt: '09:30', checkin: hist('失败'), benefit: b() },
    { id: 'a6', siteId: 's6', name: 'neo@demo', balance: 5.0, quota: 'long', confirmedAt: '昨日 22:10', checkin: hist('待确认'), benefit: b({ pool: 'long', validity: '长期' }) },
    { id: 'a7', siteId: 's7', name: 'g@demo', balance: 12.0, quota: 'daily', confirmedAt: '09:01', expires: '今日 24:00', checkin: hist('成功', '$3.00'), benefit: b() },
    { id: 'a8', siteId: 's8', name: 'lost@demo', balance: null, quota: 'long', confirmedAt: '—', checkin: hist('未执行'), benefit: b({ pool: 'long', validity: '未知' }) },
    { id: 'a9', siteId: 's9', name: 'sf@demo', balance: 14.0, quota: 'long', confirmedAt: '09:20', expires: '06-13', checkin: hist('已签到', '¥2'), benefit: b({ pool: 'long', validity: '至 06-13', tz: 'Asia/Shanghai' }) },
    { id: 'a10', siteId: 's10', name: 'v@demo', balance: null, quota: 'daily', confirmedAt: '—', checkin: hist('需人工操作'), benefit: b() },
    { id: 'a11', siteId: 's11', name: 'split@demo', balance: 6.5, quota: 'daily', confirmedAt: '08:05', expires: '今日 24:00', checkin: hist('需登录'), benefit: b({ threshold: '余额 < $2 可签' }) },
    { id: 'a12', siteId: 's12', name: 'bonus@demo', balance: null, quota: 'daily', confirmedAt: '—', checkin: hist('成功'), benefit: b({ drops: '每日 00:00' }) },
  ],
  channels: [],
  evals: [
    { id: 'e1', channelId: 'c1', model: 'claude-sonnet-4', client: 'Claude Code', title: '重构登录模块', state: 'ended', startedAt: '06-11 14:02', endedAt: '06-11 14:40', summary: '完成，PR 已提交（不代表渠道质量）', rating: '良' },
  ],
  integrations: [
    { name: 'New API', url: 'http://192.168.1.10:3000', state: 'ok', last: '09:42' },
    { name: 'CPA', url: 'http://192.168.1.10:8317', state: 'ok', last: '09:40' },
    { name: 'All API Hub', url: 'http://192.168.1.10:5173', state: 'failed', last: '昨日 23:10', error: '连接被拒绝：端口 5173 未监听，请确认服务已启动' },
    { name: '酒馆 SillyTavern', url: 'http://192.168.1.10:8000', state: 'pending', last: '09:15' },
  ],
  rules: { days: 7, samples: 30, good: 98, warn: 95 },
  tmUrl: 'http://192.168.1.10:9090',
}

const ch = (o: Partial<Channel> & Pick<Channel, 'id' | 'siteId' | 'accountId' | 'name'>): Channel => ({
  baseUrl: 'https://api.example.com/v1', protocol: 'OpenAI', models: [], keyMask: 'sk-demo-••••0000', bindings: [], enabled: true, mode: 'auto', rating: '', note: '', version: 1, apply: 'synced', order: 0, headers: [], samples: 0, success: null, ttft: null, disconnects: 0, lastSeen: '—', priority: 0, reason: '', ...o,
})
seed.channels = [
  ch({ id: 'c1', siteId: 's1', accountId: 'a1', name: 'AR-Claude', baseUrl: 'https://agentrouter.org/v1', protocol: 'Anthropic', models: ['claude-sonnet-4', 'claude-haiku-4'], keyMask: 'sk-demo-••••a1b2', bindings: ['Code', 'Hermes Chat'], samples: 128, success: 99.2, ttft: 820, disconnects: 1, lastSeen: '09:40', priority: 100, reason: '当日额度 + 观测成功率 ≥98%', version: 4 }),
  ch({ id: 'c2', siteId: 's2', accountId: 'a2', name: 'OR-主力', baseUrl: 'https://openrouter.ai/api/v1', models: ['gpt-4.1', 'gemini-2.5-pro', 'deepseek-v3'], keyMask: 'sk-demo-••••c3d4', bindings: ['Code', 'Hermes Chat', 'Hermes Cron'], samples: 342, success: 98.6, ttft: 640, disconnects: 2, lastSeen: '09:38', priority: 90, reason: '长期优质', version: 7 }),
  ch({ id: 'c3', siteId: 's3', accountId: 'a3', name: 'RP-主线', baseUrl: 'https://rp.example.com/v1', models: ['claude-opus-4'], keyMask: 'sk-demo-••••rp01', bindings: ['酒馆'], mode: 'manual', rating: '优', note: '长剧情稳定', order: 1, apply: 'synced', version: 3, reason: 'RP 人工固定' }),
  ch({ id: 'c3b', siteId: 's3', accountId: 'a3', name: 'RP-备用', baseUrl: 'https://rp.example.com/v1', models: ['claude-sonnet-4'], keyMask: 'sk-demo-••••rp02', bindings: ['酒馆'], mode: 'manual', rating: '良', order: 2, apply: 'pending', version: 2, reason: 'RP 人工固定' }),
  ch({ id: 'c11', siteId: 's11', accountId: 'a11', name: 'Split-RP', baseUrl: 'https://split.example.com/v1', models: ['gemini-2.5-pro'], keyMask: 'sk-demo-••••sp11', bindings: ['酒馆'], mode: 'manual', order: 3, apply: 'conflict', version: 5, reason: 'RP 人工固定', external: { models: ['gemini-2.5-flash'], baseUrl: 'https://split.example.com/v2', version: 6 } }),
  ch({ id: 'c4', siteId: 's4', accountId: 'a4', name: 'Code-专线', baseUrl: 'https://code.example.net/anthropic', protocol: 'Anthropic', models: ['claude-sonnet-4'], keyMask: 'sk-demo-••••cd04', bindings: ['Claude Code'], mode: 'manual', client: 'Claude Code', clientState: 'awaiting', headers: [{ name: 'User-Agent', value: 'claude-cli/1.0' }, { name: 'X-Client', value: 'claude-code' }], reason: '仅限 Claude Code 客户端' }),
  ch({ id: 'c4b', siteId: 's4', accountId: 'a4', name: 'Codex-专线', baseUrl: 'https://code.example.net/openai', protocol: 'OpenAI Responses', models: ['gpt-5-codex'], keyMask: 'sk-demo-••••cx05', bindings: ['Codex'], mode: 'manual', client: 'Codex', clientState: 'verified', headers: [{ name: 'originator', value: 'codex_cli_rs' }], reason: '仅限 Codex' }),
  ch({ id: 'c5', siteId: 's5', accountId: 'a5', name: 'Free-通用', models: ['gpt-4o-mini'], samples: 80, success: 97.0, ttft: 900, lastSeen: '09:30', priority: 0, reason: '余额耗尽，已降为 0' }),
  ch({ id: 'c6', siteId: 's6', accountId: 'a6', name: 'Neo-通用', models: ['deepseek-r1'], keyMask: '未填写', enabled: false, reason: '缺 key，无法启用' }),
  ch({ id: 'c7', siteId: 's7', accountId: 'a7', name: 'Gamma-通用', models: ['gpt-4.1'], samples: 45, success: 88.0, ttft: 1500, disconnects: 6, lastSeen: '09:35', priority: 10, reason: '最近返回 HTTP 502，观测成功率 <95%', apply: 'failed', applyMsg: 'New API 返回：渠道 #7 更新失败，上游权重字段被锁定' }),
  ch({ id: 'c8', siteId: 's8', accountId: 'a8', name: 'Lost-通用', models: ['gpt-4o'], enabled: false, reason: '网站打不开，暂停' }),
  ch({ id: 'c9', siteId: 's9', accountId: 'a9', name: 'SF-生图', models: ['flux-1.1-pro', 'wan-2.1-video'], samples: 22, success: null, lastSeen: '09:20', priority: 50, reason: '限流 · 样本不足，保留原路由', media: { pending: 3, done: 16, failed: 3 } }),
  ch({ id: 'c10', siteId: 's10', accountId: 'a10', name: 'Verify-通用', models: ['qwen3-max'], enabled: false, reason: '账号需验证' }),
  ch({ id: 'c12', siteId: 's12', accountId: 'a12', name: 'Bonus-视频', models: ['kling-2.1'], samples: 4, lastSeen: '08:12', priority: 40, reason: '样本不足 · 待评价', media: { pending: 1, done: 2, failed: 1 }, apply: 'diff', applyMsg: '外部 New API 中模型列表与中心不一致' }),
]

export const catLabel: Record<Category, string> = { general: '通用', media: '生图视频', rp: 'RP', client: '客户端绑定' }

