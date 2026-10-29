import { randomUUID } from "node:crypto";
import { z } from "zod";
import { hash } from "./store.mjs";
import { Problem } from "./errors.mjs";
import { receipt } from "./ingest.mjs";
import { saveHubKey } from "./hub-keys.mjs";
import { isRemoved } from "./channel-rules.mjs";

const newer = (at, previous) =>
  !Number.isFinite(Date.parse(previous)) ||
  Date.parse(at) >= Date.parse(previous);

const url = z
  .url()
  .refine((s) => ["http:", "https:"].includes(new URL(s).protocol));
const account = z
  .object({
    id: z.string().min(1),
    name: z.string(),
    site: z
      .object({ name: z.string(), url, checkinUrl: url.optional() })
      .strict(),
    observedAt: z.iso.datetime(),
    balance: z.number().nullable(),
    dailyBalance: z.number().nonnegative().nullable().optional(),
    longBalance: z.number().nonnegative().nullable().optional(),
    unit: z.string(),
    enabled: z.boolean(),
    siteType: z.string(),
    health: z
      .object({
        status: z.string(),
        reason: z.string().optional(),
        code: z.string().optional(),
      })
      .strict()
      .optional(),
    checkin: z
      .object({
        enabled: z.boolean(),
        customUrl: z.string().nullable().optional(),
        configured: z.boolean().optional(),
        availability: z.enum(["enabled", "disabled"]).optional(),
        ineligibleReason: z.enum(["balance_threshold"]).optional(),
        statusObservedAt: z.iso.datetime().optional(),
        supported: z.boolean().optional(),
        supportStatus: z
          .enum(["supported", "unsupported", "unknown"])
          .optional(),
        lastCheckInDate: z.string().optional(),
        isCheckedInToday: z.boolean().optional(),
      })
      .strict(),
  })
  .strict();
export const hubInventorySchema = z
  .object({
    eventId: z.string().min(1),
    occurredAt: z.iso.datetime(),
    deviceId: z.string().min(1),
    accounts: z.array(account).max(1000),
    removedAccountIds: z.array(z.string()).default([]),
  })
  .strict();
export const hubCredentialsSchema = z
  .object({
    eventId: z.string().min(1),
    occurredAt: z.iso.datetime(),
    accountId: z.string().min(1),
    complete: z.boolean(),
    error: z.string().max(400).optional(),
    credentials: z
      .array(
        z
          .object({
            id: z.string().min(1),
            name: z.string(),
            baseUrl: url,
            protocol: z.enum([
              "OpenAI",
              "OpenAI Responses",
              "Anthropic",
              "Gemini",
            ]),
            key: z.string().min(1).optional(),
            headers: z.record(z.string(), z.string()).optional(),
            enabled: z.boolean(),
            models: z.array(z.string()),
            allowedModelIds: z.array(z.string()).nullable().optional(),
            secretState: z.enum(["present", "unavailable"]),
          })
          .strict(),
      )
      .max(500),
  })
  .strict();

export function hubSyncState(store, source) {
  const accounts = store
    .list("account")
    .filter(
      (a) =>
        a.sourceObservation?.source === source &&
        a.sourceObservation.present !== false &&
        !a.mergedInto,
    );
  const keys = accounts
    .flatMap((a) => a.hubKeys || [])
    .filter((k) => k.source === source && k.present !== false);
  return {
    ...store.setting(`hubSync:${source}`),
    accounts: accounts.filter(
      (a) => a.sourceObservation.siteType !== "credential-profile",
    ).length,
    profiles: accounts.filter(
      (a) => a.sourceObservation.siteType === "credential-profile",
    ).length,
    balances: accounts.filter((a) => a.balance != null).length,
    credentials: keys.filter((k) => k.credentialId).length,
    missingCredentials: keys.filter((k) => !k.credentialId).length,
    keyReadErrors: accounts.filter((a) => a.keySync?.error).length,
    keyReadPending: accounts.filter(
      (a) =>
        a.sourceObservation.enabled !== false &&
        !a.keySync &&
        a.sourceObservation.siteType !== "credential-profile",
    ).length,
  };
}

