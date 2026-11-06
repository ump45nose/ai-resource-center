// Receipts are stored as plain JSON; keys, tokens and header values belong only in the encrypted vault.
const secretKeys = new Set([
  "key",
  "apikey",
  "xapikey",
  "credential",
  "credentialid",
  "credentialheadersid",
  "pendingcredentialid",
  "nativecredentialref",
  "nativecredentialreference",
  "token",
  "accesstoken",
  "refreshtoken",
  "password",
  "secret",
  "authorization",
  "proxyauthorization",
  "cookie",
  "cookies",
  "headers",
  "headervalues",
  "headeroverride",
  "parameteroverride",
  "setting",
]);

export function withoutSecrets(value) {
  if (Array.isArray(value)) return value.map(withoutSecrets);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !secretKeys.has(key.toLowerCase().replace(/[-_]/g, "")))
      .map(([key, item]) => [key, withoutSecrets(item)]),
  );
}
