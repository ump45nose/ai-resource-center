import Fastify from "fastify";
import { Distribution } from "./distribution.mjs";
import {
  migrateChannels,
  migrateIndexes,
  migrateUsage,
} from "./migrations.mjs";
import { migrateHubKeys } from "./hub-keys.mjs";
import { registerWeb } from "./web.mjs";
import cookie from "@fastify/cookie";
import { z } from "zod";
import { Store, hash } from "./store.mjs";
import { Resources } from "./resources.mjs";
import { Sources } from "./sources.mjs";
import { Scans } from "./scans.mjs";
import { Operations } from "./operations.mjs";
import { Gateway } from "./gateway.mjs";
import { Evaluations } from "./evaluations.mjs";
import { Maintenance } from "./maintenance.mjs";
import { Scheduler } from "./scheduler.mjs";
import { capabilities } from "./capabilities.mjs";
import {
  bootstrap,
  authorize,
  issueToken,
  login,
  sourceIdentity,
} from "./auth.mjs";
import { Problem, publicValue, errorMessage } from "./errors.mjs";
import { ingestAccounts } from "./ingest.mjs";
import { checkinExecutionPolicy } from "./checkin-health.mjs";
import { ingestHubInventory, ingestHubCredentials } from "./hub-ingest.mjs";
import { mcpRequest } from "./mcp.mjs";
import { openapi } from "./openapi.mjs";
import { registerHttpSecurity } from "./http-security.mjs";
import { registerLegacy } from "./legacy.mjs";
import { RpSync, registerRp } from "./rp-sync.mjs";
import {
  taskCatalogSchema,
  prepareSchema,
  taskResultSchema,
  ingestSchema,
  connectorReceiptSchema,
  accessSchema,
} from "./transport-schemas.mjs";

