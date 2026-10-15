import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createApp } from "../server/app.mjs";
import { Store } from "../server/store.mjs";

async function setup(t, fetcher) {
  const dir = mkdtempSync(join(tmpdir(), "arc-aggregation-"));
  const rt = await createApp({
    dir,
    fetcher,
    serveWeb: false,
    password: "test",
  });
  t.after(async () => {
    await rt.app.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const login = await rt.app.inject({
    method: "POST",
    url: "/api/v1/session",
    payload: { password: "test" },
  });
  const cookie = login.cookies[0].name + "=" + login.cookies[0].value;
  rt.store.setting("sources", [
    {
      id: "n",
      name: "New API",
      kind: "newapi",
      url: "http://gateway.invalid",
      credentialId: rt.store.secret("management"),
    },
  ]);
  return { ...rt, cookie };
}
const response = (data) =>
  new Response(JSON.stringify({ success: true, data }));

test("client aggregation isolates groups, preserves native features, and exports only gateway identities", async (t) => {
  let rows = [],
    tokens = [],
    mode = "passive_recovery",
    creates = 0;
  const options = {
    GroupRatio: JSON.stringify({ default: 1 }),
    "group_ratio_setting.group_ratio": JSON.stringify({
      default: 1,
      team: 0.8,
    }),
    UserUsableGroups: JSON.stringify({ default: "默认" }),
  };
  const rt = await setup(t, async (url, init) => {
    const u = new URL(url),
      body = init.body && JSON.parse(init.body);
    if (u.pathname === "/api/option/") {
      if (init.method === "PUT") {
        options[body.key] = body.value;
        return response({});
      }
      return response([
        ...Object.entries(options).map(([key, value]) => ({ key, value })),
        { key: "monitor_setting.auto_test_channel_enabled", value: "true" },
        { key: "monitor_setting.channel_test_mode", value: mode },
      ]);
    }
    if (u.pathname === "/api/channel/") {
      if (init.method === "POST") {
        creates++;
        rows.push({ ...body.channel, id: 43 });
      }
      return response({ items: rows, total: rows.length });
    }
    if (u.pathname === "/api/channel/43") return response(rows[0]);
    if (u.pathname === "/api/token/") {
      tokens.push({ ...body, id: 9 });
      return response({});
    }
    if (u.pathname === "/api/token/search")
      return response({ items: tokens, total: tokens.length });
    if (u.pathname === "/api/token/9/key")
      return response({ key: "gateway-inference" });
    throw new Error("Unexpected request " + u.pathname);
  });
  const c = rt.center.createChannel({
    site: { name: "restricted", url: "https://upstream.invalid" },
    name: "restricted",
    category: "client",
    client: "Claude Code",
    protocol: "Anthropic",
    baseUrl: "https://upstream.invalid/v1",
    models: ["native-sonnet"],
    headers: [{ name: "anthropic-beta", value: "test-beta" }],
    context1m: true,
    key: "upstream-private",
    enabled: true,
  });
  mode = "all";
  await assert.rejects(() => rt.gateways.connect(c.id, "n"), /自动测试模式/);
  assert.equal(creates, 0);
  mode = "passive_recovery";
  const saved = await rt.gateways.connect(c.id, "n");
  assert.equal(rows[0].type, 14);
  assert.equal(rows[0].base_url, "https://upstream.invalid");
  assert.equal(rows[0].group, "arc-claude-code-anthropic");
  assert.equal(rows[0].auto_ban, 0);
  assert.deepEqual(JSON.parse(rows[0].setting), {
    pass_through_body_enabled: true,
  });
  assert.deepEqual(JSON.parse(rows[0].header_override), {
    "*": true,
    "anthropic-beta": "test-beta",
    Authorization: "Bearer {api_key}",
  });
  assert.equal(JSON.parse(options.GroupRatio).default, 1);
  assert.equal(
    JSON.parse(options["group_ratio_setting.group_ratio"])[
      "arc-claude-code-anthropic"
    ],
    1,
  );
  assert.equal(JSON.parse(options.GroupRatio).team, 0.8);
  assert.equal(saved.mode, "manual");
  const exported = await rt.app.inject({
    method: "POST",
    url: "/api/v1/exports",
    headers: { cookie: rt.cookie },
    payload: { channelId: c.id, client: "Claude Code" },
  });
  assert.equal(exported.statusCode, 200, exported.body);
  const cfg = JSON.parse(exported.json().content);
  assert.equal(cfg.env.ANTHROPIC_AUTH_TOKEN, "gateway-inference");
  assert.equal(cfg.env.ANTHROPIC_BASE_URL, "http://gateway.invalid");
  assert.equal(cfg.env.ANTHROPIC_MODEL, "native-sonnet[1m]");
  assert.equal(tokens[0].group, rows[0].group);
  assert.equal(tokens[0].cross_group_retry, false);
  assert.ok(!exported.body.includes("upstream-private"));
  const denied = await rt.app.inject({
    method: "POST",
    url: "/api/v1/exports",
    headers: { cookie: rt.cookie },
    payload: { channelId: c.id, client: "Codex" },
  });
  assert.equal(denied.statusCode, 400);
  const forbidden = rt.center.createChannel({
    site: { name: "direct", url: "https://direct.invalid" },
    name: "direct",
    category: "client",
    client: "Codex",
    protocol: "OpenAI Responses",
    models: ["m"],
    key: "private",
    gatewayAllowed: false,
  });
  await assert.rejects(
    () => rt.gateways.connect(forbidden.id, "n"),
    /禁止网关转发/,
  );
  assert.equal(creates, 1);
});

test("paged log replay retains unmatched records, attributes by source, and reports filtered channel/model/application totals", async (t) => {
  const at = Math.floor(Date.now() / 1000) - 2;
  const logs = Array.from({ length: 102 }, (_, i) => ({
    id: i + 1,
    channel: i === 101 ? 999 : 42,
    type: i === 100 ? 5 : 2,
    model_name: i % 2 ? "m2" : "m1",
    created_at: at,
    token_id: 7,
    is_stream: true,
    prompt_tokens: 3,
    completion_tokens: 2,
    use_time: 1,
    other: JSON.stringify({
      stream_status:
        i === 99
          ? {
              status: "error",
              end_reason: "timeout",
              errors: ["private-upstream-response"],
            }
          : undefined,
      frt: 120,
      status_code: i === 100 ? 429 : undefined,
    }),
    content: i === 100 ? "rate limited" : undefined,
  }));
  let pages = 0;
  const rt = await setup(t, async (url) => {
    const u = new URL(url);
    if (u.pathname === "/api/status")
      return response({ version: "v1.0.0-rc.44" });
    if (u.pathname === "/api/log/") {
      pages++;
      const p = Number(u.searchParams.get("p"));
      return response({
        items: logs.slice((p - 1) * 100, p * 100),
        total: logs.length,
      });
    }
    if (u.pathname === "/api/task") return response({ items: [], total: 0 });
    throw new Error("Unexpected " + u.pathname);
  });
  const c = rt.center.createChannel({
    site: { name: "resource", url: "https://upstream.invalid" },
    name: "resource",
    models: ["m1", "m2"],
    key: "private",
  });
  rt.store.put("channel", {
    ...rt.store.get("channel", c.id),
    gateway: { sourceId: "n", channelId: 42 },
  });
  rt.store.put("identity", {
    id: "correct",
    channelId: c.id,
    sourceId: "n",
    application: "Claude Code · Mac",
    tokenId: 7,
  });
  rt.store.put("identity", {
    id: "other-source",
    channelId: c.id,
    sourceId: "other",
    application: "Wrong application",
    tokenId: 7,
  });
  assert.deepEqual(await rt.gateways.sync("n"), {
    records: 102,
    unmatched: 1,
    tasks: 0,
  });
  await rt.gateways.sync("n");
  assert.equal(pages, 4);
  assert.equal(
    rt.store.db.prepare("SELECT COUNT(*) AS n FROM calls").get().n,
    102,
  );
  const get = async (query) => {
    const r = await rt.app.inject({
      url: "/api/v1/calls?" + new URLSearchParams(query),
      headers: { cookie: rt.cookie },
    });
    assert.equal(r.statusCode, 200, r.body);
    return r.json();
  };
  const all = await get({ limit: 1, groupBy: "application" });
  assert.equal(all.items.length, 1);
  assert.equal(all.summary.total, 102);
  assert.equal(all.summary.inputTokens, 306);
  assert.equal(all.summary.unlinked, 1);
  assert.equal(all.summary.failure, 2);
  const interrupted = rt.store.db
    .prepare("SELECT * FROM calls WHERE source_id='100'")
    .get();
  assert.equal(interrupted.stream_status, "disconnected");
  assert.ok(!JSON.stringify(interrupted).includes("private-upstream-response"));
  assert.deepEqual(
    all.groups.map((x) => x.label),
    ["Claude Code · Mac"],
  );
  const failures = await get({ channelId: c.id, result: "failure" });
  assert.equal(failures.summary.total, 2);
  assert.equal(failures.items[0].error_type, "rate");
  assert.equal(failures.items[0].summary, "HTTP 429 · 限流");
  const unknown = await get({ channelId: "__unknown" });
  assert.equal(unknown.summary.total, 1);
  assert.equal(unknown.items[0].channelName, "待关联渠道");
  const model = await get({ model: "m1", application: "Claude Code · Mac" });
  assert.equal(model.summary.total, 51);
  assert.equal(rt.store.get("channel", c.id).samples, 100); // rate errors affect availability, not long-term quality
  assert.equal((await rt.app.inject({ url: "/api/v1/calls" })).statusCode, 401);
});

test("existing call database upgrades without losing receipts", () => {
  const dir = mkdtempSync(join(tmpdir(), "arc-upgrade-"));
  try {
    const db = new DatabaseSync(join(dir, "center.sqlite"));
    db.exec(
      "CREATE TABLE calls(source TEXT,source_id TEXT,channel_id TEXT,model TEXT,occurred_at TEXT,result TEXT,error_type TEXT,latency REAL,ttft REAL,request_id TEXT,token_id TEXT,stream_status TEXT,summary TEXT,PRIMARY KEY(source,source_id)); INSERT INTO calls VALUES('n','old','c','m','2026-10-14T00:00:00Z','success',NULL,100,20,'request','7',NULL,NULL)",
    );
    db.close();
    const store = new Store(dir);
    const receipt = store.db.prepare("SELECT * FROM calls").get();
    assert.equal(receipt.request_id, "request");
    assert.equal(receipt.input_tokens, null);
    store.close();
    const reopened = new Store(dir);
    assert.equal(
      reopened.db.prepare("SELECT COUNT(*) AS n FROM calls").get().n,
      1,
    );
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("synchronous image completions and failures are retained, asynchronous submission is not counted as generation success", async (t) => {
  const at = Math.floor(Date.now() / 1000) - 1;
  const rt = await setup(t, async (url) => {
    const path = new URL(url).pathname;
    if (path === "/api/status") return response({ version: "v1.0.0-rc.44" });
    if (path === "/api/task")
      return response({
        items: [
          {
            id: 10,
            task_id: "job",
            channel_id: 22,
            model: "image",
            status: "SUCCESS",
            submit_time: at,
          },
        ],
        total: 1,
      });
    if (path === "/api/log/")
      return response({
        items: [
          {
            id: 1,
            channel: 22,
            type: 2,
            model_name: "image",
            created_at: at,
            other: JSON.stringify({ request_path: "/v1/images/generations" }),
          },
          {
            id: 2,
            channel: 22,
            type: 5,
            model_name: "image",
            created_at: at,
            content: "upstream failed",
            other: JSON.stringify({
              status_code: 502,
              request_path: "/v1/images/generations",
            }),
          },
          {
            id: 3,
            channel: 22,
            type: 2,
            model_name: "image",
            created_at: at,
            other: JSON.stringify({ request_path: "/v1/videos" }),
          },
        ],
        total: 3,
      });
    throw new Error("Unexpected " + path);
  });
  const c = rt.center.createChannel({
    site: { name: "media", url: "https://media.invalid" },
    name: "media",
    category: "media",
    models: ["image"],
    key: "private",
  });
  rt.store.put("channel", {
    ...rt.store.get("channel", c.id),
    gateway: { sourceId: "n", channelId: 22 },
  });
  assert.equal((await rt.gateways.sync("n")).records, 2);
  const rows = rt.store.db
    .prepare("SELECT source_id,result FROM calls ORDER BY source_id")
    .all();
  assert.deepEqual(
    rows.map((r) => ({ ...r })),
    [
      { source_id: "1", result: "success" },
      { source_id: "2", result: "failure" },
      { source_id: "task:job", result: "success" },
    ],
  );
});
