import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app.mjs";
import { issueToken } from "../server/auth.mjs";

export function upstream() {
  const requests = [],
    remote = new Map(),
    tokens = [],
    logs = [];
  let sequence = 100;
  const fetcher = async (url, options = {}) => {
    const u = new URL(url),
      method = options.method || "GET",
      body = options.body ? JSON.parse(options.body) : null;
    requests.push({ url, method, body, headers: options.headers });
    const json = (data) =>
      new Response(JSON.stringify(data), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    if (u.host === "gateway.test") {
      if (u.pathname === "/api/status")
        return json({
          data: { version: "fixture", log_consume_enabled: true },
        });
      if (u.pathname === "/api/channel/" && method === "GET")
        return json({
          data: { items: [...remote.values()], total: remote.size },
        });
      if (u.pathname === "/api/channel/" && method === "POST") {
        const value = { ...body.channel, id: sequence++ };
        remote.set(value.id, value);
        return json({ success: true });
      }
      if (u.pathname === "/api/channel/" && method === "PUT") {
        remote.set(body.id, { ...remote.get(body.id), ...body });
        return json({ success: true });
      }
      const channel = u.pathname.match(/^\/api\/channel\/(\d+)(\/status)?$/);
      if (channel) {
        if (channel[2]) {
          remote.get(Number(channel[1])).status = body.status;
          return json({ success: true });
        }
        return json({ data: remote.get(Number(channel[1])) });
      }
      if (u.pathname === "/api/log/")
        return json({ data: { items: logs, total: logs.length } });
      if (u.pathname === "/api/token/" && method === "POST") {
        tokens.push({ id: sequence++, ...body });
        return json({ success: true });
      }
      if (u.pathname === "/api/token/search")
        return json({
          data: {
            items: tokens.filter(
              (t) => t.name === u.searchParams.get("keyword"),
            ),
          },
        });
      if (u.pathname.endsWith("/key"))
        return json({ data: { key: "fixture-inference-key" } });
      if (/^\/api\/token\/\d+$/.test(u.pathname) && method === "DELETE")
        return json({ success: true });
    }
    if (u.pathname === "/")
      return new Response("closed website", { status: 503 });
    if (u.pathname === "/v1/models")
      return json({ data: [{ id: "model-A" }, { id: "model-B" }] });
    if (u.pathname === "/api/pricing")
      return json({
        data: [
          { model_name: "model-A", enable_groups: ["default"] },
          { model_name: "model-B", enable_groups: ["default"] },
        ],
      });
    if (u.pathname === "/api/perf-metrics/summary")
      return json({
        data: {
          models: [
            {
              model_name: "model-A",
              success_rate: 99,
              request_count: 100,
              recent_success_rates: [99, 99, 100],
            },
          ],
        },
      });
    if (u.pathname === "/api/perf-metrics")
      return json({
        data: {
          groups: [{ group: "default", success_rate: 99, request_count: 100 }],
        },
      });
    if (u.pathname === "/v1/chat/completions")
      return json({
        id: "smoke-request",
        choices: [{ message: { content: "OK" } }],
      });
    throw new Error(`Unexpected fixture request ${method} ${url}`);
  };
  return { fetcher, requests, remote, tokens, logs };
}

export async function fixture(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), "arc-backend-"));
  const net = upstream();
  const app = await createApp({
    dir,
    fetcher: net.fetcher,
    allowGatewayWrites: true,
    ...options,
  });
  t.after(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const { store, resources, sources } = app.services;
  const token = issueToken(store, "admin");
  const call = (method, url, payload, bearer = token) =>
    app.inject({
      method,
      url,
      ...(payload === undefined ? {} : { payload }),
      headers: { authorization: `Bearer ${bearer}` },
    });
  const site = resources.site({
    name: "Fixture",
    url: "https://upstream.test",
  });
  const account = store.put("account", {
    id: "account",
    siteId: site.id,
    name: "Account",
    balance: 100,
    unit: "credits",
    quota: "long",
    benefit: {},
  });
  const channel = resources.channel({
    siteId: site.id,
    accountId: account.id,
    name: "Channel",
    baseUrl: "https://upstream.test/v1",
    models: ["model-A"],
    enabled: true,
  });
  store.put("channel", {
    ...channel,
    credentialId: store.secret("sk-fixture-private"),
  });
  return {
    app,
    dir,
    call,
    store,
    resources,
    sources,
    site,
    account,
    channel,
    net,
  };
}
