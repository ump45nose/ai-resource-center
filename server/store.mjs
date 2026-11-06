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
    this.revision = 0;
    this.statements = new Map();
    this.watchers = new Map();
    this.written = [];
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const keyPath = join(dir, "master.key");
    if (existsSync(join(dir, "center.sqlite")) && !existsSync(keyPath))
      throw new Error("数据库存在但 master.key 缺失，请恢复配套密钥");
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
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS receipts(source TEXT NOT NULL,event_id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(source,event_id));
      CREATE TABLE IF NOT EXISTS requests(scope TEXT NOT NULL,request_id TEXT NOT NULL,input TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(scope,request_id));
    `);
    const columns = new Set(
      this.db
        .prepare("PRAGMA table_info(calls)")
        .all()
        .map((x) => x.name),
    );
    for (const [name, type] of Object.entries({
      upstream_channel: "TEXT",
      application: "TEXT",
      input_tokens: "INTEGER",
      output_tokens: "INTEGER",
      is_stream: "INTEGER",
      group_name: "TEXT",
      token_basis: "TEXT",
      origin: "TEXT",
      legacy_import: "INTEGER NOT NULL DEFAULT 0",
    })) {
      if (!columns.has(name))
        this.db.exec(`ALTER TABLE calls ADD COLUMN ${name} ${type}`);
    }
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS calls_time ON calls(occurred_at); CREATE INDEX IF NOT EXISTS calls_source_channel ON calls(source,upstream_channel)",
    );
  }
  transaction(fn) {
    if (this.db.isTransaction)
      try {
        return fn();
      } catch (error) {
        this.aborted = error;
        throw error;
      }
    this.db.exec("BEGIN IMMEDIATE");
    this.aborted = null;
    this.written = [];
    try {
      const result = fn();
      // A nested failure dooms the whole transaction even if a caller caught it.
      if (this.aborted) throw this.aborted;
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      // Caches keyed by revision may hold rows from the rolled-back writes.
      this.revision++;
      for (const [kind, id] of this.written) this.notify(kind, id);
      if (this.callsTouched) this.callTotals = null;
      throw error;
    } finally {
      this.written = [];
      this.callsTouched = false;
    }
  }
  sql(text) {
    let statement = this.statements.get(text);
    if (!statement)
      this.statements.set(text, (statement = this.db.prepare(text)));
    return statement;
  }
  // Collects ids of `kind` written through put(), including writes later rolled back.
  watch(kind) {
    const ids = new Set();
    this.watchers.set(kind, [...(this.watchers.get(kind) || []), ids]);
    return ids;
  }
  notify(kind, id) {
    for (const ids of this.watchers.get(kind) || []) ids.add(id);
  }
  // Commits from other connections, such as maintenance scripts, invalidate derived caches.
  externalVersion() {
    return this.sql("PRAGMA data_version").get().data_version;
  }
  // All in-process writes to calls go through recordCall(), which reports them here.
  callStats(channelId) {
    const version = this.externalVersion();
    if (!this.callTotals || this.callTotalsVersion !== version) {
      this.callTotals = new Map(
        this.sql(
          "SELECT channel_id,count(*) total,sum(result='success') success,sum(result='failure') failure,max(occurred_at) lastAt FROM calls GROUP BY channel_id",
        )
          .all()
          .map(({ channel_id, ...stats }) => [channel_id, stats]),
      );
      this.callTotalsVersion = version;
      if (this.db.isTransaction) this.callsTouched = true;
    }
    return {
      total: 0,
      success: null,
      failure: null,
      lastAt: null,
      ...this.callTotals.get(channelId),
    };
  }
  noteCall(before, after) {
    if (!this.callTotals) return;
    if (this.db.isTransaction) this.callsTouched = true;
    for (const [row, sign] of [
      [before, -1],
      [after, 1],
    ]) {
      if (!row) continue;
      const stats = this.callTotals.get(row.channel_id) || {
        total: 0,
        success: 0,
        failure: 0,
      };
      const total = stats.total + sign;
      if (!total) this.callTotals.delete(row.channel_id);
      else
        this.callTotals.set(row.channel_id, {
          total,
          success: stats.success + sign * (row.result === "success"),
          failure: stats.failure + sign * (row.result === "failure"),
          lastAt: this.sql(
            "SELECT max(occurred_at) lastAt FROM calls WHERE channel_id=?",
          ).get(row.channel_id).lastAt,
        });
    }
  }
  get(kind, id) {
    const r = this.sql(
      "SELECT data,version FROM entities WHERE kind=? AND id=?",
    ).get(kind, id);
    return r ? { ...JSON.parse(r.data), id, version: r.version } : null;
  }
  list(kind) {
    return this.sql(
      "SELECT id,data,version FROM entities WHERE kind=? ORDER BY rowid",
    )
      .all(kind)
      .map((r) =>
        Object.assign(JSON.parse(r.data), { id: r.id, version: r.version }),
      );
  }
  put(kind, value) {
    this.revision++;
    const { id = randomUUID(), version = 1, ...data } = value;
    this.sql(
      "INSERT INTO entities VALUES(?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data,version=excluded.version",
    ).run(kind, id, JSON.stringify(data), version);
    if (this.db.isTransaction) this.written.push([kind, id]);
    this.notify(kind, id);
    return this.get(kind, id);
  }
  setting(key, value) {
    if (value !== undefined) this.revision++;
    if (value !== undefined)
      this.sql(
        "INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data",
      ).run(key, JSON.stringify(value));
    const r = this.sql("SELECT data FROM settings WHERE key=?").get(key);
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
  require(kind, id) {
    const value = this.get(kind, id);
    if (!value)
      throw Object.assign(new Error(`${kind} 不存在`), { statusCode: 404 });
    return value;
  }
  update(kind, id, version, changes) {
    const old = this.require(kind, id);
    if (old.version !== version)
      throw Object.assign(new Error("资料已被修改，请读取最新版本"), {
        statusCode: 409,
        code: "version_conflict",
        details: { currentVersion: old.version },
      });
    const next = this.put(kind, {
      ...old,
      ...changes,
      id,
      version: version + 1,
    });
    this.action(id, { kind, fields: Object.keys(changes), result: "saved" });
    return next;
  }
}
