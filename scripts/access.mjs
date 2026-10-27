import { writeFileSync, statSync, chownSync } from "node:fs";
import { Store } from "../server/store.mjs";
import { issueToken } from "../server/auth.mjs";

const [dir, role, output, sourceId, target, channelList] =
  process.argv.slice(2);
if (
  !dir ||
  !["read", "manage", "ingest", "cron", "rp", "connector"].includes(role) ||
  !output ||
  (["ingest", "cron", "rp", "connector"].includes(role) && !sourceId) ||
  (role === "connector" &&
    !["all-api-hub", "chrome-bookmarks", "sillytavern"].includes(target)) ||
  ((role === "rp" || (role === "connector" && target === "sillytavern")) &&
    !channelList)
)
  throw new Error(
    "用法：node scripts/access.mjs DATA_DIR read|manage|ingest|cron|rp|connector 私密文件路径 [sourceId] [target|-] [channelId,channelId]",
  );
const store = new Store(dir);
try {
  const channelIds = channelList?.split(",").filter(Boolean) || [];
  const token = issueToken(store, role, {
    sourceId,
    target: target === "-" ? undefined : target,
    channelIds,
  });
  writeFileSync(
    output,
    JSON.stringify(
      {
        url: "http://192.168.31.201:18323",
        token,
        role,
        sourceId,
        target,
        channelIds,
      },
      null,
      2,
    ) + "\n",
    { mode: 0o600, flag: "wx" },
  );
  const owner = statSync(dir);
  if (process.getuid?.() === 0) chownSync(output, owner.uid, owner.gid);
  process.stdout.write(`接入配置已写入 ${output}\n`);
} finally {
  store.close();
}
