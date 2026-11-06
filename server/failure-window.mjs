import { policies } from "./maintenance-policy.mjs";

const DAY = 86400000;

// A window advances only on distinct observations; silence is not a failure.
export function observeFailure(store, kind, id, scope, evidence) {
  const value = store.require(kind, id);
  const version = value.connectionVersion || 1;
  const old = value.healthWindows?.[scope];
  const previous = old?.connectionVersion === version ? old : null;
  const at = Date.parse(evidence.at);
  if (!Number.isFinite(at) || at > Date.now() + 60000) return previous;
  if (previous?.evidenceId === evidence.id) return previous;
  if (previous && at <= Date.parse(previous.at)) return previous;
  const seed = Date.parse(evidence.firstFailureAt);
  const window = {
    at: evidence.at,
    connectionVersion: version,
    firstFailureAt:
      previous?.count > 0
        ? previous.firstFailureAt
        : Number.isFinite(seed) && seed <= at
          ? evidence.firstFailureAt
          : evidence.at,
    count:
      (previous?.count || (Number.isFinite(seed) && seed < at ? 1 : 0)) + 1,
    reason: evidence.reason,
    detail: evidence.detail,
    evidenceId: evidence.id,
  };
  store.put(kind, {
    ...value,
    healthWindows: { ...value.healthWindows, [scope]: window },
  });
  return window;
}

export function observeSuccess(store, kind, id, scope, at) {
  const value = store.require(kind, id),
    old = value.healthWindows?.[scope];
  if (
    !Number.isFinite(Date.parse(at)) ||
    Date.parse(at) > Date.now() + 60000 ||
    (old &&
      (Date.parse(at) < Date.parse(old.at) ||
        (Date.parse(at) === Date.parse(old.at) && old.count === 0)))
  )
    return false;
  store.put(kind, {
    ...value,
    healthWindows: {
      ...value.healthWindows,
      [scope]: {
        at,
        count: 0,
        connectionVersion: value.connectionVersion || 1,
      },
    },
  });
  return true;
}

export function matureFailure(store, window, now = Date.now()) {
  const days = policies(store).archiveAfterDays;
  return (
    window?.count > 1 &&
    Date.parse(window.at) <= now &&
    Date.parse(window.at) - Date.parse(window.firstFailureAt) >= days * DAY
  );
}

export function archiveReviewHours(store) {
  return policies(store).archiveReviewHours;
}
