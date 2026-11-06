import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Store } from "../server/store.mjs";
import {
  consolidateResources,
  restoreFinalResources,
} from "../server/consolidation.mjs";

const [legacyDir, targetDir, ...flags] = process.argv.slice(2);
if (!legacyDir || !targetDir)
  throw Error(
    "用法：node scripts/consolidate-resources.mjs 旧版最终快照目录 当前数据目录 [--restore-final] [--apply]",
  );
const store = new Store(targetDir);
const legacy = new DatabaseSync(join(legacyDir, "center.sqlite"), {
  readOnly: true,
});
try {
  if (!readFileSync(join(legacyDir, "master.key")).equals(store.key))
    throw Error("旧版快照与当前数据的加密密钥不配套");
  console.log(
    JSON.stringify(
      (flags.includes("--restore-final")
        ? restoreFinalResources
        : consolidateResources)(store, legacy, flags.includes("--apply")),
      null,
      2,
    ),
  );
} finally {
  legacy.close();
  store.close();
}