export async function createApp({
  dir,
  fetcher = fetch,
  allowGatewayWrites = false,
  worker = false,
} = {}) {
  const store = new Store(dir);
  bootstrap(store, dir);
  migrateIndexes(store);
  migrateChannels(store);
  migrateUsage(store);
  migrateHubKeys(store);
  const existingSources = store.setting("sources") || [];
  if (!existingSources.some((s) => s.id === "all-api-hub"))
    store.setting("sources", [
      ...existingSources,
      {
        id: "all-api-hub",
        name: "All API Hub",
        kind: "all-api-hub",
        url: null,
        enabled: true,
        version: 1,
      },
    ]);
  const resources = new Resources(store),
    sources = new Sources(store, resources, fetcher),
    scans = new Scans(store, fetcher),
    operations = new Operations(store);
  const gateway = new Gateway(store, sources, {
      allowWrites: allowGatewayWrites,
    }),
    evaluations = new Evaluations(store, gateway, operations, fetcher),
    maintenance = new Maintenance(store, scans, operations, gateway),
    scheduler = new Scheduler(store, operations, scans, gateway, maintenance);
  operations.register(
    "sync",
    async ({ sourceId, scope, previewId }, progress) => {
      progress({
        stage: scope === "calls" ? "同步调用记录" : "同步来源资料与调用记录",
      });
      return sources.sync(sourceId, scope, progress, previewId);
    },
  );
  operations.register("check", ({ sourceId }) => sources.check(sourceId));
  operations.register("preview", ({ sourceId }) => sources.preview(sourceId));
  operations.register("maintain", (input, progress, id) =>
    maintenance.run(input, progress, id),
  );
  operations.register("scan", (input, progress) => scans.run(input, progress));
  operations.register("evaluate", (input, progress, id) =>
    evaluations.run(input, progress, id),
  );
  operations.register("apply", ({ offeringId, force, automatic }, progress) => {
    progress({ stage: "应用 New API 配置并回读" });
    return gateway.apply(offeringId, { force, automatic });
  });
  const distribution = new Distribution(
    store,
    resources,
    sources,
    gateway,
    fetcher,
  );
  resources.distribution = distribution;
  gateway.distribution = distribution;
  resources.onChange = () => distribution.reconcile();
  scans.onChange = () => distribution.reconcile();
  evaluations.budget = () => maintenance.budget();
  evaluations.onVerified = (offering, verification) =>
    maintenance.pilotVerified(offering, verification);
  distribution.onApplied = (job) => maintenance.pilotApplied(job);
  resources.reconcileAccountState();
  sources.onInventory = (id, channels, startedAt) =>
    distribution.observeNewApi(id, channels, startedAt);
  const context = {
    rp: new RpSync(store, resources),
    distribution,
    store,
    resources,
    sources,
    scans,
    operations,
    gateway,
    evaluations,
    scheduler,
    maintenance,
  };
  const caps = capabilities(context),
    app = Fastify({ logger: false, bodyLimit: 16 * 1024 * 1024 });
  await app.register(cookie);
  app.setErrorHandler((error, _req, reply) => {
    const status = error instanceof z.ZodError ? 400 : error.statusCode || 500;
    reply.code(status).send({
      code: error.code || `http_${status}`,
      message:
        status >= 500 && !error.statusCode
          ? "服务处理失败"
          : errorMessage(error),
      details: publicValue(error.details),
    });
    if (status >= 500 && !error.statusCode)
      process.stderr.write(`${error.stack}\n`);
  });
  registerHttpSecurity(app, store);
  registerWeb(app);
  app.get("/api/v2/session", (req) => {
    authorize(req.auth);
    return { authenticated: true };
  });
  app.get("/api/health", () => ({
    status: "ok",
    version: "2.0.0",
    gatewayWrites: allowGatewayWrites,
    worker,
  }));
  app.get("/openapi.json", () => openapi(caps));
  for (const path of ["/api/v1/session", "/api/v2/session"]) {
    app.post(path, (req, reply) => {
      const { password } = z.object({ password: z.string() }).parse(req.body);
      const token = login(store, password);
      reply.setCookie("arc_session", token, {
        httpOnly: true,
        sameSite: "strict",
        path: "/",
        maxAge: 8 * 3600,
        secure: req.protocol === "https",
      });
      return { authenticated: true };
    });
    app.delete(path, (req, reply) => {
      if (req.cookies.arc_session)
        store.db
          .prepare("DELETE FROM auth WHERE token_hash=?")
          .run(hash(req.cookies.arc_session));
      reply.clearCookie("arc_session", { path: "/" });
      return { authenticated: false };
    });
  }
  for (const cap of caps)
    app.route({
      method: cap.method,
      url: `/api/v2${cap.path}`,
      handler: async (req, reply) => {
        if (!cap.roles?.includes(req.auth.role)) authorize(req.auth, cap.write);
        const input = cap.schema.parse({
          ...req.query,
          ...req.body,
          ...req.params,
        });
        const result = publicValue(await cap.handler(input, req.auth));
        if (cap.accepted) reply.code(202);
        return result;
      },
    });
  app.post("/api/v2/channels/:id/credential/copy", (req, reply) => {
    if (req.auth.role !== "admin" || !req.cookies.arc_session)
      throw new Problem(403, "请登录管理页面后复制调用 key");
    reply.header("Cache-Control", "no-store");
    const channel = store.require("channel", req.params.id);
    const key = channel.credentialId && store.reveal(channel.credentialId);
    if (!key) throw new Problem(404, "该渠道尚未保存调用 key");
    return { key };
  });
  app.post("/api/v2/access", (req) => {
    if (req.auth.role !== "admin")
      throw new Problem(403, "只有管理员可创建接入凭据");
    const input = accessSchema.parse(req.body);
    if (
      ["ingest", "cron", "rp", "connector"].includes(input.role) &&
      !input.sourceId
    )
      throw new Problem(400, "请绑定来源标识");
    if (
      (input.role === "rp" ||
        (input.role === "connector" && input.target === "sillytavern")) &&
      !input.channelIds?.length && !(input.rpInstanceId && input.rpUserId)
    )
      throw new Problem(400, "酒馆凭据必须绑定具体 RP 连接");
    if (input.role === "connector" && !input.target)
      throw new Problem(400, "执行凭据必须绑定目标");
    return {
      token: issueToken(store, input.role, {
        target: input.target,
        sourceId: input.sourceId,
        channelIds: input.channelIds || [],
        rpInstanceId: input.rpInstanceId,
        rpUserId: input.rpUserId,
        rpRegistration: input.role === "rp" && input.rpRegistration === true,
      }),
    };
  });
  app.get("/api/v2/connector/jobs", (req, reply) => {
    reply.header("Cache-Control", "no-store");
    return req.auth.scope?.rpInstanceId ? context.rp.claim(req.auth) : distribution.claim(req.auth);
  });
  app.post("/api/v2/connector/receipts", (req) =>
    req.auth.scope?.rpInstanceId ? context.rp.receipt(req.auth, connectorReceiptSchema.parse(req.body)) : distribution.acknowledge(req.auth, connectorReceiptSchema.parse(req.body)),
  );
  app.post("/mcp", async (req, reply) => {
    const response = await mcpRequest(caps, req.auth, req);
    reply.code(response.status);
    response.headers.forEach((v, k) => reply.header(k, v));
    return reply.send(await response.text());
  });
  app.get("/mcp", (_req, reply) =>
    reply
      .code(405)
      .header("Allow", "POST")
      .send({ message: "无状态 MCP 使用 POST" }),
  );
  app.post("/api/v1/ingest", (req) => {
    ingestSchema.parse(req.body);
    const source =
      req.auth.role === "admin"
        ? req.body.source || "all-api-hub"
        : sourceIdentity(req.auth);
    if (!source || !Array.isArray(req.body.events))
      throw new Problem(400, "缺少来源和事件");
    return ingestAccounts(resources, source, req.body.events);
  });
  app.get("/api/v2/ingest/checkin-policy", (req, reply) => {
    reply.header("Cache-Control", "no-store");
    return checkinExecutionPolicy(store, sourceIdentity(req.auth));
  });
  app.post("/api/v2/ingest/inventory", (req) =>
    ingestHubInventory(resources, sourceIdentity(req.auth), req.body),
  );
  app.post("/api/v2/ingest/credentials", (req) =>
    ingestHubCredentials(resources, sourceIdentity(req.auth), req.body),
  );
  app.post("/api/v2/ingest/events", (req) => {
    const source =
      req.auth.role === "admin" ? req.body.source : sourceIdentity(req.auth);
    if (!source || !Array.isArray(req.body.events))
      throw new Problem(400, "缺少来源和事件");
    return ingestAccounts(
      resources,
      source,
      req.body.events.map((e) =>
        e.payload
          ? {
              ...e.payload,
              eventId: e.eventId,
              occurredAt: e.occurredAt,
              kind: e.kind,
            }
          : e,
      ),
    );
  });
  app.post("/api/v2/cron/tasks", (req) => {
    const source = sourceIdentity(req.auth, "cron");
    const input = taskCatalogSchema.parse(req.body);
    for (const task of input.tasks)
      store.put("task", {
        ...task,
        id: `${source}:${task.id}`,
        externalId: task.id,
        source,
        observedAt: new Date().toISOString(),
      });
    store.setting(`received:${source}`, new Date().toISOString());
    return { saved: input.tasks.length };
  });
  app.get("/api/v2/cron/verification-jobs", (req) =>
    evaluations.work(sourceIdentity(req.auth, "cron")),
  );
  app.post("/api/v2/cron/runs/prepare", (req) =>
    evaluations.prepare(
      prepareSchema.parse(req.body),
      sourceIdentity(req.auth, "cron"),
    ),
  );
  app.post("/api/v2/ingest/task-results", (req) =>
    evaluations.result(
      taskResultSchema.parse(req.body),
      sourceIdentity(req.auth, "cron"),
    ),
  );
  registerLegacy(app, context);
  registerRp(app, context.rp);
  operations.recover();
  const timer = worker
    ? setInterval(() => {
        scheduler.tick();
        distribution
          .tick()
          .catch((e) => process.stderr.write(`${errorMessage(e)}\n`));
        operations
          .drain()
          .catch((e) => process.stderr.write(`${errorMessage(e)}\n`));
      }, 1000)
    : null;
  timer?.unref();
  app.addHook("onClose", async () => {
    clearInterval(timer);
    await operations.stop();
    while (distribution.running)
      await new Promise((resolve) => setTimeout(resolve, 50));
    store.close();
  });
  return Object.assign(app, { services: context, capabilities: caps });
}
