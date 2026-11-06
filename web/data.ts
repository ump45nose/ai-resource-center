export type Page = "sites" | "models" | "sources" | "scans" | "benefits";
export type Tone = "neutral" | "green" | "clay" | "amber" | "red" | "blue";
export const tagLabels = {
  client_restricted: "客户端限定",
  no_probe: "禁止测活",
  no_code: "禁止代码",
  no_nsfw: "禁止 NSFW",
  code_only: "仅能用于代码",
} as const;
export type ChannelTag = keyof typeof tagLabels;
export const usageLabels = {
  general: "通用",
  image: "生图",
  video: "视频",
} as const;
export type ChannelUsage = keyof typeof usageLabels;
export const archiveLabels = {
  website: "网站打不开",
  balance: "无余额无签到",
  invalid: "网站或 key 失效",
  unstable: "调用不稳定",
  call: "调用失败",
  maintenance: "暂停维护",
} as const;
export type ArchiveReason = keyof typeof archiveLabels;
export type Recovery = {
  pending: boolean;
  reason: string;
  observedAt: string | null;
  lastCheckAt: string | null;
  nextCheckAt: string | null;
  state: string;
  waitingFor: string | null;
};
export type Checkin = {
  eventId: string;
  result: string;
  occurredAt: string;
  businessDate: string;
  source?: string;
  method?: string;
  reason?: string;
  reward?: string;
};
export type CheckinToday = {
  state:
    | "done"
    | "not_needed"
    | "action_required"
    | "failed"
    | "pending"
    | "not_applicable";
  label: string;
  tone: Tone;
  detail: string;
  basis: "event" | "site_status" | "manual_mark" | "settings" | "none";
  reason: string | null;
  method: string | null;
  confirmedAt: string | null;
  businessDate: string;
  timezone: string;
};
export type Account = {
  id: string;
  version: number;
  checkinEnabled?: boolean | null;
  enabled?: boolean | null;
  name: string;
  balance: number | null;
  dailyBalance?: number | null;
  longBalance?: number | null;
  unit?: string;
  quota?: string;
  confirmedAt?: string;
  benefit?: {
    tz?: string;
    resetAt?: string;
    dailyLimit?: number;
    balanceMode?: "observed" | "fixed_daily";
    renewal?: "automatic" | "checkin";
    releaseTimes?: string[];
    windows?: { start: string; end: string }[];
    ruleText?: string;
    validity?: string;
    threshold?: string | number;
    drops?: string;
    window?: string;
  };
  validUntil?: string;
  checkins: Checkin[];
  checkinToday: CheckinToday;
  checkinAccountId?: string;
  checkinAccount?: Account;
  hubKeys?: {
    id: string;
    name: string;
    secretState: string;
    credentialStatus: string;
    present?: boolean;
    baseUrl: string;
    models: string[];
  }[];
  keySync?: {
    observedAt: string;
    complete: boolean;
    count: number;
    error: string | null;
  };
  sourceObservation?: {
    source?: string;
    siteType?: string;
    checkinUrl?: string | null;
    enabled: boolean;
    present: boolean;
    observedAt: string;
    checkin?: {
      enabled: boolean;
      configured?: boolean;
      availability?: "enabled" | "disabled";
      ineligibleReason?: "balance_threshold";
      statusObservedAt?: string;
      supported?: boolean;
      supportStatus?: "supported" | "unsupported" | "unknown";
      lastCheckInDate?: string;
      isCheckedInToday?: boolean;
    };
  };
  entitlement: {
    daily: boolean;
    available: boolean;
    reasons: string[];
    balanceCurrent?: boolean;
    balanceBasis?: "observed" | "fixed_daily";
    dailyBalance?: number | null;
    longBalance?: number | null;
  };
};
export type HistoricalEvaluation = {
  id: string;
  modelId: string;
  client?: string;
  state?: string;
  endedAt?: string;
  rating?: string;
  piAudit?: { complete?: boolean; rounds?: number };
  countsTowardCurrentGrade: false;
};
export type Channel = {
  id: string;
  version: number;
  name: string;
  accountId: string;
  usage: ChannelUsage;
  archiveReasons: ArchiveReason[];
  gatewayBlockedReason: string | null;
  baseUrl: string;
  protocol: string;
  models: string[];
  activeModels: string[];
  knownModels: string[];
  tags: ChannelTag[];
  capabilities: string[];
  applications: string[];
  enabled: boolean;
  runtimeEnabled?: boolean | null;
  note?: string;
  client?: string;
  clientRequirements?: { client?: string; note?: string };
  availability?: string;
  archiveNote?: string;
  order?: number;
  recoveryPolicy?: { enabled: boolean };
  credentialStatus: string;
  synchronization?: { target: string; state: string }[];
  runtimeIssue?: { type: "rate" | "quota"; at: string; reason: string } | null;
  mode?: "auto" | "manual";
  management?: { state?: string; prohibited?: boolean; fixed?: boolean };
  probeAllowed: boolean;
  probeBlockedReason: string | null;
  recovery: Recovery;
  sourceObservation?: {
    observedAt: string;
    present: boolean;
    enabled: boolean;
    models: string[];
    nativeType?: number;
    priority?: number;
    group?: string;
    weight?: number;
    headerNames?: string[];
  };
  scan?: {
    scannedAt: string;
    catalogStatus: string;
    catalogModels: string[];
    websiteStatus: string | null;
    metricCount: number;
  } | null;
  modelAvailability: {
    modelId: string;
    capabilityClass?: string;
    id?: string;
    proposedClass?: string;
    candidate?: string;
    stationMetrics?: {
      successRate?: number;
      samples?: number;
      ttftMs?: number;
    };
    health?: {
      blocked: boolean;
      reason?: string;
      taskFailures?: number;
      callFailures?: number;
    };
    apply?: { state: string; at?: string };
    grade?: {
      samples: number;
      successRate: number | null;
      tier: string;
      priority: number;
      weight?: number;
      reason?: string;
      coverage?: string;
      entitlement?: { daily: boolean; reasons: string[] };
    };
    verification?: {
      result: string;
      at?: string;
      quality?: string;
      reason?: string;
      method?: string;
      latencyMs?: number;
    };
    catalog?: { present: boolean };
  }[];
  maintenance?: {
    lastRestoredAt?: string;
    restoredModelId?: string;
    previousIssue?: string;
  };
  hubObservation?: {
    source: string;
    models: string[];
    present: boolean;
    secretState: string;
    observedAt: string;
  };
  historicalEvaluations: HistoricalEvaluation[];
  calls: {
    total: number;
    success: number;
    failure: number;
    lastAt: string | null;
  };
};
export type Site = {
  id: string;
  version: number;
  name: string;
  websiteUrl: string;
  checkinUrl?: string;
  aliases?: string[];
  sources: string[];
  note?: string;
  accounts: Account[];
  channels: Channel[];
  websiteObservation?: {
    status: string;
    observedAt: string | null;
    httpStatus?: number;
  };
};
export type Source = {
  id: string;
  version: number;
  name: string;
  kind: "newapi" | "all-api-hub" | "cron";
  url: string | null;
  enabled?: boolean;
  syncEnabled?: boolean;
  inventoryMinutes?: number;
  callsMinutes?: number;
  userId?: number;
  platformVersion?: string;
  credentialStatus: string;
  receivedAt?: string | null;
  hubSync?: {
    lastInventoryAt?: string;
    lastCredentialsAt?: string;
    accounts: number;
    profiles: number;
    balances: number;
    credentials: number;
    missingCredentials: number;
    keyReadErrors: number;
    keyReadPending: number;
  };
  checkedAt?: string;
  authorizationError?: string;
  lastInventoryAt?: string;
  lastCallsAt?: string;
  last?: string;
  lastAttempt?: string;
  error?: string | null;
  inventoryError?: string;
  callsError?: string;
  coverage?: string;
  lastChanges?: {
    channels: {
      id?: string;
      name?: string;
      result: string;
      reason?: string;
      fields?: string[];
    }[];
    calls: number;
    added?: number;
    unmatched: number;
  };
};
export type Operation = {
  id: string;
  kind: string;
  state: string;
  stage: string;
  reason?: string;
  createdAt: string;
  finishedAt?: string;
  input: {
    sourceId?: string;
    channelId?: string;
    modelId?: string;
    channelIds?: string[];
  };
  result?: {
    passed?: boolean;
    reason?: string;
    previewId?: string;
    total?: number;
    items?: {
      externalId: string;
      name: string;
      baseUrl: string | null;
      result: string;
      models: string[];
    }[];
    channels?: { result: string }[];
    calls?: number;
  };
};
export type Model = {
  id: string;
  tier: string;
  channels: { site: Site; channel: Channel; verified: boolean }[];
};
export type Meta = {
  migration?: {
    channels: number;
    failed: number;
    removed: number;
    tagged: number;
    at: string;
  };
  legacyImport?: { at: string };
  gatewayWrites: boolean;
  automationEnabled: boolean;
  sourceSyncEnabled?: boolean;
};
export type MaintenancePolicy = {
  enabled: boolean;
  autoApply: boolean;
  smokeEnabled: boolean;
  smokeMaxTokens: number;
  normalHours: number;
  maintenanceHours: number;
  closedHours: number;
  keyRetryHours: number;
  newModelsHours: number;
  archiveAfterDays: number;
  archiveReviewHours: number;
  maxCandidates: number;
  maxEvaluationsPerDay: number;
  modelRules: { match: string; capabilityClass: "strong" | "execution" }[];
  excludedModels: string;
};
export type MaintenanceState = {
  channelId: string;
  waitingFor: string | null;
  validationBlocked: string | null;
  nextCheckAt: string | null;
  automaticReason?: string | null;
};
export type MaintenanceSummary = {
  policy: MaintenancePolicy;
  budget: { used: number; limit: number };
  gatewayWrites: boolean;
  tasks: { total: number; ready: number };
  channels: MaintenanceState[];
  coverage?: Record<
    string,
    {
      channelId: string;
      state: string;
      nextCheckAt: string | null;
      waitingFor: string | null;
    }[]
  >;
  pilot?: {
    state: string;
    channelId: string;
    modelId: string;
    appliedAt?: string;
  };
  bindings?: {
    id: string;
    version: number;
    taskName: string;
    channelId: string;
    modelId: string;
    enabled: boolean;
    validationOnly?: boolean;
  }[];
  runs?: {
    id: string;
    channelId: string;
    modelId: string;
    executionMode?: string;
    createdAt: string;
    completedAt?: string;
    verification?: {
      result: string;
      quality: string;
      reason?: string;
      artifactRef?: string;
    };
  }[];
  operations: Operation[];
};
export const pageLabels: Record<Page, string> = {
  sites: "站点",
  models: "模型",
  sources: "接入与同步",
  scans: "扫描与测试",
  benefits: "签到与权益",
};
export const lines = (s: string) =>
  s
    .split(/\n|,/)
    .map((x) => x.trim())
    .filter(Boolean);
