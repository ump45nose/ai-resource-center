import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { hash } from "./store.mjs";
import { Problem } from "./errors.mjs";

export function bootstrap(store, dir) {
  if (store.setting("password")) return;
  const password = randomBytes(24).toString("base64url"),
    salt = randomBytes(16).toString("hex");
  store.setting("password", {
    salt,
    digest: scryptSync(password, salt, 32).toString("hex"),
  });
  writeFileSync(join(dir, "admin-password"), password, { mode: 0o600 });
}
export function login(store, password) {
  const p = store.setting("password");
  if (
    !p ||
    !timingSafeEqual(
      scryptSync(password, p.salt, 32),
      Buffer.from(p.digest, "hex"),
    )
  )
    throw new Problem(401, "登录凭据不正确");
  return issueToken(store, "admin", {}, Date.now() + 8 * 3600000);
}
export function issueToken(store, role, scope = {}, expiresAt = null) {
  const token = randomBytes(32).toString("base64url");
  store.db
    .prepare("INSERT INTO auth VALUES(?,?,?,?)")
    .run(hash(token), role, JSON.stringify(scope), expiresAt);
  return token;
}
export function authenticate(store, raw) {
  const row =
    raw &&
    store.db.prepare("SELECT * FROM auth WHERE token_hash=?").get(hash(raw));
  if (!row || (row.expires_at && row.expires_at < Date.now()))
    throw new Problem(401, "请登录或提供有效访问凭据");
  return { role: row.role, scope: JSON.parse(row.scope) };
}
export function authorize(auth, write = false) {
  if (
    auth.role === "admin" ||
    auth.role === "manage" ||
    (!write && auth.role === "read")
  )
    return;
  throw new Problem(403, "凭据没有该操作权限");
}
export function sourceIdentity(auth, expectedRole = "ingest") {
  if (auth.role !== "admin" && auth.role !== expectedRole)
    throw new Problem(403, "来源凭据没有该上报权限");
  const id =
    auth.scope.sourceId ||
    auth.scope.source ||
    (auth.role === "ingest" ? "all-api-hub" : null);
  if (!id) throw new Problem(403, "来源凭据未绑定 sourceId");
  return id;
}
