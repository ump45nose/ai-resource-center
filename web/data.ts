export type Category = "general" | "media" | "rp" | "client";
export type CheckinStatus =
  | "成功"
  | "已签到"
  | "失败"
  | "待确认"
  | "需登录"
  | "需人工操作"
  | "未执行"
  | "无法签到";
export type ApplyState =
  "saved" | "synced" | "pending" | "saving" | "failed" | "diff" | "conflict";
export type ClientState = "draft" | "awaiting" | "verified";

export interface Header {
  name: string;
  value: string;
}
export interface Channel {
  id: string;
  authType?: "bearer" | "api_key";
  category: Category;
  gateway?: { sourceId: string; channelId?: number };
  availability?: string;
  listGroup?: "exhausted" | "invalid" | "maintenance" | "removed";
  weight: number;
  hasKey: boolean;
  tavern?: {
    profileId: string;
    device: string;
    current?: boolean;
    lastSavedAt: string;
  };
  siteId: string;
  accountId: string;
  name: string;
  baseUrl: string;
  protocol: string;
  models: string[];
  keyMask: string;
  bindings: string[];
  enabled: boolean;
  mode: "auto" | "manual";
  rating: "" | "优" | "良" | "差";
  note: string;
  version: number;
  apply: ApplyState;
  applyMsg?: string;
  order: number;
  client?: string;
  context1m?: boolean;
  gatewayAllowed?: boolean;
  nativePassthrough?: boolean;
  group?: string;
  headers: Header[];
  clientState?: ClientState;
  samples: number;
  success: number | null;
  ttft: number | null;
  disconnects: number;
  lastSeen: string;
  priority: number;
  reason: string;
  media?: { pending: number; done: number; failed: number };
  external?: Partial<Channel>;
}
export interface Benefit {
  pool: "daily" | "long";
  validity: string;
  tz: string;
  threshold: string;
  drops: string;
  window: string;
  resetAt?: string;
  checkinSupported?: boolean | null;
  ruleText?: string;
  windows?: { start: string; end: string }[];
}
export interface Account {
  version: number;
  unit: string;
  status: string;
  validUntil?: string | null;
  id: string;
  siteId: string;
  name: string;
  balance: number | null;
  quota: "daily" | "long";
  confirmedAt: string;
  expires?: string;
  checkin: Record<
    string,
    { status: CheckinStatus; reward?: string; note?: string }
  >;
  benefit: Benefit;
}
export interface Site {
  aliases?: string[];
  id: string;
  name: string;
  url: string;
  checkinUrl?: string;
  category: Category;
  categories?: Category[];
  issue?: string;
  siteDown?: boolean;
}
export interface Evaluation {
  id: string;
  channelId: string;
  model: string;
  client: string;
  title: string;
  state: "prepared" | "started" | "ended";
  startedAt?: string;
  endedAt?: string;
  summary: string;
  rating: "" | "优" | "良" | "差";
  records?: number;
}
export interface Integration {
  id: string;
  kind: string;
  name: string;
  url: string;
  state: "ok" | "failed" | "pending";
  last: string;
  error?: string;
  coverage?: string;
}
export interface Rules {
  days: number;
  samples: number;
  good: number;
  warn: number;
}
export interface AppState {
  pendingImports?: { id: string; source: string; count: number }[];
  sites: Site[];
  accounts: Account[];
  channels: Channel[];
  evals: Evaluation[];
  integrations: Integration[];
  rules: Rules;
  identities?: {
    id: string;
    channelId: string;
    application: string;
    state?: string;
    verifiedAt?: string;
  }[];
  tmUrl: string;
  today: string;
  demo: boolean;
  received: {
    allApiHub?: string;
    sillyTavern?: string;
    sillyTavernCalls?: string;
  };
}

export const TODAY = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}).format(new Date());
export const DATES = Array.from({ length: 4 }, (_, i) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(Date.now() - i * 86400000)),
);
export const catLabel: Record<Category, string> = {
  general: "通用",
  media: "生图视频",
  rp: "RP",
  client: "客户端绑定（Code）",
};
export const emptyState: AppState = {
  sites: [],
  accounts: [],
  channels: [],
  evals: [],
  integrations: [],
  rules: { days: 7, samples: 30, good: 98, warn: 95 },
  tmUrl: "",
  today: TODAY,
  demo: false,
  received: {},
};
