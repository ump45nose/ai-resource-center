import { randomUUID } from "node:crypto";

export const hubKeyId = (key) => `${key.source}:${key.externalId}`;

export function saveHubKey(store, accountId, key) {
  const account = store.require("account", accountId);
  const keys = account.hubKeys || [];
  key = { ...key, credentialStatus: key.credentialId ? "present" : "missing" };
  store.put("account", {
    ...account,
    hubKeys: [...keys.filter((x) => hubKeyId(x) !== hubKeyId(key)), key],
  });
}

// Older deliveries stored one key observation on each channel. Keep those keys
// as account assets before consolidating their duplicate channel records.
export function seedHubKeys(store) {
  for (const c of store.list("channel")) {
    if (!c.hubObservation) continue;
    saveHubKey(store, c.accountId, {
      ...c.hubObservation,
      id: randomUUID(),
      channelId: c.id,
      credentialId: c.credentialId,
      credentialHeadersId: c.credentialHeadersId,
    });
  }
  store.setting("migration:hub-account-keys-v1", {
    at: new Date().toISOString(),
  });
}

export function migrateHubKeys(store) {
  if (store.setting("migration:hub-account-keys-v1")) return;
  store.transaction(() => seedHubKeys(store));
}
