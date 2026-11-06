import { nextReset, windowOpen, clock } from "./domain.mjs";
import {
  probeBlock,
  archiveOf,
  usageOf,
  capabilitiesOf,
} from "./channel-rules.mjs";

export const defaults = {
  enabled: false,
  normalHours: 24,
  maintenanceHours: 6,
  closedHours: 24,
  keyRetryHours: 168,
  newModelsHours: 168,
  archiveAfterDays: 14,
  archiveReviewHours: 168,
  maxCandidates: 3,
  scanConcurrency: 5,
  unstableSuccesses: 3,
  smokeEnabled: false,
  smokeMaxTokens: 2048,
  maxEvaluationsPerDay: 30,
  modelRules: [
    {
      match: "gpt-5,gpt-6,claude-opus,claude-sonnet,claude-fable,kimi",
      capabilityClass: "strong",
    },
    { match: "deepseek,glm-5,minimax-m3", capabilityClass: "execution" },
  ],
  excludedModels:
    "mini,nano,haiku,embedding,rerank,image,video,audio,tts,whisper",
  autoApply: false,
  days: 7,
  samples: 30,
  good: 98,
  warn: 95,
};

export function policies(store) {
  // Retired keys may linger in older settings; the strict PATCH schema rejects them.
  const { syncMinutes, callsMinutes, ...stored } =
    store.setting("maintenancePolicy") || {};
  return { ...defaults, ...stored };
}

export function currentBalance(account, now = new Date()) {
  if (account?.benefit?.balanceMode === "fixed_daily") return true;
  const at = Date.parse(account?.confirmedAt);
  return (
    account?.balance != null &&
    Number.isFinite(at) &&
    now.getTime() - at < 24 * 60 * 60 * 1000
  );
}

export function entitlement(account, now = new Date()) {
  const benefit = account?.benefit || {},
    reasons = [];
  const timezone = benefit.tz || "Asia/Shanghai";
  const fixedDaily = benefit.balanceMode === "fixed_daily";
  const balance = fixedDaily ? benefit.dailyLimit : account?.balance;
  const balanceCurrent = currentBalance(account, now);
  const expiresAt = fixedDaily
    ? nextReset(now.toISOString(), timezone, benefit.resetAt || "00:00")
    : account?.validUntil || null;
  const dailyExpired = !!expiresAt && new Date(expiresAt) <= now;
  const hasPools =
    account?.dailyBalance != null || account?.longBalance != null;
  const dailyBalance = fixedDaily ? balance : hasPools
    ? account.dailyBalance
    : account?.quota === "daily"
      ? account.balance
      : null;
  const longBalance = fixedDaily ? null : hasPools
    ? account.longBalance
    : account?.quota !== "daily"
      ? account?.balance
      : null;
  const dailyAvailable = balanceCurrent && !dailyExpired && dailyBalance > 0;
  const longAvailable = balanceCurrent && longBalance > 0;
  if (
    balanceCurrent &&
    !dailyAvailable &&
    !longAvailable &&
    (hasPools || balance <= 0)
  )
    reasons.push("余额耗尽");
  if (dailyExpired && !longAvailable && account?.quota === "daily")
    reasons.push("额度已到期");
  if (!windowOpen(benefit.windows, timezone, now)) reasons.push("窗口关闭");
  return {
    available: !reasons.length,
    availability: !balanceCurrent ? "unknown" : reasons.length ? "unavailable" : "available",
    reasons,
    timezone,
    balance: balance ?? null,
    balanceBasis: fixedDaily ? "fixed_daily" : "observed",
    balanceCurrent,
    balanceObservedAt: fixedDaily ? null : account?.confirmedAt || null,
    unit: account?.unit || "待确认",
    expiresAt,
    daily:
      account?.enabled !== false &&
      !account?.mergedInto &&
      dailyAvailable &&
      !!expiresAt,
    dailyBalance: dailyExpired ? 0 : dailyBalance ?? null,
    longBalance: longBalance ?? null,
    dailyLimit: benefit.dailyLimit ?? null,
    renewal: benefit.renewal || null,
    releaseTimes: benefit.releaseTimes || benefit.drops || null,
    windows: benefit.windows || [],
  };
}

export function reviewManaged(store, c) {
  return (
    !probeBlock(store, c) &&
    usageOf(c) !== "rp" &&
    !store.get("site", c.siteId)?.removed &&
    !store.get("site", c.siteId)?.mergedInto &&
    store.get("account", c.accountId)?.enabled !== false &&
    c.recoveryPolicy?.enabled !== false &&
    !c.management?.fixed &&
    !c.management?.manualOnly
  );
}
export function autoScope(store, c) {
  return (
    reviewManaged(store, c) &&
    usageOf(c) === "general" &&
    capabilitiesOf(c).includes("text")
  );
}
export function autoManaged(store, c) {
  return policies(store).enabled && c.mode === "auto" && autoScope(store, c);
}

const terms = (text) =>
  text
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
export function modelPreference(modelId, policy) {
  const name = modelId.toLowerCase();
  if (
    terms(policy.excludedModels).some((value) =>
      ["mini", "nano"].includes(value)
        ? new RegExp(`(^|[-_/ .])${value}($|[-_/ .])`).test(name)
        : name.includes(value),
    )
  )
    return null;
  const index = policy.modelRules.findIndex((rule) =>
    terms(rule.match).some((s) => name.includes(s)),
  );
  return index < 0
    ? null
    : { proposedClass: policy.modelRules[index].capabilityClass, rank: index };
}

