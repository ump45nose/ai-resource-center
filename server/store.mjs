import { DatabaseSync } from "node:sqlite";
import {
  randomUUID,
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export const hash = (value) => createHash("sha256").update(value).digest("hex");
export class Store {
  constructor(dir) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const keyPath = join(dir, "master.key");
    if (!existsSync(keyPath))
      writeFileSync(keyPath, randomBytes(32), { mode: 0o600 });
    this.key = readFileSync(keyPath);
    this.db = new DatabaseSync(join(dir, "center.sqlite"));
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS entities(kind TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,PRIMARY KEY(kind,id));
      CREATE TABLE IF NOT EXISTS refs(source TEXT NOT NULL,kind TEXT NOT NULL,external_id TEXT NOT NULL,id TEXT NOT NULL,PRIMARY KEY(source,kind,external_id));
      CREATE TABLE IF NOT EXISTS credentials(id TEXT PRIMARY KEY,value TEXT NOT NULL,fingerprint TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY,account_id TEXT NOT NULL,occurred_at TEXT NOT NULL,business_date TEXT NOT NULL,data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_account_date ON events(account_id,business_date);
      CREATE TABLE IF NOT EXISTS calls(source TEXT NOT NULL,source_id TEXT NOT NULL,channel_id TEXT NOT NULL,model TEXT NOT NULL,occurred_at TEXT NOT NULL,result TEXT NOT NULL,error_type TEXT,latency REAL,ttft REAL,request_id TEXT,token_id TEXT,stream_status TEXT,summary TEXT,PRIMARY KEY(source,source_id));
      CREATE INDEX IF NOT EXISTS calls_channel_time ON calls(channel_id,occurred_at);
      CREATE TABLE IF NOT EXISTS actions(id TEXT PRIMARY KEY,target TEXT NOT NULL,occurred_at TEXT NOT NULL,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS auth(token_hash TEXT PRIMARY KEY,role TEXT NOT NULL,scope TEXT NOT NULL,expires_at INTEGER);
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,data TEXT NOT NULL);`);
  }
  transaction(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  get(kind, id) {
    const r = this.db
      .prepare("SELECT data,version FROM entities WHERE kind=? AND id=?")
      .get(kind, id);
    return r ? { ...JSON.parse(r.data), id, version: r.version } : null;
  }
  list(kind) {
    return this.db
      .prepare(
        "SELECT id,data,version FROM entities WHERE kind=? ORDER BY rowid",
      )
      .all(kind)
      .map((r) => ({ ...JSON.parse(r.data), id: r.id, version: r.version }));
  }
  put(kind, value) {
    const { id = randomUUID(), version = 1, ...data } = value;
    this.db
      .prepare(
        "INSERT INTO entities VALUES(?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data,version=excluded.version",
      )
      .run(kind, id, JSON.stringify(data), version);
    return this.get(kind, id);
  }
  setting(key, value) {
    if (value !== undefined)
      this.db
        .prepare(
          "INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data",
        )
        .run(key, JSON.stringify(value));
    const r = this.db.prepare("SELECT data FROM settings WHERE key=?").get(key);
    return r ? JSON.parse(r.data) : null;
  }
  ref(source, kind, externalId, id) {
    if (id)
      this.db
        .prepare(
          "INSERT INTO refs VALUES(?,?,?,?) ON CONFLICT(source,kind,external_id) DO UPDATE SET id=excluded.id",
        )
        .run(source, kind, String(externalId), id);
    return this.db
      .prepare(
        "SELECT id FROM refs WHERE source=? AND kind=? AND external_id=?",
      )
      .get(source, kind, String(externalId))?.id;
  }
  secret(value, id = randomUUID()) {
    const nonce = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    const body = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    this.db
      .prepare(
        "INSERT INTO credentials VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value,fingerprint=excluded.fingerprint",
      )
      .run(
        id,
        Buffer.concat([nonce, cipher.getAuthTag(), body]).toString("base64"),
        hash(value),
      );
    return id;
  }
  reveal(id) {
    const r = this.db
      .prepare("SELECT value FROM credentials WHERE id=?")
      .get(id);
    if (!r) return null;
    const b = Buffer.from(r.value, "base64"),
      cipher = createDecipheriv("aes-256-gcm", this.key, b.subarray(0, 12));
    cipher.setAuthTag(b.subarray(12, 28));
    return Buffer.concat([
      cipher.update(b.subarray(28)),
      cipher.final(),
    ]).toString("utf8");
  }
  action(target, data) {
    this.db
      .prepare("INSERT INTO actions VALUES(?,?,?,?)")
      .run(
        randomUUID(),
        target,
        new Date().toISOString(),
        JSON.stringify(data),
      );
  }
  close() {
    this.db.close();
  }
}
