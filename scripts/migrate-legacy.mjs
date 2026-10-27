import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Store } from "../server/store.mjs";
import { migrateChannels } from "../server/migrations.mjs";

// Run against an SQLite backup, not a copied live WAL database.
export function migrateLegacy(store, sourceDir, apply = false) {
  const source = new DatabaseSync(join(sourceDir, "center.sqlite"), {
    readOnly: true,
  });
  try {
    if (!readFileSync(join(sourceDir, "master.key")).equals(store.key))
      throw new Error("来源与目标不是配套加密密钥，请使用原数据副本迁移");
    const counts = source
      .prepare("SELECT kind,count(*) count FROM entities GROUP BY kind")
      .all();
    const summary = {
      source: sourceDir,
      entities: counts,
      calls: source.prepare("SELECT count(*) count FROM calls").get().count,
      applied: apply,
    };
    if (!apply) return summary;
    store.transaction(() => {
      for (const row of source.prepare("SELECT * FROM entities").all()) {
        const incoming = JSON.parse(row.data),
          current = store.get(row.kind, row.id);
        // Legacy remains authoritative for its manual fields at this handover.
        store.put(row.kind, {
          ...current,
          ...incoming,
          id: row.id,
          version: Math.max(current?.version || 0, row.version) + 1,
        });
      }
      for (const table of [
        "credentials",
        "refs",
        "events",
        "actions",
        "auth",
      ]) {
        const cols = source
          .prepare(`PRAGMA table_info(${table})`)
          .all()
          .map((c) => c.name);
        const insert = store.db.prepare(
          `INSERT OR REPLACE INTO ${table}(${cols.join(",")}) VALUES(${cols.map(() => "?").join(",")})`,
        );
        for (const row of source.prepare(`SELECT * FROM ${table}`).all())
          insert.run(...cols.map((c) => row[c]));
      }
      const cols = source
        .prepare("PRAGMA table_info(calls)")
        .all()
        .map((c) => c.name)
        .filter((c) => c !== "legacy_import");
      const insertCall = store.db.prepare(
        `INSERT INTO calls(${cols.join(",")},legacy_import) VALUES(${cols.map(() => "?").join(",")},1) ON CONFLICT(source,source_id) DO UPDATE SET legacy_import=1`,
      );
      for (const row of source.prepare("SELECT * FROM calls").all())
        insertCall.run(...cols.map((c) => row[c]));
      const existing = store.setting("sources") || [];
      for (const { key, data } of source
        .prepare("SELECT * FROM settings")
        .all()) {
        if (key === "sources") {
          const incoming = JSON.parse(data);
          const rows = incoming.map((s) => {
            const current = existing.find((x) => x.id === s.id);
            return {
              ...current,
              ...s,
              version: Math.max(
                current?.version && Number.isInteger(current.version)
                  ? current.version
                  : 1,
                Number.isInteger(s.version) ? s.version : 1,
              ),
              ...(typeof s.version === "string"
                ? { platformVersion: s.version }
                : {}),
              ...(s.kind === "cpa"
                ? { enabled: false, syncEnabled: false }
                : {}),
              syncEnabled:
                s.kind === "newapi" ? current?.syncEnabled || false : false,
            };
          });
          store.setting(key, [
            ...rows,
            ...existing.filter((s) => !incoming.some((r) => r.id === s.id)),
          ]);
        } else if (!key.startsWith("migration:") && key !== "maintenancePolicy")
          store.setting(key, JSON.parse(data));
      }
      // Backfill newly imported rows; existing explicit tag edits survive.
      store.db
        .prepare("DELETE FROM settings WHERE key='migration:channel-tags-v1'")
        .run();
      store.setting("legacyImport", {
        at: new Date().toISOString(),
        ...summary,
      });
    });
    migrateChannels(store);
    return summary;
  } finally {
    source.close();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const [sourceDir, targetDir, flag] = process.argv.slice(2);
  if (!sourceDir || !targetDir)
    throw new Error(
      "用法：node scripts/migrate-legacy.mjs 来源快照目录 目标数据目录 [--apply]",
    );
  const store = new Store(targetDir);
  try {
    process.stdout.write(
      JSON.stringify(
        migrateLegacy(store, sourceDir, flag === "--apply"),
        null,
        2,
      ) + "\n",
    );
  } finally {
    store.close();
  }
}
