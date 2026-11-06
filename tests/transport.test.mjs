import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { issueToken } from "../server/auth.mjs";
import { fixture } from "./helpers.mjs";

const mcpHeaders = {
  accept: "application/json, text/event-stream",
  "content-type": "application/json",
};
const listTools = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };

async function sessionCookie(f) {
  const password = readFileSync(join(f.dir, "admin-password"), "utf8");
  const r = await f.app.inject({
    method: "POST",
    url: "/api/v2/session",
    payload: { password },
  });
  assert.equal(r.statusCode, 200, r.body);
  return `arc_session=${r.cookies.find((c) => c.name === "arc_session").value}`;
}

test("OpenAPI keeps every method on shared paths with unique operation IDs", async (t) => {
  const f = await fixture(t);
  const spec = (await f.app.inject({ url: "/openapi.json" })).json();
  const tasks = spec.paths["/api/v2/cron/tasks"];
  assert.equal(tasks.get.operationId, "resource_list_tasks");
  assert.equal(tasks.post.operationId, "api_v2_cron_tasks");
  const session = spec.paths["/api/v2/session"];
  assert.equal(session.post.operationId, "api_v2_session");
  assert.deepEqual(session.post.security, []);
  assert.ok(session.delete);
  assert.equal(session.delete.requestBody, undefined);
  assert.deepEqual(session.delete.security, [{ session: [] }]);
  const ids = Object.values(spec.paths).flatMap((methods) =>
    Object.values(methods).map((o) => o.operationId),
  );
  assert.equal(new Set(ids).size, ids.length);
  for (const cap of f.app.capabilities)
    assert.ok(ids.includes(cap.name), cap.name);
});

test("malformed or foreign Origin headers are rejected with 403, not 500", async (t) => {
  const f = await fixture(t);
  const cookie = await sessionCookie(f);
  const rename = (origin, name) =>
    f.app.inject({
      method: "PATCH",
      url: `/api/v2/sites/${f.site.id}`,
      payload: { version: f.site.version, changes: { name } },
      headers: { cookie, host: "arc.test", origin },
    });
  for (const origin of ["null", "not a url", "https://evil.test"]) {
    const r = await rename(origin, "Forged");
    assert.equal(r.statusCode, 403, `${origin}: ${r.body}`);
    assert.equal(r.json().message, "管理会话来源不一致");
  }
  assert.equal(f.store.require("site", f.site.id).name, "Fixture");
  const same = await rename("https://arc.test", "Renamed");
  assert.equal(same.statusCode, 200, same.body);
  const logout = await f.app.inject({
    method: "DELETE",
    url: "/api/v2/session",
    headers: { cookie, host: "arc.test", origin: "null" },
  });
  assert.equal(logout.statusCode, 403, logout.body);
  const read = issueToken(f.store, "read");
  for (const url of ["/mcp", "/mcp?probe=1", "/%6dcp"]) {
    const mcp = await f.app.inject({
      method: "POST",
      url,
      headers: {
        ...mcpHeaders,
        authorization: `Bearer ${read}`,
        origin: "null",
      },
      payload: listTools,
    });
    assert.equal(mcp.statusCode, 403, `${url}: ${mcp.body}`);
    assert.equal(mcp.json().message, "MCP 请求来源不一致");
  }
});

test("encoded paths still pass the authentication gate", async (t) => {
  const f = await fixture(t);
  for (const url of ["/%61pi/v2/sites", "/api/v2/%73ites", "/%61pi/v1/calls"]) {
    const r = await f.app.inject({ url });
    assert.equal(r.statusCode, 401, `${url}: ${r.body}`);
  }
  const r = await f.app.inject({
    method: "POST",
    url: "/api/v2/session?next=/",
    payload: { password: "wrong" },
  });
  assert.equal(r.statusCode, 401);
  assert.equal(r.json().message, "登录凭据不正确");
});

