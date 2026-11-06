import { archiveLabels, archiveOf, tagsOf } from "./channel-rules.mjs";
import {
  policies,
  reviewManaged,
  maintenanceStatus,
} from "./maintenance-policy.mjs";
import { observeFailure, observeSuccess, matureFailure } from "./failure-window.mjs";

const nonQualityErrors = ["rate", "quota", "account", "input", "cancelled"];
// Live calls synced from New API; migrated samples and evaluation traffic do not count.
export const liveCalls =
  "legacy_import=0 AND (origin IS NULL OR origin='live')";

export function managedHealth(store, c) {
  return policies(store).enabled && reviewManaged(store, c);
}
// Real calls are judged over the last day, restarted when the connection or key changes.
export const callWindowStart = (c, now = Date.now()) =>
  new Date(
    Math.max(
      now - 86400000,
      Date.parse(c.connectionChangedAt || 0) || 0,
      Date.parse(c.credentialChangedAt || 0) || 0,
    ),
  ).toISOString();
// The latest scan read the key's model catalog on the current connection.
export const catalogReadable = (c) =>
  c.catalogObservation?.status === "ok" &&
  (c.catalogObservation.connectionVersion || 1) === (c.connectionVersion || 1);
export function catalogListed(store, c, modelId) {
  const catalog = store.get("offering", `${c.id}:${modelId}`)?.catalog;
  return (
    catalogReadable(c) &&
    !!catalog?.present &&
    (catalog.connectionVersion || 1) === (c.connectionVersion || 1)
  );
}
export function observeChannelSuccess(store, channelId, at) {
  for (const scope of ["scan", "task", "calls"])
    observeSuccess(store, "channel", channelId, scope, at);
  const c = store.require("channel", channelId);
  if (c.maintenance?.failureChecks &&
      Date.parse(at) >= Date.parse(c.maintenance.failureChecks.at))
    store.put("channel", { ...c, maintenance: { ...c.maintenance, failureChecks: null } });
}
export function archiveChannel(store, channelId, reason, evidence) {
  let c = store.require("channel", channelId);
  if (!managedHealth(store, c)) return false;
  const window = observeFailure(store, "channel", channelId, evidence.source, {
    ...evidence, reason, detail: evidence.reason,
    firstFailureAt: reason === "website" ? c.maintenance?.failureChecks?.firstAt : undefined,
  });
  if (!matureFailure(store, window)) return false;
  reason = window.reason;
  evidence = { ...evidence, id: window.evidenceId, at: window.at, reason: window.detail };
  c = store.require("channel", channelId);
  if (!managedHealth(store, c) || (archiveOf(c).length && !c.autoArchive))
    return false;
  if (c.autoArchive?.evidenceId === evidence.id && c.archiveReason === reason)
    return false;
  store.update("channel", c.id, c.version, {
    enabled: false,
    archiveReason: reason,
    availability: archiveLabels[reason],
    archiveNote: evidence.reason,
    archivedAt: c.archivedAt || evidence.at,
    management: {
      ...c.management,
      state: reason === "website" ? "closed" : "maintenance",
    },
    recoveryPolicy: { ...c.recoveryPolicy, enabled: true },
    autoArchive: {
      reason,
      evidenceId: evidence.id,
      source: evidence.source,
      at: evidence.at,
      connectionVersion: c.connectionVersion || 1,
      firstFailureAt: window.firstFailureAt,
      lastFailureAt: window.at,
    },
  });
  return true;
}
// Evidence that the channel works again ends an archive or maintenance state
// without a test run; account and balance waits still hold.
function recoverChannel(store, c, evidence) {
  const failing =
    archiveOf(c, store.get("site", c.siteId)).length > 0 ||
    ["maintenance", "closed"].includes(c.management?.state);
  if (!failing || !maintenanceStatus(store, c).metadataAllowed) return false;
  observeChannelSuccess(store, c.id, evidence.at);
  c = store.require("channel", c.id);
  const previousIssue =
    c.availability || c.archiveReason || c.management?.state;
  store.put("channel", {
    ...c,
    enabled: true,
    archiveReason: null,
    availability: null,
    callIssue: null,
    archivedAt: null,
    autoArchive: null,
    management: { ...c.management, state: "active" },
    maintenance: {
      ...c.maintenance,
      lastRestoredAt: evidence.at,
      previousIssue,
    },
    version: c.version + 1,
  });
  store.action(c.id, {
    kind: "channel_recovered",
    source: evidence.source,
    reason: evidence.reason,
    previousIssue,
    result: "restored",
  });
  return true;
}
// `readable`: channels whose catalog this scan read again after it was not readable.
export function observeScanHealth(store, scan, readable = new Set()) {
  let changed = false;
  for (const catalog of scan.channelCatalogs || []) {
    let c = store.require("channel", catalog.channelId);
    if (
      !managedHealth(store, c) ||
      (catalog.connectionVersion || 1) !== (c.connectionVersion || 1)
    )
      continue;
    const text = catalog.message || "",
      website = scan.website || {};
    const evidence = {
      id: `scan:${scan.scannedAt}:${c.id}`,
      source: "scan",
      at: scan.scannedAt,
    };
    let issue = null;
    if (/maintenance|维护中|暂停服务|暂停运营/i.test(text))
      issue = { reason: "maintenance", note: `站方返回维护状态：${text}` };
    else if (
      catalog.status === "missing_key" &&
      !c.gateway &&
      !c.nativeCredentialRef
    )
      issue = { reason: "invalid", note: "未保存可用于调用的 key，等待补充" };
    else if (
      catalog.status === "login_required" &&
      !tagsOf(c).includes("client_restricted")
    )
      issue = { reason: "invalid", note: `调用凭据被拒绝：${text}` };
    else {
      const webDown =
        website.status === "unreachable" || website.httpStatus >= 404;
      const apiDown =
        ["network_error", "timeout"].includes(catalog.status) ||
        catalog.httpStatus >= 404 ||
        (catalog.status === "unsupported" && webDown);
      if (webDown && apiDown) {
        const old = c.maintenance?.failureChecks;
        const sameVersion =
          old?.connectionVersion === (c.connectionVersion || 1);
        const firstAt = sameVersion ? old.firstAt || old.at : scan.scannedAt;
        const count = sameVersion
          ? old.count + Number(old.at !== scan.scannedAt) : 1;
        store.put("channel", {
          ...c,
          maintenance: {
            ...c.maintenance,
            failureChecks: {
              count,
              at: scan.scannedAt,
              firstAt,
              connectionVersion: c.connectionVersion || 1,
            },
          },
        });
        issue = {
            reason: "website",
            note: `网站与 API 均不可访问（网站 ${website.httpStatus || "连接失败"}，API ${catalog.httpStatus || "连接失败"}）`,
          };
      } else if (apiDown)
        issue = { reason: "call", note: `网站可访问，但 API 持续无响应（${catalog.message || catalog.status}）` };
      else if (c.maintenance?.failureChecks && catalog.status === "ok")
        store.put("channel", {
          ...c,
          maintenance: { ...c.maintenance, failureChecks: null },
        });
    }
    if (issue)
      changed =
        archiveChannel(store, c.id, issue.reason, {
          ...evidence,
          reason: issue.note,
        }) || changed;
    else if (catalog.status === "ok") {
      observeSuccess(store, "channel", c.id, "scan", scan.scannedAt);
      if (readable.has(c.id))
        changed =
          recoverChannel(store, store.require("channel", c.id), {
            ...evidence,
            reason: "模型目录恢复可读",
          }) || changed;
    }
  }
  return changed;
}
// A blocked model returns to routing once its last real failure leaves the call window.
export function routableModels(store, c, now = Date.now()) {
  const since = callWindowStart(c, now);
  return (c.models || []).filter((model) => {
    const health = store.get("offering", `${c.id}:${model}`)?.health;
    return (
      !health?.blocked ||
      health.connectionVersion !== (c.connectionVersion || 1) ||
      !(health.at >= since)
    );
  });
}
function reconcileBlockedModels(store, c, evidence) {
  const models = c.models || [];
  if (!models.length || routableModels(store, c).length) return false;
  const health = models.map(
    (m) => store.get("offering", `${c.id}:${m}`)?.health,
  );
  const reason = health.some((h) => h?.failureType === "invalid")
    ? "invalid"
    : health.some((h) => h?.failureType === "unstable")
      ? "unstable"
      : "call";
  return archiveChannel(store, c.id, reason, {
    ...evidence,
    reason: `启用模型均不可用：${models.join("、")}；${evidence.reason}`,
  });
}
export function observeTaskHealth(store, offering, verification) {
  const c = store.require("channel", offering.channelId);
  if (
    !managedHealth(store, c) ||
    (verification.connectionVersion || 1) !== (c.connectionVersion || 1)
  )
    return false;
  const id = verification.operationId || verification.runId;
  const current = store.require("offering", offering.id);
  if (!id || current.health?.lastTaskId === id) return false;
  const health =
    current.health?.connectionVersion === (c.connectionVersion || 1)
      ? current.health
      : {};
  const next = {
    ...health,
    connectionVersion: c.connectionVersion || 1,
    lastTaskId: id,
    at: verification.at,
  };
  const banned =
    verification.errorType === "account" &&
    /封禁|未注册|account.*banned/i.test(verification.reason || "");
  if (verification.result === "success" && verification.quality === "passed") {
    observeChannelSuccess(store, c.id, verification.at);
    Object.assign(next, {
      taskFailures: 0,
      failedRounds: [],
      hadSuccess: true,
      lastTaskSuccessAt: verification.at,
    });
  } else if (
    verification.result === "failure" &&
    (!nonQualityErrors.includes(verification.errorType) || banned)
  ) {
    const op =
      verification.operationId &&
      store.get("operation", verification.operationId);
    const round = op?.input.parentId || id;
    const rounds = [...new Set([...(health.failedRounds || []), round])].slice(
      -3,
    );
    const failures = (health.taskFailures || 0) + 1;
    const invalid =
      (verification.errorType === "key" &&
        !tagsOf(c).includes("client_restricted")) ||
      banned;
    const retired =
      verification.httpStatus === 410 ||
      /旧接口.*停用|接口已停用|endpoint.*retired/i.test(
        verification.reason || "",
      );
    const unstable =
      (health.hadSuccess ||
        (current.lastPassedVerification &&
          (current.lastPassedVerification.connectionVersion || 1) ===
            (c.connectionVersion || 1))) &&
      rounds.length >= 2;
    Object.assign(next, {
      taskFailures: failures,
      failedRounds: rounds,
      blocked:
        health.blocked || invalid || retired || unstable || failures >= 3,
      failureType: invalid ? "invalid" : unstable ? "unstable" : "call",
      reason: verification.reason || "任务验收未通过",
    });
  }
  store.put("offering", { ...current, health: next });
  return reconcileBlockedModels(store, c, {
    id: `task:${id}`,
    source: "task",
    at: verification.at,
    reason: next.reason || "任务未通过",
  });
}
// A manual restore clears the block; real calls made before it no longer count.
export function clearModelHealth(store, offeringId) {
  const o = store.require("offering", offeringId);
  if (o.health)
    store.put("offering", {
      ...o,
      health: {
        connectionVersion:
          store.require("channel", o.channelId).connectionVersion || 1,
        blocked: false,
        clearedAt: new Date().toISOString(),
      },
    });
}
export function reconcileCallHealth(store, channelIds) {
  let changed = false;
  for (const c of store
    .list("channel")
    .filter((c) => channelIds.includes(c.id) && managedHealth(store, c))) {
    const since = callWindowStart(c);
    const latest = store.db
      .prepare(
        `SELECT occurred_at,result,error_type FROM calls WHERE channel_id=? AND occurred_at>=? AND ${liveCalls} ORDER BY occurred_at DESC,rowid DESC LIMIT 1`,
      )
      .get(c.id, since);
    if (latest?.result === "success")
      observeChannelSuccess(store, c.id, latest.occurred_at);
    if (
      latest?.result === "failure" &&
      ["rate", "quota"].includes(latest.error_type) &&
      (!c.runtimeIssue || c.runtimeIssue.at < latest.occurred_at)
    ) {
      const account = store.get("account", c.accountId);
      store.put("channel", {
        ...store.require("channel", c.id),
        runtimeIssue: {
          type: latest.error_type,
          at: latest.occurred_at,
          reason:
            latest.error_type === "rate"
              ? "限流，等待可用时段"
              : account?.benefit?.renewal === "automatic"
                ? "当日额度不足，等待自动刷新"
                : "额度不足，等待余额或签到更新",
        },
      });
    } else if (
      latest &&
      !["rate", "quota"].includes(latest.error_type) &&
      c.runtimeIssue &&
      latest.occurred_at >= c.runtimeIssue.at
    )
      store.put("channel", {
        ...store.require("channel", c.id),
        runtimeIssue: null,
      });
    for (const modelId of c.models || []) {
      const o = store.get("offering", `${c.id}:${modelId}`) || {
        id: `${c.id}:${modelId}`,
        channelId: c.id,
        modelId,
      };
      const rows = store.db
        .prepare(
          "SELECT source,source_id,occurred_at,result,error_type,summary FROM calls WHERE channel_id=? AND model=? AND occurred_at>=? AND legacy_import=0 AND (origin IS NULL OR origin='live') AND result IN ('success','failure') ORDER BY occurred_at DESC, rowid DESC LIMIT 20",
        )
        .all(c.id, modelId, since)
        .filter(
          (r) =>
            !nonQualityErrors.includes(r.error_type) ||
            r.summary === "账号封禁",
        );
      if (!rows.length || rows[0].result !== "failure") continue;
      if (
        o.health?.lastTaskSuccessAt &&
        rows[0].occurred_at <= o.health.lastTaskSuccessAt
      )
        continue;
      const failures = rows.findIndex((r) => r.result === "success");
      const streak = failures < 0 ? rows.length : failures;
      const key =
        (rows[0].error_type === "key" &&
          !tagsOf(c).includes("client_restricted")) ||
        rows[0].summary === "账号封禁";
      const retired = rows[0].summary === "接口已停用";
      if (!key && !retired && streak < 3) continue;
      store.put("offering", {
        ...o,
        health: {
          ...o.health,
          connectionVersion: c.connectionVersion || 1,
          blocked: true,
          failureType: key ? "invalid" : "call",
          callFailures: streak,
          hadSuccess:
            o.health?.hadSuccess || rows.some((r) => r.result === "success"),
          at: rows[0].occurred_at,
          reason: key
            ? "真实调用被上游拒绝鉴权"
            : `连续 ${streak} 次真实调用失败`,
        },
      });
    }
    const healthAt = store
      .list("offering")
      .filter((o) => o.channelId === c.id)
      .map((o) => o.health?.at)
      .filter(Boolean)
      .sort()
      .at(-1);
    changed =
      reconcileBlockedModels(store, c, {
        id: `calls:${c.id}:${healthAt}`,
        source: "calls",
        at: healthAt,
        reason: "已排除限流、额度、输入和取消错误",
      }) || changed;
  }
  return changed;
}
