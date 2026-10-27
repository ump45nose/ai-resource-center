import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

// Chrome's own bookmarks API performs the writes; never edit its live profile files.
const appleScript = `on run argv
 tell application "Google Chrome"
  repeat with w in windows
   repeat with t in tabs of w
    if URL of t starts with "chrome://bookmarks" then return execute t javascript (item 1 of argv)
   end repeat
  end repeat
 end tell
 error "请在 Chrome 打开 chrome://bookmarks/"
end run`;
const chrome = (js) =>
  execFileSync("osascript", ["-e", appleScript, js], {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  }).trim();
async function evaluate(fn, arg) {
  chrome(
    `window.__arcBookmarks = null; Promise.resolve((${fn.toString()})(${JSON.stringify(arg)})).then(value => window.__arcBookmarks = {value}, error => window.__arcBookmarks = {error: error.message}); 'started'`,
  );
  for (let i = 0; i < 300; i++) {
    const raw = chrome("JSON.stringify(window.__arcBookmarks)");
    if (raw && raw !== "null") {
      const result = JSON.parse(raw);
      if (result.error) throw new Error(result.error);
      return result.value;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("Chrome 尚未返回结果。先查看书签现状，不重复提交写入。");
}

async function sync({ plan, apply }) {
  const tree = await chrome.bookmarks.getTree();
  const flat = [];
  const walk = (nodes, parents = []) => {
    for (const n of nodes) {
      flat.push({ ...n, path: parents.map((p) => p.title) });
      if (n.children) walk(n.children, [...parents, n]);
    }
  };
  walk(tree);
  const bar = tree[0].children.find((n) => n.id === "1") || tree[0].children[0];
  const roots = flat.filter(
    (n) => !n.url && ["公益站", "生图站", "RP", "rp"].includes(n.title),
  );
  const rootIds = new Set(roots.map((n) => n.id));
  const owned = (n) => {
    let parent = n.parentId;
    while (parent) {
      if (rootIds.has(parent)) return true;
      parent = flat.find((p) => p.id === parent)?.parentId;
    }
    return false;
  };
  const origin = (url) => {
    try {
      return new URL(url).origin;
    } catch {
      return null;
    }
  };
  const siteOrigins = new Map(
    plan.sites.map((s) => [s.id, new Set(s.urls.map(origin).filter(Boolean))]),
  );
  const candidates = flat.filter(
    (n) =>
      n.url && owned(n) && !n.path.some((s) => /签到|保活|本地|自建/.test(s)),
  );
  const desired = plan.folders.flatMap((f) =>
    f.items.map((b) => ({ ...b, url: new URL(b.url).href, path: f.path })),
  );
  const matching = (n, b) => siteOrigins.get(b.siteId).has(origin(n.url));
  if (!apply)
    return {
      desired: desired.length,
      existingMatches: candidates.filter((n) =>
        desired.some((b) => matching(n, b)),
      ).length,
      folders: plan.folders.map((f) => ({
        path: f.path.join(" / "),
        count: f.items.length,
      })),
    };
  let root = roots.find((n) => n.title === plan.rootTitle);
  if (!root)
    root = await chrome.bookmarks.create({
      parentId: bar.id,
      title: plan.rootTitle,
    });
  const folders = new Map([["", root.id]]);
  for (const f of plan.folders) {
    for (let i = 1; i <= f.path.length; i++) {
      const path = f.path.slice(0, i),
        key = path.join("/");
      if (folders.has(key)) continue;
      const parentId = folders.get(path.slice(0, -1).join("/"));
      let existing = flat.find(
        (n) => !n.url && n.parentId === parentId && n.title === path.at(-1),
      );
      if (!existing && path.length === 1 && path[0] === "酒馆") {
        const oldRp = roots.find(
          (n) => n.parentId === parentId && /^rp$/i.test(n.title),
        );
        if (oldRp)
          existing = await chrome.bookmarks.update(oldRp.id, { title: "酒馆" });
      }
      const folder =
        existing ||
        (await chrome.bookmarks.create({ parentId, title: path.at(-1) }));
      folders.set(key, folder.id);
    }
  }
  const used = new Set(),
    result = { moved: 0, updated: 0, created: 0, duplicatesRemoved: 0 };
  for (const b of desired) {
    const parentId = folders.get(b.path.join("/"));
    const matches = candidates.filter((n) => !used.has(n.id) && matching(n, b));
    const n =
      matches.find((n) => n.parentId === parentId) ||
      matches.find((n) => n.url === b.url) ||
      matches[0];
    if (n) {
      used.add(n.id);
      if (n.parentId !== parentId) {
        await chrome.bookmarks.move(n.id, { parentId });
        result.moved++;
      }
      if (n.title !== b.title || n.url !== b.url) {
        await chrome.bookmarks.update(n.id, { title: b.title, url: b.url });
        result.updated++;
      }
    } else {
      await chrome.bookmarks.create({ parentId, title: b.title, url: b.url });
      result.created++;
    }
  }
  for (const n of candidates) {
    if (!used.has(n.id) && desired.some((b) => matching(n, b))) {
      await chrome.bookmarks.remove(n.id);
      result.duplicatesRemoved++;
    }
  }
  const after = await chrome.bookmarks.getTree();
  return { ...result, after };
}

const file = process.argv[2];
if (!file)
  throw new Error(
    "用法：node scripts/sync-chrome-bookmarks.mjs 分类.json [--apply]",
  );
const plan = JSON.parse(readFileSync(file, "utf8"));
const apply = process.argv.includes("--apply");
const before = await evaluate(() => chrome.bookmarks.getTree());
const preview = await evaluate(sync, { plan, apply: false });
console.log(JSON.stringify(preview, null, 2));
if (apply) {
  const dir = join(
    ".integration",
    "bookmarks",
    new Date().toISOString().replace(/[:.]/g, "-"),
  );
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "before.json"), JSON.stringify(before, null, 2), {
    mode: 0o600,
  });
  writeFileSync(join(dir, "plan.json"), JSON.stringify(plan, null, 2), {
    mode: 0o600,
  });
  const { after, ...result } = await evaluate(sync, { plan, apply: true });
  writeFileSync(join(dir, "after.json"), JSON.stringify(after, null, 2), {
    mode: 0o600,
  });
  console.log(JSON.stringify({ ...result, backup: dir }, null, 2));
}