// Only newly discovered API accounts can request native key provisioning.
// Curated sites and bookmark onboarding keep their existing owners and rules.
function newHubAccount(store, account, source) {
  const site = store.get("site", account.siteId);
  return !!(
    site &&
    !site.removed &&
    !site.mergedInto &&
    !site.resourceExcluded &&
    !site.curation &&
    site.sources?.every((s) => s === source) &&
    !account.mergedInto &&
    account.enabled !== false &&
    account.sourceObservation?.source === source &&
    account.sourceObservation.present !== false &&
    account.sourceObservation.enabled !== false &&
    !["browser-recipe", "credential-profile"].includes(
      account.sourceObservation.siteType,
    ) &&
    !store.list("channel").some((c) => c.siteId === site.id && !c.mergedInto) &&
    !store
      .list("bookmark-import")
      .some((j) => j.origin === new URL(site.url).origin)
  );
}
function provisioningAccounts(resources, source) {
  if (!resources.distribution?.config("newapi").enabled) return [];
  return resources.store
    .list("account")
    .filter(
      (a) =>
        newHubAccount(resources.store, a, source) &&
        !(a.hubKeys || []).some((k) => k.present !== false),
    )
    .map((a) => a.sourceObservation.externalId);
}

export function ingestHubInventory(resources, source, raw) {
  const p = hubInventorySchema.parse(raw),
    store = resources.store;
  const balances = [];
  const result = receipt(store, source, p.eventId, () => {
    let created = 0,
      updated = 0;
    for (const row of p.accounts) {
      const id = store.ref(source, "account", row.id);
      const old = id && store.get("account", id);
      const site = old
        ? store.require("site", old.siteId)
        : resources.site(row.site, source);
      if (!site.curation && !site.checkinUrl && row.site.checkinUrl)
        store.put("site", { ...site, checkinUrl: row.site.checkinUrl });
      const fresh = newer(row.observedAt, old?.confirmedAt);
      const current = store.put("account", {
        ...(!old
          ? {
              id: randomUUID(),
              siteId: site.id,
              name: row.name,
              source,
              sourceId: row.id,
              quota: "long",
              benefit: {},
            }
          : old),
        ...(fresh && row.balance !== null
          ? {
              balance: row.balance,
              unit: row.unit,
              confirmedAt: row.observedAt,
              ...(row.dailyBalance !== undefined
                ? { dailyBalance: row.dailyBalance }
                : {}),
              ...(row.longBalance !== undefined
                ? { longBalance: row.longBalance }
                : {}),
            }
          : !old
            ? { balance: null, unit: row.unit }
            : {}),
        sourceObservation: !newer(
          p.occurredAt,
          old?.sourceObservation?.observedAt,
        )
          ? old.sourceObservation
          : {
              ...old?.sourceObservation,
              source,
              externalId: row.id,
              name: row.name,
              siteName: row.site?.name,
              siteUrl: row.site.url,
              checkinUrl: row.site?.checkinUrl || null,
              siteType: row.siteType,
              enabled: row.enabled,
              ...(row.health ? { health: row.health } : {}),
              checkin: row.checkin,
              observedAt: p.occurredAt,
              deviceId: p.deviceId,
              present: true,
            },
      });
      store.ref(source, "account", row.id, current.id);
      if (fresh && row.balance !== null && row.observedAt !== old?.confirmedAt)
        balances.push(current.id);
      old ? updated++ : created++;
    }
    for (const externalId of p.removedAccountIds) {
      const id = store.ref(source, "account", externalId),
        a = id && store.get("account", id);
      if (
        a &&
        (!a.sourceObservation?.observedAt ||
          newer(p.occurredAt, a.sourceObservation.observedAt))
      )
        store.put("account", {
          ...a,
          sourceObservation: {
            ...a.sourceObservation,
            source,
            present: false,
            observedAt: p.occurredAt,
          },
        });
    }
    store.setting(`received:${source}`, new Date().toISOString());
    store.setting(`hubSync:${source}`, {
      ...store.setting(`hubSync:${source}`),
      lastInventoryAt: new Date().toISOString(),
      deviceId: p.deviceId,
    });
    return {
      eventId: p.eventId,
      created,
      updated,
      removed: p.removedAccountIds.length,
    };
  });
  resources.reconcileAccountState(balances);
  return {
    ...result,
    keyProvisioningAccountIds: provisioningAccounts(resources, source),
  };
}