test("CORS skips unusable stored source URLs and never allows opaque origins", async (t) => {
  const f = await fixture(t);
  f.store.setting("sources", [
    ...f.store.setting("sources"),
    { id: "st-null", kind: "sillytavern", url: null },
    { id: "st-bad", kind: "sillytavern", url: "not a url" },
    { id: "st-opaque", kind: "sillytavern", url: "data:text/plain,x" },
    { id: "st", kind: "sillytavern", url: "https://tavern.test/st/" },
  ]);
  const request = (method, origin) =>
    f.app.inject({
      method,
      url: "/api/v2/sites",
      headers: {
        origin,
        authorization: `Bearer ${issueToken(f.store, "read")}`,
      },
    });
  const preflight = await request("OPTIONS", "https://tavern.test");
  assert.equal(preflight.statusCode, 204);
  assert.equal(
    preflight.headers["access-control-allow-origin"],
    "https://tavern.test",
  );
  const get = await request("GET", "https://tavern.test");
  assert.equal(get.statusCode, 200, get.body);
  assert.equal(
    get.headers["access-control-allow-origin"],
    "https://tavern.test",
  );
  for (const origin of ["null", "https://evil.test"]) {
    const r = await request("GET", origin);
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.headers["access-control-allow-origin"], undefined, origin);
  }
});

test("history answers channel-less sites and filters changes by target", async (t) => {
  const f = await fixture(t);
  const empty = f.resources.site({ name: "Empty", url: "https://empty.test" });
  for (const kind of ["", "&kind=calls", "&kind=changes", "&kind=operations"]) {
    const r = await f.call("GET", `/api/v2/history?siteId=${empty.id}${kind}`);
    assert.equal(r.statusCode, 200, `${kind}: ${r.body}`);
    assert.deepEqual(r.json().items, []);
    assert.equal(r.json().nextCursor, null);
  }
  const calls = await f.call("GET", `/api/v2/history?siteId=${empty.id}`);
  assert.ok(calls.json().coverage);
  f.store.action(f.channel.id, {
    kind: "channel",
    fields: ["note"],
    result: "saved",
  });
  f.store.action("other-channel", {
    kind: "channel",
    fields: ["note"],
    result: "saved",
  });
  const changes = (
    await f.call("GET", `/api/v2/history?siteId=${f.site.id}&kind=changes`)
  ).json();
  assert.ok(changes.items.length > 0);
  assert.ok(changes.items.every((r) => r.target === f.channel.id));
  assert.deepEqual(changes.items[0].data.fields, ["note"]);
  const other = (
    await f.call("GET", "/api/v2/history?channelId=other-channel&kind=changes")
  ).json();
  assert.deepEqual(
    other.items.map((r) => r.target),
    ["other-channel"],
  );
});

test("capability roles admit RP credentials to their connection list only", async (t) => {
  const f = await fixture(t);
  const scope = {
    sourceId: "sillytavern",
    rpInstanceId: "tavern-1",
    rpUserId: "user-1",
    channelIds: [f.channel.id],
  };
  const tokens = [
    issueToken(f.store, "rp", scope),
    issueToken(f.store, "connector", { ...scope, target: "sillytavern" }),
  ];
  for (const token of tokens) {
    const list = await f.call(
      "GET",
      "/api/v2/rp/connections",
      undefined,
      token,
    );
    assert.equal(list.statusCode, 200, list.body);
    assert.deepEqual(list.json().items, []);
    assert.equal(
      (await f.call("GET", "/api/v2/sites", undefined, token)).statusCode,
      403,
    );
    assert.equal(
      (await f.call("PATCH", "/api/v2/rp/connections/x", {}, token)).statusCode,
      403,
    );
    const mcp = await f.app.inject({
      method: "POST",
      url: "/mcp",
      headers: { ...mcpHeaders, authorization: `Bearer ${token}` },
      payload: listTools,
    });
    assert.equal(mcp.statusCode, 403, mcp.body);
  }
  const ingest = issueToken(f.store, "ingest", { sourceId: "all-api-hub" });
  assert.equal(
    (await f.call("GET", "/api/v2/rp/connections", undefined, ingest))
      .statusCode,
    403,
  );
  const read = issueToken(f.store, "read");
  assert.equal(
    (await f.call("GET", "/api/v2/rp/connections", undefined, read)).statusCode,
    200,
  );
  assert.equal(
    (
      await f.call(
        "PATCH",
        `/api/v2/sites/${f.site.id}`,
        { version: 1, changes: { name: "Forbidden" } },
        read,
      )
    ).statusCode,
    403,
  );
});

