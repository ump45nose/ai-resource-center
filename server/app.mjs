import Fastify from "fastify";
import {
  hasBookmarkWork,
  BookmarkImports,
  bookmarkInventorySchema,
  bookmarkOutcomeSchema,
} from "./bookmark-imports.mjs";
import { Distribution } from "./distribution.mjs";
import { migrateChannels, migrateUsage } from "./migrations.mjs";
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
  authenticate,
  authorize,
  issueToken,
  login,
  sourceIdentity,
} from "./auth.mjs";
import { Problem, publicValue, errorMessage } from "./errors.mjs";
import { ingestAccounts } from "./ingest.mjs";
import { ingestHubInventory, ingestHubCredentials } from "./hub-ingest.mjs";
import { mcpRequest } from "./mcp.mjs";
import { registerLegacy } from "./legacy.mjs";
import { RpSync, registerRp } from "./rp-sync.mjs";
import {
  taskCatalogSchema,
  prepareSchema,
  taskResultSchema,
  ingestSchema,
  outputs,
  transportRoutes,
  connectorReceiptSchema,
  accessSchema,
} from "./transport-schemas.mjs";

const jsonSchema = (s) =>
  z.toJSONSchema(s, { io: "input", unrepresentable: "any" });
export function openapi(caps) {
  const paths = {};
  for (const c of caps) {
    const path = `/api/v2${c.path.replace(/:([^/]+)/g, "{$1}")}`;
    const params = [...c.path.matchAll(/:([^/]+)/g)].map((m) => m[1]);
    const bodyShape = Object.fromEntries(
      Object.entries(c.schema.shape).filter(([key]) => !params.includes(key)),
    );
    const parameters = params.map((name) => ({
      name,
      in: "path",
      required: true,
      schema: jsonSchema(c.schema.shape[name]),
    }));
    if (c.method === "GET")
      for (const [name, schema] of Object.entries(bodyShape))
        parameters.push({
          name,
          in: "query",
          required: !schema.isOptional(),
          schema: jsonSchema(schema),
        });
    const outputSchema =
      outputs[c.name] || (c.accepted ? outputs.resource_get_operation : null);
    const output = {
      description: c.description,
      content: {
        "application/json": {
          schema: outputSchema
            ? jsonSchema(outputSchema)
            : { type: "object", additionalProperties: true },
        },
      },
    };
    paths[path] ||= {};
    paths[path][c.method.toLowerCase()] = {
      operationId: c.name,
      summary: c.description,
      security: [{ bearerAuth: [] }, { session: [] }],
      parameters,
      ...(c.method !== "GET"
        ? {
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: jsonSchema(z.object(bodyShape).strict()),
                },
              },
            },
          }
        : {}),
      responses: {
        [c.accepted ? "202" : "200"]: output,
        400: { description: "参数错误" },
        401: { description: "未登录" },
        403: { description: "权限不足" },
        409: { description: "版本或操作范围冲突" },
      },
    };
  }
  for (const [method, path, schema, description] of transportRoutes)
    paths[path] = {
      [method.toLowerCase()]: {
        operationId: path.replace(/[^a-z0-9]/gi, "_").replace(/^_/, ""),
        summary: description,
        ...(method === "GET"
          ? {}
          : {
              requestBody: {
                required: true,
                content: { "application/json": { schema: jsonSchema(schema) } },
              },
            }),
        security: path.endsWith("/session") ? [] : [{ bearerAuth: [] }],
        responses: {
          200: {
            description: "操作结果",
            content: {
              "application/json": {
                schema: { type: "object", additionalProperties: true },
              },
            },
          },
          401: { description: "未授权" },
          403: { description: "来源不匹配" },
        },
      },
    };
  return {
    openapi: "3.1.1",
    info: { title: "公益资源管理 API", version: "2.0.0" },
    paths,
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer" },
        session: { type: "apiKey", in: "cookie", name: "arc_session" },
      },
    },
  };
}

