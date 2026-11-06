import { archiveLabels } from "./channel-rules.mjs";
import {
  observeFailure,
  observeSuccess,
  matureFailure,
  archiveReviewHours,
} from "./failure-window.mjs";

export const confirmedCheckin = (event) =>
  ["成功", "已签到"].includes(event.result) ||
  (event.result === "未执行" && event.reason === "already_checked_today");

function failureReason(event) {
  if (
    [
      "account_disabled",
      "auto_checkin_disabled",
      "center_archived",
      "no_provider",
      "no_selected_method",
      "balance_threshold",
      "cancelled",
    ].includes(event.reason)
  )
    return null;
  if (
    event.result === "需登录" ||
    ["authentication_required", "permission_denied"].includes(event.reason)
  )
    return "invalid";
  if (
    [
      "source_unavailable",
      "network_error",
      "upstream_error",
      "timeout",
    ].includes(event.reason)
  )
    return "website";
  if (["quota_exhausted", "insufficient_balance"].includes(event.reason))
    return "balance";
  if (["失败", "待确认", "需人工操作", "无法签到"].includes(event.result))
    return "maintenance";
  return null;
}

export function observeCheckinHealth(
  store,
  accountId,
  event,
  { apply = true } = {},
) {
  const account = store.require("account", accountId);
  if (account.mergedInto) return;
  if (confirmedCheckin(event)) {
    if (
      observeSuccess(
        store,
        "account",
        accountId,
        "checkin",
        event.occurredAt,
      ) &&
      account.checkinArchive?.active
    ) {
      const current = store.require("account", accountId);
      store.put("account", {
        ...current,
        checkinArchive: {
          ...current.checkinArchive,
          active: false,
          recoveredAt: event.occurredAt,
        },
      });
      store.action(accountId, {
        kind: "checkin_recovered",
        result: "confirmed",
        occurredAt: event.occurredAt,
      });
    }
    return;
  }
  const reason = failureReason(event);
  if (!reason) return;
  observeFailure(store, "account", accountId, "checkin", {
    id: event.eventId,
    at: event.occurredAt,
    reason,
    detail: `${event.result}：${event.reason || "签到未确认"}`,
  });
  if (apply) reconcileCheckinArchive(store, accountId);
}

function reconcileCheckinArchive(store, id) {
  const account = store.require("account", id),
    window = account.healthWindows?.checkin;
  if (
    !store.setting("maintenancePolicy")?.enabled ||
    account.enabled === false ||
    account.sourceObservation?.enabled === false ||
    account.sourceObservation?.present === false ||
    account.sourceObservation?.checkin?.enabled === false ||
    account.checkinEnabled === false ||
    account.mergedInto ||
    !matureFailure(store, window)
  )
    return;
  if (
    account.checkinArchive?.active &&
    account.checkinArchive.reason === window.reason
  )
    return;
  const now = new Date().toISOString();
  store.put("account", {
    ...account,
    checkinArchive: {
      active: true,
      reason: window.reason,
      label: archiveLabels[window.reason],
      detail: window.detail,
      firstFailureAt: window.firstFailureAt,
      lastFailureAt: window.at,
      at: account.checkinArchive?.active ? account.checkinArchive.at : now,
      reviewAt: new Date(
        Date.now() + archiveReviewHours(store) * 3600000,
      ).toISOString(),
    },
  });
  store.action(id, {
    kind: "checkin_archived",
    reason: window.reason,
    firstFailureAt: window.firstFailureAt,
    result: "automatic_execution_paused",
  });
}

// Reconstruct streaks from received history once, without treating missing days as failures.
export function reconcileCheckinArchives(store) {
  if (!store.setting("maintenancePolicy")?.enabled) return;
  if (!store.setting("migration:checkin-health-window-v1")) {
    // An ingest may already have recorded today's observation before this first tick.
    // Replay its complete stored history so that observation cannot hide earlier failures.
    for (const account of store.list("account")) {
      if (!account.healthWindows?.checkin) continue;
      const { checkin, ...otherWindows } = account.healthWindows;
      store.put("account", { ...account, healthWindows: otherWindows });
    }
    for (const row of store.db
      .prepare(
        "SELECT id,account_id,occurred_at,data FROM events WHERE json_extract(data,'$.kind')='checkin' ORDER BY occurred_at,id",
      )
      .all()) {
      if (!store.get("account", row.account_id)) continue;
      const event = JSON.parse(row.data);
      observeCheckinHealth(
        store,
        row.account_id,
        { ...event, occurredAt: row.occurred_at, eventId: row.id },
        { apply: false },
      );
    }
    store.setting(
      "migration:checkin-health-window-v1",
      new Date().toISOString(),
    );
  }
  for (const account of store.list("account"))
    reconcileCheckinArchive(store, account.id);
}

export function checkinExecutionPolicy(store, source) {
  const hours = archiveReviewHours(store);
  return {
    generatedAt: new Date().toISOString(),
    reviewHours: hours,
    accounts: store
      .list("account")
      .filter(
        (a) =>
          !a.mergedInto &&
          (a.sourceObservation?.source === source || a.source === source) &&
          a.checkinArchive?.active,
      )
      .map((a) => ({
        accountId: a.sourceObservation?.externalId || a.sourceId,
        reason: a.checkinArchive.reason,
        detail: a.checkinArchive.detail,
        archivedAt: a.checkinArchive.at,
        reviewAt: a.checkinArchive.reviewAt,
      }))
      .filter((a) => a.accountId),
  };
}