test("MCP forwards only the headers its transport reads", async (t) => {
  const f = await fixture(t);
  const read = issueToken(f.store, "read");
  const post = (headers, payload = listTools) =>
    f.app.inject({
      method: "POST",
      url: "/mcp",
      headers: { ...mcpHeaders, authorization: `Bearer ${read}`, ...headers },
      payload,
    });
  const unsupported = await post({ "mcp-protocol-version": "1999-01-01" });
  assert.equal(unsupported.statusCode, 400, unsupported.body);
  const padded = await post(
    { "mcp-protocol-version": "2025-06-18", cookie: "arc_session=stale" },
    JSON.stringify(listTools) + " ".repeat(5 * 1024 * 1024),
  );
  assert.equal(padded.statusCode, 200, padded.body.slice(0, 300));
  assert.ok(
    padded.json().result.tools.some((tool) => tool.name === "resource_history"),
  );
});

test("bindings share task checks and partial updates keep other fields", async (t) => {
  const f = await fixture(t);
  const cron = issueToken(f.store, "cron", { sourceId: "fn-cron" });
  const task = (id, extra) => ({
    id,
    name: id,
    enabled: true,
    supportsRunConfig: true,
    supportsResult: true,
    ...extra,
  });
  const catalog = await f.call(
    "POST",
    "/api/v2/cron/tasks",
    {
      tasks: [
        task("preview", { supportsScheduledRunConfig: false }),
        task("draft", { supportsRunConfig: false }),
      ],
    },
    cron,
  );
  assert.equal(catalog.statusCode, 200, catalog.body);
  const data = (id, extra) => ({
    taskRef: { source: "fn-cron", id },
    channelId: f.channel.id,
    modelId: "model-A",
    ...extra,
  });
  const create = (d) => f.call("POST", "/api/v2/cron/bindings", { data: d });
  const patch = (b, changes) =>
    f.call("PATCH", `/api/v2/cron/bindings/${b.id}`, {
      version: b.version,
      changes,
    });
  const scheduled = await create(data("preview"));
  assert.equal(scheduled.statusCode, 409);
  assert.equal(
    scheduled.json().message,
    "该任务目前仅支持验证预览，不能绑定正式运行",
  );
  const unadapted = await create(data("draft"));
  assert.equal(unadapted.statusCode, 409);
  assert.equal(
    unadapted.json().message,
    "任务尚未适配或原任务暂停，请先保存为停用绑定",
  );
  const draft = (await create(data("draft", { enabled: false }))).json();
  const enable = await patch(draft, { enabled: true });
  assert.equal(enable.statusCode, 409);
  assert.equal(
    enable.json().message,
    "任务尚未适配或原任务暂停，请先保存为停用绑定",
  );
  const created = await create(
    data("preview", { validationOnly: true, discoverNewModels: true }),
  );
  assert.equal(created.statusCode, 200, created.body);
  const off = await patch(created.json(), { enabled: false });
  assert.equal(off.statusCode, 200, off.body);
  assert.equal(off.json().validationOnly, true);
  assert.equal(off.json().discoverNewModels, true);
  const on = await patch(off.json(), { enabled: true });
  assert.equal(on.statusCode, 200, on.body);
  const evaluation = await f.call("POST", "/api/v2/evaluations", {
    requestId: "binding-evaluation",
    channelId: f.channel.id,
    modelId: "model-A",
  });
  assert.equal(evaluation.statusCode, 202, evaluation.body);
  const { input } = f.store.require("operation", evaluation.json().id);
  assert.deepEqual(input.taskRef, { source: "fn-cron", id: "preview" });
  assert.equal(input.bindingId, created.json().id);
  assert.equal(input.executionMode, "preview");
});

test("validation errors read as one line instead of raw issue JSON", async (t) => {
  const f = await fixture(t);
  const r = await f.call("PATCH", `/api/v2/channels/${f.channel.id}`, {
    version: f.channel.version,
    changes: { management: { manualOnly: true } },
  });
  assert.equal(r.statusCode, 400);
  assert.match(r.json().message, /^参数不正确：changes\.management：/);
  assert.doesNotMatch(r.json().message, /"code"/);
});

test("policy updates reject the removed global sync intervals", async (t) => {
  const f = await fixture(t);
  for (const changes of [{ syncMinutes: 5 }, { callsMinutes: 5 }]) {
    const r = await f.call("PATCH", "/api/v2/policies", { changes });
    assert.equal(r.statusCode, 400, r.body);
  }
});
