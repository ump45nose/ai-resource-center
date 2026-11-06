import { Store } from "../server/store.mjs";
import { rpRemovalKey, revertRpRemoval } from "../server/migrations.mjs";

// Stop the service first and start the previous release afterwards; this release
// removes RP channels again on its next start.
const [dir, flag] = process.argv.slice(2);
if (!dir)
  throw new Error("用法：node scripts/revert-rp-removal.mjs DATA_DIR [--apply]");
const store = new Store(dir);
try {
  const record = store.setting(rpRemovalKey);
  if (!record) throw new Error("没有可撤销的 RP 移出记录");
  console.log(
    JSON.stringify(
      flag === "--apply"
        ? { applied: true, restored: revertRpRemoval(store) }
        : {
            applied: false,
            at: record.at,
            channels: Object.keys(record.removed.channels),
            sites: Object.keys(record.removed.sites),
          },
      null,
      2,
    ),
  );
} finally {
  store.close();
}