export async function createApp({
  dir,
  fetcher = fetch,
  allowGatewayWrites = false,
  worker = false,
} = {}) {
  const store = new Store(dir);
  bootstrap(store, dir);
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
    bookmarks: new BookmarkImports(store, resources),
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
  app.addHook("onRequest", async (req, reply) => {
    const origin = req.headers.origin;
    if (
      origin &&
      (origin.startsWith("chrome-extension://") ||
        origin.startsWith("moz-extension://") ||
        (store.setting("sources") || []).some(
          (s) => s.kind === "sillytavern" && new URL(s.url).origin === origin,
        ))
    )
      reply
        .header("Access-Control-Allow-Origin", origin)
        .header("Vary", "Origin")
        .header(
          "Access-Control-Allow-Headers",
          "Authorization,Content-Type,MCP-Protocol-Version",
        )
        .header(
          "Access-Control-Allow-Methods",
          "GET,POST,PATCH,PUT,DELETE,OPTIONS",
        );
    if (req.method === "OPTIONS") return reply.code(204).send();
  });
  app.addHook("preHandler", async (req) => {
    if (
      ["/api/health", "/openapi.json"].includes(req.url.split("?")[0]) ||
      ((req.url === "/api/v1/session" || req.url === "/api/v2/session") &&
        req.method === "POST")
    )
      return;
    if (!req.url.startsWith("/api/") && !req.url.startsWith("/mcp")) return;
    const bearer = req.headers.authorization?.replace(/^Bearer /, "");
    req.auth = authenticate(store, bearer || req.cookies.arc_session);
    if (
      req.headers.origin &&
      !bearer &&
      !["GET", "HEAD"].includes(req.method) &&
      new URL(req.headers.origin).host !== req.headers.host
    )
      throw new Problem(403, "管理会话来源不一致");
    if (
      req.url === "/mcp" &&
      req.headers.origin &&
      new URL(req.headers.origin).host !== req.headers.host
    )
      throw new Problem(403, "MCP 请求来源不一致");
  });
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
        if (
          !(
            cap.name === "resource_list_rp_connections" &&
            ["rp", "connector"].includes(req.auth.role)
          )
        )
          authorize(req.auth, cap.write);
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
      !input.channelIds?.length &&
      !(input.rpInstanceId && input.rpUserId)
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
    return req.auth.scope?.rpInstanceId
      ? context.rp.claim(req.auth)
      : distribution.claim(req.auth);
  });
  app.post("/api/v2/connector/receipts", (req) =>
    req.auth.scope?.rpInstanceId
      ? context.rp.receipt(req.auth, connectorReceiptSchema.parse(req.body))
      : distribution.acknowledge(
          req.auth,
          connectorReceiptSchema.parse(req.body),
        ),
  );
  app.post("/mcp", async (req, reply) => {
    const response = await mcpRequest(
      caps,
      req.auth,
      new Request(`http://${req.headers.host}/mcp`, {
        method: "POST",
        headers: req.headers,
        body: JSON.stringify(req.body),
      }),
    );
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
  const bookmarkBrowser = (req) => {
    if (
      req.auth.role !== "connector" ||
      req.auth.scope.target !== "chrome-bookmarks"
    )
      throw new Problem(403, "需要书签执行凭据");
    return req.auth.scope.sourceId;
  };
  app.post("/api/v2/ingest/bookmarks", (req) =>
    context.bookmarks.ingest(
      bookmarkBrowser(req),
      bookmarkInventorySchema.parse(req.body),
    ),
  );
  app.get("/api/v2/bookmark-imports/browser-jobs", (req) => {
    bookmarkBrowser(req);
    return context.bookmarks.jobs();
  });
  app.post("/api/v2/bookmark-imports/:id/browser-result", (req) => {
    bookmarkBrowser(req);
    return context.bookmarks.outcome(
      req.params.id,
      bookmarkOutcomeSchema.parse(req.body),
    );
  });
  app.get("/api/v2/cron/bookmark-imports/available", (req) => {
    sourceIdentity(req.auth, "cron");
    return { available: hasBookmarkWork(store) };
  });
  app.get("/api/v2/cron/bookmark-imports/:id", (req) => {
    const source = sourceIdentity(req.auth, "cron");
    const job = store.require("bookmark-import", req.params.id);
    if (job.workerSource !== source)
      throw new Problem(403, "任务不属于本执行器");
    return publicValue(job);
  });
  app.post("/api/v2/bookmark-imports/claim", (req) => {
    const source = sourceIdentity(req.auth, "cron");
    const { runId, limit } = z
      .object({
        runId: z.string().min(1),
        limit: z.number().int().min(1).max(5).default(3),
      })
      .strict()
      .parse(req.body);
    return context.bookmarks.claim(source, runId, limit);
  });
  app.post("/api/v2/bookmark-imports/:id/result", (req) => {
    const source = sourceIdentity(req.auth, "cron");
    const { runId, ...changes } = z
      .object({
        runId: z.string(),
        state: z.enum([
          "waiting_login",
          "waiting_security",
          "unsupported",
          "failed",
          "needs_model",
        ]),
        reason: z.string().max(500),
        recipe: z.record(z.string(), z.unknown()).optional(),
        api: z
          .object({ available: z.boolean(), reason: z.string().optional() })
          .optional(),
      })
      .strict()
      .parse(req.body);
    return context.bookmarks.finish(req.params.id, source, runId, changes);
  });
  app.post("/api/v2/cron/tasks", (req) => {
    const source = sourceIdentity(req.auth, "cron");
    const input = taskCatalogSchema.parse(req.body);
    for (const task of input.tasks)
      store.put("task", {
        ...store.get("task", `${source}:${task.id}`),
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