export const sourceLabel = (kind: string) =>
  ({
    newapi: "New API",
    "all-api-hub": "All API Hub",
    cron: "fn Cron",
  })[kind] || kind;
export const dateTime = (value?: string | null) => {
  if (!value || !Number.isFinite(Date.parse(value))) return "尚未记录";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
};
export const amount = (value: number | null | undefined, unit = "待确认") =>
  value == null
    ? "未取得"
    : `${unit === "USD" ? "$" : ""}${new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 }).format(value)}${unit === "USD" ? "" : ` ${unit}`}`;
export const balances = (accounts: Account[], dailyOnly = false) => {
  const sums = new Map<string, number>();
  for (const a of accounts) {
    if (a.enabled === false || (dailyOnly && !a.entitlement.daily)) continue;
    const pools = a.dailyBalance != null || a.longBalance != null;
    const value = pools
      ? dailyOnly
        ? a.entitlement.dailyBalance
        : (a.entitlement.dailyBalance || 0) + (a.longBalance || 0)
      : a.balance;
    if (value == null) continue;
    const unit =
      pools && !dailyOnly
        ? (a.unit || "待确认").replace("（当日）", "")
        : a.unit || "待确认";
    sums.set(unit, (sums.get(unit) || 0) + value);
  }
  return [...sums].map(([unit, value]) => amount(value, unit));
};
export const syncStateLabels: Record<string, string> = {
  pending: "待同步",
  running: "同步中",
  applied: "已同步",
  failed: "同步失败",
  conflict: "配置冲突",
  waiting: "等待条件",
  not_applicable: "无需接入",
};
export function channelStatus(c: Channel): { label: string; tone: Tone } {
  if (c.recovery.pending) return { label: c.recovery.reason, tone: "amber" };
  if (c.management?.state === "paused")
    return { label: "人工暂停", tone: "neutral" };
  if (c.credentialStatus === "missing")
    return { label: "待补 key", tone: "amber" };
  const sync = c.synchronization?.find((s) => s.target === "newapi");
  if (
    sync &&
    !["applied", "not_applicable"].includes(sync.state) &&
    syncStateLabels[sync.state]
  )
    return { label: `New API ${syncStateLabels[sync.state]}`, tone: "amber" };
  if (c.runtimeEnabled === true)
    return c.enabled
      ? { label: "New API 已启用", tone: "green" }
      : { label: "中心停用 · 网关启用", tone: "amber" };
  if (c.sourceObservation?.present === false)
    return { label: "网关中不存在", tone: "neutral" };
  if (c.runtimeEnabled === false)
    return { label: "New API 已停用", tone: "neutral" };
  if (c.enabled) return { label: "New API 待接管", tone: "neutral" };
  return { label: "未启用", tone: "neutral" };
}