export const verified = (o, c) =>
  o?.verification?.result === "success" &&
  o.verification.quality === "passed" &&
  (o.verification.connectionVersion || 1) === (c.connectionVersion || 1) &&
  (!archiveOf(c).includes("unstable") ||
    (o.verification.stableSamples || 0) >=
      (o.verification.requiredStableSamples || 3));

export function maintenanceStatus(
  store,
  c,
  { blocked = probeBlock(store, c), now = Date.now() } = {},
) {
  const p = policies(store),
    site = store.get("site", c.siteId),
    account = store.get("account", c.accountId);
  const issues = archiveOf(c, site);
  const reason =
    Object.values(c.healthWindows || {}).find((w) => w.count > 0 &&
      w.connectionVersion === (c.connectionVersion || 1))?.detail ||
    (!issues.length ? c.runtimeIssue?.reason : null) ||
    c.availability ||
    c.callIssue?.reason ||
    (typeof c.callIssue === "string" ? c.callIssue : "") ||
    (c.management?.state === "maintenance"
      ? "维护中"
      : c.management?.state === "closed"
        ? "网站关闭"
        : "");
  const pending =
    !!reason ||
    issues.length > 0 ||
    (c.catalogObservation && c.catalogObservation.status !== "ok");
  const keyError = ["invalid", "authentication_failed", "missing_key"].includes(
    c.credentialState,
  );
  const hours =
    issues.includes("website") || c.management?.state === "closed"
      ? p.closedHours
      : keyError
        ? p.keyRetryHours
        : pending || !c.enabled
          ? p.maintenanceHours
          : p.normalHours;
  const lastCheckAt =
    c.catalogObservation &&
    (c.catalogObservation.connectionVersion || 1) !== (c.connectionVersion || 1)
      ? null
      : c.maintenance?.lastScanAttemptAt || c.lastScanAt || null;
  let waitingFor =
    blocked || (c.recoveryPolicy?.enabled === false ? "已关闭自动复查" : null);
  const rights = entitlement(account, new Date(now));
  const accountConditionChanged =
    Date.parse(c.credentialChangedAt || 0) >
    Date.parse(c.archivedAt || c.curation?.at || 0);
  const accountBlocked =
    !accountConditionChanged &&
    issues.includes("invalid") &&
    /封禁|已封|未注册|未登录/.test(
      [reason, c.archiveNote, account?.status].filter(Boolean).join(" "),
    );
  const balanceWaiting =
    issues.includes("balance") &&
    !(
      rights.available &&
      (rights.dailyBalance > 0 || rights.longBalance > 0) &&
      Date.parse(account.confirmedAt || 0) >
        Date.parse(c.callObservedAt || c.observedAt || c.lastSeen || 0)
    );
  if (!waitingFor && accountBlocked) waitingFor = "等待账号条件变化";
  if (!waitingFor && balanceWaiting) waitingFor = "等待确认额度补充";
  const checkHours = c.autoArchive
    ? Math.max(hours, p.archiveReviewHours)
    : issues.includes("invalid") ? p.keyRetryHours : hours;
  let due = Math.max(
    now,
    Date.parse(lastCheckAt || "1970-01-01") + checkHours * 3600000,
  );
  if (!issues.length && c.maintenance?.failureChecks?.count === 1)
    due = Math.max(now, Date.parse(c.maintenance.failureChecks.at) + 5 * 60000);
  // Limits change scheduling, not long-term channel quality. Never hammer closed windows.
  const limited =
    c.catalogObservation?.status === "rate_limited" ||
    /限流|429|rate.limit/i.test(
      [reason, c.callIssue?.reason].filter(Boolean).join(" "),
    );
  const times = account?.benefit?.releaseTimes || [];
  const windowClosed = rights.reasons.includes("窗口关闭");
  const earliest =
    limited && c.retryAt ? Math.max(now, Date.parse(c.retryAt) || now) : now;
  if ((limited && times.length) || windowClosed) {
    const starts = windowClosed
      ? (account?.benefit?.windows || []).map((w) => w.start)
      : times;
    const fmt = clock(rights.timezone);
    for (
      let at = Math.floor(earliest / 60000) * 60000 + 60000;
      at < now + 49 * 3600000;
      at += 60000
    ) {
      if (starts.includes(fmt.format(new Date(at)))) {
        due = at;
        break;
      }
    }
  } else if (limited && c.retryAt) due = earliest;
  const nextCheckAt =
    !waitingFor && p.enabled ? new Date(due).toISOString() : null;
  if (!waitingFor && !c.credentialId)
    waitingFor = "等待补 key；仍按周期检查网站";
  if (!waitingFor && !rights.available) waitingFor = rights.reasons.join("、");
  if (!waitingFor && keyError) waitingFor = "key 检查未通过，按周期复查";
  return {
    pending,
    archiveReasons: issues,
    checkHours,
    metadataAllowed:
      !blocked &&
      c.recoveryPolicy?.enabled !== false &&
      !accountBlocked &&
      !balanceWaiting,
    validationWaitingFor: ["image", "video"].includes(usageOf(c))
      ? "等待 image-caption 生成验证适配"
      : usageOf(c) === "rp"
        ? "等待酒馆插件任务适配"
        : null,
    reason,
    observedAt: c.callObservedAt || c.callIssue?.at || c.observedAt || null,
    lastCheckAt,
    nextCheckAt,
    waitingFor,
    state: blocked
      ? "excluded"
      : !p.enabled
        ? "disabled"
        : waitingFor
          ? "waiting"
          : "scheduled",
  };
}
