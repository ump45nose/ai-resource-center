import {
  archiveOf,
  isRemoved,
  isInternal,
  usageOf,
  tagsOf,
} from "./channel-rules.mjs";
import { currentBalance, entitlement } from "./maintenance-policy.mjs";

export function checkinAccount(store, account) {
  const own = account.sourceObservation;
  // A verified native method supersedes the old browser-only executor;
  // keep its association so historical rewards still belong to this account.
  if (own?.source === "all-api-hub" && own.enabled !== false &&
      own.checkin?.enabled === true && own.checkin.configured === true &&
      own.checkin.supported === true && own.checkin.availability === "enabled")
    return account;
  return account.checkinAccountId
    ? store.require("account", account.checkinAccountId)
    : account;
}

export function automaticCheckin(store, account) {
  const executor = checkinAccount(store, account),
    observation = executor.sourceObservation;
  return (
    account.checkinEnabled !== false &&
    executor.checkinEnabled !== false &&
    executor.enabled !== false &&
    observation?.source === "all-api-hub" &&
    observation.present !== false &&
    observation.enabled !== false &&
    observation.checkin?.enabled === true &&
    observation.checkin.supportStatus !== "unsupported" &&
    observation.checkin.supported !== false
  );
}

// Browser check-in workers keep their original login identity and event history.
// Only an unambiguous beneficiary is linked; this never merges login accounts.
export function linkCheckinAccounts(store) {
  const sites = store.list("site").filter((s) => !s.removed && !s.mergedInto),
    accounts = store.list("account").filter((a) => !a.mergedInto),
    channels = store
      .list("channel")
      .filter(
        (c) =>
          !isRemoved(c) && !isInternal(c) && !c.sourceOnly && !c.mergedInto,
      ),
    linked = [];
  for (const executor of accounts.filter(
    (a) =>
      a.enabled !== false && a.checkinEnabled !== false &&
      a.sourceObservation?.enabled !== false &&
      a.sourceObservation?.source === "all-api-hub" &&
      a.sourceObservation.present !== false &&
      (/^(personal-checkin|image-reward)-/.test(
        a.sourceObservation.externalId || "",
      ) ||
        ["lupi", "songbey", "flowrealm"].includes(
          a.sourceObservation.siteType,
        )) &&
      !channels.some((c) => c.accountId === a.id),
  )) {
    const executorSite = sites.find((s) => s.id === executor.siteId);
    if (!executorSite) continue;
    const host = new URL(executorSite.url).hostname;
    const beneficiaries = sites
      .filter((s) =>
        [s.url, s.checkinUrl]
          .filter(Boolean)
          .some((url) => new URL(url).hostname === host),
      )
      .flatMap((s) => {
        const ids = [
          ...new Set(
            channels.filter((c) => c.siteId === s.id).map((c) => c.accountId),
          ),
        ];
        return ids.length === 1 ? ids : [];
      });
    if (beneficiaries.length !== 1) continue;
    const account = store.require("account", beneficiaries[0]);
    if (account.checkinAccountId && account.checkinAccountId !== executor.id)
      continue;
    if (account.checkinAccountId !== executor.id) {
      store.update("account", account.id, account.version, {
        checkinAccountId: executor.id,
      });
      linked.push({ accountId: account.id, executorId: executor.id });
    }
    if (executor.role !== "checkin")
      store.update("account", executor.id, executor.version, {
        role: "checkin",
      });
  }
  return linked;
}

export function archiveDepletedAccounts(store, accountIds) {
  const archived = [];
  for (const id of new Set(accountIds)) {
    const account = store.require("account", id);
    if (
      account.role === "checkin" ||
      !currentBalance(account) ||
      entitlement(account).dailyBalance > 0 ||
      entitlement(account).longBalance > 0 ||
      automaticCheckin(store, account) ||
      account.benefit?.renewal === "automatic"
    )
      continue;
    for (const c of store
      .list("channel")
      .filter(
        (c) =>
          c.accountId === id &&
          c.enabled &&
          !c.sourceOnly &&
          !c.mergedInto &&
          !isRemoved(c) &&
          !isInternal(c) &&
          !archiveOf(c).length &&
          usageOf(c) !== "rp" &&
          !tagsOf(c).includes("no_probe") &&
          !c.management?.fixed &&
          !c.management?.manualOnly &&
          !c.management?.prohibited &&
          c.management?.state !== "paused",
      )) {
      const at = new Date().toISOString();
      store.update("channel", c.id, c.version, {
        enabled: false,
        archiveReason: "balance",
        availability: "无余额无签到",
        archiveNote: "余额已耗尽，未启用自动签到",
        archivedAt: at,
        management: { ...c.management, state: "maintenance" },
        autoArchive: {
          reason: "balance",
          accountId: id,
          balanceObservedAt: account.confirmedAt,
          at,
        },
        curation: { ...c.curation, authority: "center", updatedAt: at },
      });
      archived.push(c.id);
    }
  }
  return archived;
}

// Only an explicit native balance from the same account site may flow to its beneficiary.
// A welfare-site balance is not the API account's balance.
export function reconcileCheckinBalances(store, observedAccountIds) {
  const changed = [];
  for (const account of store.list("account")) {
    if (account.mergedInto || !observedAccountIds.includes(account.checkinAccountId)) continue;
    const executor = store.get("account", account.checkinAccountId);
    if (!executor || executor.balance == null || !["积分", "点", "白晶", "张（当日）"].includes(executor.unit)) continue;
    const sourceSite = store.get("site", executor.siteId), targetSite = store.get("site", account.siteId);
    if (!sourceSite || !targetSite || new URL(sourceSite.url).hostname !== new URL(targetSite.url).hostname) continue;
    if (!Number.isFinite(Date.parse(executor.confirmedAt)) ||
        Date.parse(account.confirmedAt) >= Date.parse(executor.confirmedAt)) continue;
    store.update("account", account.id, account.version, {
      balance: executor.balance, unit: executor.unit, confirmedAt: executor.confirmedAt,
      ...(executor.dailyBalance != null ? {dailyBalance: executor.dailyBalance} : {}),
      ...(executor.longBalance != null ? {longBalance: executor.longBalance} : {}),
      balanceSourceAccountId: executor.id,
    });
    changed.push(account.id);
  }
  return changed;
}