export const isHubAccount = (account: Account) =>
  account.sourceObservation?.source === "all-api-hub" &&
  account.sourceObservation.present !== false &&
  account.sourceObservation.siteType !== "credential-profile";

export function siteCheckinAccounts(site: Site) {
  const used = site.accounts.filter((a) =>
    site.channels.some((c) => c.accountId === a.id),
  );
  const bound = used.map((a) => a.checkinAccount || a).filter(isHubAccount);
  const accounts = bound.length ? bound : site.accounts.filter(isHubAccount);
  return [...new Map(accounts.map((a) => [a.id, a])).values()];
}

export function hubCheckinUrl(
  site: Pick<Site, "websiteUrl" | "checkinUrl">,
  account: Account,
) {
  const configured = account.sourceObservation?.checkinUrl || site.checkinUrl;
  if (configured) return configured;
  // All API Hub's declared page routes; no network discovery is performed here.
  const paths: Record<string, string> = {
    "new-api": "/console/personal",
    anyrouter: "/console/topup",
    "wong-gongyi": "/console/topup",
    windhub: "/console/personal",
    wisart: "/#/checkin",
    pipi: "/",
    "xiaobai-browser": "/custom/checkin_bonus_user",
    "fengwind-welfare": "/",
    luckyg: "/lottery",
    ddcat: "/",
  };
  const path = paths[account.sourceObservation?.siteType || ""];
  return path ? new URL(path, site.websiteUrl).href : null;
}