export function ingestHubCredentials(resources, source, raw) {
  const p = hubCredentialsSchema.parse(raw),
    store = resources.store;
  const balances = [];
  const result = receipt(store, source, p.eventId, () => {
    let accountId = store.ref(source, "account", p.accountId);
    if (!accountId) throw new Problem(409, "请先同步此账号清单");
    let account = store.require("account", accountId);
    if (!newer(p.occurredAt, account.keySync?.observedAt))
      return { eventId: p.eventId, stale: true };
    const acceptedIds = [];
    for (const row of p.credentials) {
      const externalId = `${p.accountId}:${row.id}`;
      const previousKey = (account.hubKeys || []).find(
        (k) => k.source === source && k.externalId === externalId,
      );
      const credentialId = row.key
        ? row.key ===
          (previousKey?.credentialId && store.reveal(previousKey.credentialId))
          ? previousKey.credentialId
          : store.secret(row.key)
        : previousKey?.credentialId;
      const credentialHeadersId = row.headers
        ? store.secret(
            JSON.stringify(row.headers),
            previousKey?.credentialHeadersId,
          )
        : previousKey?.credentialHeadersId;
      const fingerprint = row.key && hash(row.key);
      const sameKey = (c) =>
        fingerprint &&
        c.credentialId &&
        store.db
          .prepare("SELECT fingerprint FROM credentials WHERE id=?")
          .get(c.credentialId)?.fingerprint === fingerprint;
      const mapped = store.ref(source, "channel", externalId);
      let c = mapped && store.get("channel", mapped);
      if (c?.mergedInto) c = store.require("channel", c.mergedInto);
      if (c?.sourceOnly) c = null;
      // Account identity comes first. A different API key is not a new channel.
      const own = store
        .list("channel")
        .filter(
          (x) => x.accountId === accountId && !x.mergedInto && !x.sourceOnly,
        );
      c ||= own.find(sameKey) || own.find((x) => !isRemoved(x)) || own[0];
      if (!c && fingerprint) {
        c = store
          .list("channel")
          .find(
            (x) =>
              x.siteId === account.siteId &&
              !x.mergedInto &&
              !x.sourceOnly &&
              sameKey(x) &&
              (!store.get("account", x.accountId)?.sourceObservation
                ?.externalId ||
                store.get("account", x.accountId).sourceObservation
                  .externalId === p.accountId),
          );
        if (c && c.accountId !== accountId) {
          const curated = store.require("account", c.accountId);
          if (
            account.balance !== null &&
            newer(account.confirmedAt, curated.confirmedAt)
          )
            balances.push(curated.id);
          store.put("account", {
            ...curated,
            sourceObservation: account.sourceObservation,
            ...(account.balance !== null &&
            newer(account.confirmedAt, curated.confirmedAt)
              ? {
                  balance: account.balance,
                  unit: account.unit,
                  confirmedAt: account.confirmedAt,
                }
              : {}),
            hubKeys: [...(curated.hubKeys || []), ...(account.hubKeys || [])],
          });
          store.put("account", { ...account, mergedInto: curated.id });
          store.db
            .prepare("UPDATE events SET account_id=? WHERE account_id=?")
            .run(curated.id, accountId);
          accountId = curated.id;
          store.ref(source, "account", p.accountId, accountId);
          account = store.require("account", accountId);
        }
      }
      // A credential that cannot be read stays an account observation, not an
      // empty callable connection. The first real connection starts paused.
      if (
        !c &&
        credentialId &&
        p.credentials.length === 1 &&
        newHubAccount(store, account, source)
      )
        c = resources.channel({
          siteId: account.siteId,
          accountId,
          name: store.require("site", account.siteId).name,
          baseUrl: row.baseUrl,
          protocol: row.protocol,
          source,
          enabled: false,
          credentialId,
          credentialHeadersId,
          credentialState: "present",
          onboarding: { source, target: "newapi", createdAt: p.occurredAt },
        });
      const fact = {
        id: previousKey?.id || randomUUID(),
        source,
        externalId,
        accountExternalId: p.accountId,
        channelId: c?.id,
        name: row.name,
        baseUrl: row.baseUrl,
        protocol: row.protocol,
        models: row.models,
        allowedModelIds: row.allowedModelIds,
        enabled: row.enabled,
        secretState: row.secretState,
        observedAt: p.occurredAt,
        present: true,
        credentialId,
        credentialHeadersId,
      };
      saveHubKey(store, accountId, fact);
      account = store.require("account", accountId);
      if (c) {
        const previous = c.credentialId && store.reveal(c.credentialId);
        const selected =
          (!c.curation ||
            (c.onboarding?.source === source && !c.curation?.updatedAt)) &&
          c.source === source &&
          !!row.key &&
          (row.key === previous ||
            (!c.credentialId && p.credentials.length === 1) ||
            previousKey?.credentialId === c.credentialId);
        const changed = selected && row.key !== previous;
        store.put("channel", {
          ...c,
          ...(selected
            ? {
                credentialId,
                ...(credentialHeadersId ? { credentialHeadersId } : {}),
                ...(c.credentialState && c.credentialState !== "present"
                  ? {}
                  : { credentialState: "present" }),
                hubObservation: {
                  source,
                  externalId,
                  accountExternalId: p.accountId,
                  name: row.name,
                  baseUrl: row.baseUrl,
                  protocol: row.protocol,
                  models: row.models,
                  allowedModelIds: row.allowedModelIds,
                  enabled: row.enabled,
                  secretState: row.secretState,
                  observedAt: p.occurredAt,
                  present: true,
                },
              }
            : {}),
          ...(changed
            ? { connectionVersion: (c.connectionVersion || 1) + 1 }
            : {}),
        });
        if (changed)
          for (const o of store
            .list("offering")
            .filter((o) => o.channelId === c.id))
            store.put("offering", { ...o, verification: null });
        store.ref(source, "channel", externalId, c.id);
      }
      acceptedIds.push(row.id);
    }
    account = store.require("account", accountId);
    const hubKeys = (account.hubKeys || []).map((k) =>
      p.complete &&
      k.source === source &&
      k.accountExternalId === p.accountId &&
      !p.credentials.some((row) => k.externalId === `${p.accountId}:${row.id}`)
        ? { ...k, present: false, observedAt: p.occurredAt }
        : k,
    );
    for (const channel of store
      .list("channel")
      .filter(
        (c) =>
          c.accountId === accountId &&
          c.hubObservation?.source === source &&
          !c.mergedInto,
      )) {
      const key = hubKeys.find(
        (k) =>
          k.source === source &&
          k.externalId === channel.hubObservation.externalId,
      );
      store.put("channel", {
        ...channel,
        hubObservation:
          key?.credentialId === channel.credentialId
            ? {
                ...channel.hubObservation,
                present: key.present,
                observedAt: key.observedAt,
              }
            : undefined,
      });
    }
    store.put("account", {
      ...account,
      hubKeys,
      keySync: {
        observedAt: p.occurredAt,
        complete: p.complete,
        count: hubKeys.filter(
          (k) => k.source === source && k.present !== false && k.credentialId,
        ).length,
        error: p.error || null,
      },
    });
    store.setting(`received:${source}`, new Date().toISOString());
    store.setting(`hubSync:${source}`, {
      ...store.setting(`hubSync:${source}`),
      lastCredentialsAt: new Date().toISOString(),
    });
    return { eventId: p.eventId, acceptedIds };
  });
  resources.reconcileAccountState(balances);
  resources.onChange?.();
  return {
    ...result,
    keyProvisioningAccountIds: provisioningAccounts(resources, source),
  };
}