export const searchSites = <T extends Site>(sites: T[], query: string) =>
  sites.filter((s) =>
    [
      s.name,
      s.websiteUrl,
      ...(s.aliases || []),
      ...s.channels.flatMap((c) => [
        c.name,
        c.baseUrl,
        ...c.knownModels,
        ...c.tags.map((t) => tagLabels[t]),
      ]),
    ]
      .join(" ")
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );

export const websiteLabel = (value: string) =>
  ({
    reachable: "可访问",
    unreachable: "网站打不开",
    http_error: "网站 HTTP 异常",
  })[value] || value;

export const catalogLabel = (value: string) =>
  ({
    ok: "目录可读",
    network_error: "目录连接失败",
    login_required: "认证待核对",
    missing_key: "缺少 key",
    no_key: "缺少 key",
    unsupported: "暂不支持目录读取",
    unsupported_format: "目录格式不支持",
    unsupported_protocol: "协议暂不支持",
    timeout: "目录请求超时",
    access_denied: "目录访问受限",
    rate_limited: "目录请求限流",
    http_error: "目录 HTTP 异常",
    api_error: "目录接口报错",
    invalid_response: "目录响应无法解析",
    html_response: "目录返回网页",
    key_unavailable: "原始 key 未取得",
  })[value] || value;
