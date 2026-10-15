import Fastify from "fastify";
import cookie from "@fastify/cookie";
import staticFiles from "@fastify/static";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { z } from "zod";
import { Store, hash } from "./store.mjs";
import { Center, Problem } from "./center.mjs";
import { Gateways } from "./gateways.mjs";
import { rulesSchema, dayKey, nextReset } from "./domain.mjs";
import { parseFile, rowSchema } from "./imports.mjs";
import { clientConfig } from "./exports.mjs";
import { callReport } from "./calls.mjs";

export async function createApp({
  dir,
  fetcher,
  serveWeb = true,
  password,
} = {}) {
  const store = new Store(dir),
    center = new Center(store),
    gateways = new Gateways(center, fetcher),
    app = Fastify({ bodyLimit: 16 * 1024 * 1024, logger: false });
  const bootstrap = join(dir, "admin-password");
  if (!store.setting("password")) {
    const pass = password || randomBytes(24).toString("base64url"),
      salt = randomBytes(16).toString("hex");
    store.setting("password", {
      salt,
      digest: scryptSync(pass, salt, 32).toString("hex"),
    });
    writeFileSync(bootstrap, pass, { mode: 0o600 });
  }
  await app.register(cookie);
  app.setErrorHandler((error, req, reply) => {
    const status = error instanceof z.ZodError ? 400 : error.statusCode || 500;
    reply.code(status).send({
      error: status === 500 ? "服务器处理失败，请检查服务日志" : error.message,
      ...(error.detail ? { detail: error.detail } : {}),
    });
    if (status === 500) process.stderr.write(`${error.stack}\n`);
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
    ) {
      reply
        .header("Access-Control-Allow-Origin", origin)
        .header("Vary", "Origin")
        .header("Access-Control-Allow-Headers", "Authorization,Content-Type")
        .header("Access-Control-Allow-Methods", "GET,POST,PATCH,OPTIONS");
    }
    if (req.method === "OPTIONS") return reply.code(204).send();
  });
  app.addHook("preHandler", async (req, reply) => {
    if (
      !req.url.startsWith("/api/") ||
      req.url === "/api/health" ||
      (req.url === "/api/v1/session" && req.method === "POST")
    )
      return;
    const bearer = req.headers.authorization?.replace(/^Bearer /, ""),
      raw = bearer || req.cookies.arc_session;
    const auth =
      raw &&
      store.db.prepare("SELECT * FROM auth WHERE token_hash=?").get(hash(raw));
    if (!auth || (auth.expires_at && auth.expires_at < Date.now()))
      throw new Problem(401, "请登录管理中心");
    req.centerAuth = { role: auth.role, scope: JSON.parse(auth.scope) };
    const allowed =
      auth.role === "admin" ||
      (auth.role === "ingest" &&
        req.url === "/api/v1/ingest" &&
        req.method === "POST") ||
      (auth.role === "rp" && req.url.startsWith("/api/v1/rp/"));
    if (!allowed) throw new Problem(403, "凭据没有该操作权限");
    if (
      auth.role === "admin" &&
      !bearer &&
      !["GET", "HEAD"].includes(req.method) &&
      req.headers.origin &&
      new URL(req.headers.origin).host !== req.headers.host
    )
      throw new Problem(403, "管理会话来源不一致");
  });
  app.get("/api/health", async () => ({ status: "ok" }));
  app.get("/api/v1/calls", async (req) => callReport(store, req.query));
  app.post("/api/v1/session", async (req, reply) => {
    const { password } = z.object({ password: z.string() }).parse(req.body),
      p = store.setting("password");
    if (
      !timingSafeEqual(
        scryptSync(password, p.salt, 32),
        Buffer.from(p.digest, "hex"),
      )
    )
      throw new Problem(401, "登录凭据不正确");
    const token = randomBytes(32).toString("base64url");
    store.db
      .prepare("INSERT INTO auth VALUES(?,?,?,?)")
      .run(hash(token), "admin", "{}", Date.now() + 8 * 3600000);
    reply.setCookie("arc_session", token, {
      httpOnly: true,
      sameSite: "strict",
      path: "/",
      maxAge: 8 * 3600,
      secure: req.protocol === "https",
    });
    return { authenticated: true };
  });
  app.delete("/api/v1/session", async (req, reply) => {
    if (req.cookies.arc_session)
      store.db
        .prepare("DELETE FROM auth WHERE token_hash=?")
        .run(hash(req.cookies.arc_session));
    reply.clearCookie("arc_session", { path: "/" });
    return { authenticated: false };
  });
  app.get("/api/v1/state", async () => center.state());
  app.get("/api/v1/overview", async () => {
    const s = center.state();
    return {
      today: s.today,
      accounts: s.accounts,
      channels: s.channels,
      received: s.received,
    };
  });
  app.get("/api/v1/sites", async (req) => {
    const s = center.state();
    return s.sites
      .filter(
        (x) => !req.query.q || [x.name, x.url].join(" ").includes(req.query.q),
      )
      .map((x) => ({
        ...x,
        accounts: s.accounts.filter((a) => a.siteId === x.id),
        channels: s.channels.filter((c) => c.siteId === x.id),
      }));
  });
  app.patch("/api/v1/sites/:id", async (req) => {
    const p = z
      .object({
        name: z.string().min(1).optional(),
        url: z.url().optional(),
        checkinUrl: z.url().nullable().optional(),
        aliases: z.array(z.url()).optional(),
        siteDown: z.boolean().optional(),
        issue: z.string().nullable().optional(),
      })
      .parse(req.body);
    const s = store.get("site", req.params.id);
    if (!s) throw new Problem(404, "站点不存在");
    return store.put("site", { ...s, ...p, version: s.version + 1 });
  });
  app.post("/api/v1/channels", async (req) => center.createChannel(req.body));
  app.post("/api/v1/channels/:id/connect-gateway", async (req) => {
    const { sourceId } = z.object({ sourceId: z.string() }).parse(req.body);
    return gateways.connect(req.params.id, sourceId);
  });
  app.patch("/api/v1/channels/:id", async (req) => {
    const { expectedVersion, patch } = z
      .object({
        expectedVersion: z.number().int(),
        patch: z.record(z.string(), z.unknown()),
      })
      .parse(req.body);
    return store.transaction(() =>
      center.patchChannel(req.params.id, expectedVersion, patch),
    );
  });
  app.post("/api/v1/channels/reorder", async (req) => {
    const { ids } = z.object({ ids: z.array(z.string()) }).parse(req.body);
    return store.transaction(() =>
      ids.map((id, i) => {
        const c = store.get("channel", id);
        if (!c || c.category !== "rp")
          throw new Problem(400, "只能排列 RP 连接");
        return center.patchChannel(id, c.version, { order: i + 1 });
      }),
    );
  });
  app.post("/api/v1/channels/:id/apply", async (req) =>
    gateways.apply(req.params.id, req.body || {}),
  );
  app.post("/api/v1/channels/:id/adopt", async (req) =>
    gateways.adopt(req.params.id),
  );
  app.post("/api/v1/channels/:id/resolve", async (req) => {
    const { choice } = z
        .object({ choice: z.enum(["center", "external"]) })
        .parse(req.body),
      c = store.get("channel", req.params.id);
    if (!c?.external) throw new Problem(400, "当前没有冲突");
    if (c.category !== "rp")
      return choice === "external"
        ? gateways.adopt(c.id)
        : gateways.apply(c.id, { force: true });
    const patch = choice === "external" ? c.external : {};
    const { version, ...fields } = patch;
    const result = store.transaction(() =>
      center.patchChannel(c.id, c.version, fields),
    );
    store.put("channel", {
      ...store.get("channel", c.id),
      external: undefined,
      apply: "pending",
      applyMsg: "冲突已处理，等待酒馆确认保存",
    });
    return result;
  });
  app.get("/api/v1/rp/:id/config", async (req) => {
    if (
      req.centerAuth.role === "rp" &&
      !req.centerAuth.scope.channelIds.includes(req.params.id)
    )
      throw new Problem(403, "RP 连接未授权");
    const c = store.get("channel", req.params.id);
    if (c?.category !== "rp") throw new Problem(400, "仅提供 RP 配置");
    return { ...center.publicChannel(c), key: store.reveal(c.credentialId) };
  });
  app.post("/api/v1/channels/:id/clear-issue", async (req) => {
    const c = store.get("channel", req.params.id);
    return store.put("channel", {
      ...c,
      availability: undefined,
      callIssue: undefined,
      version: c.version + 1,
    });
  });
  app.post("/api/v1/accounts/:id/merge", async (req) => {
    const { targetId } = z.object({ targetId: z.string() }).parse(req.body);
    return store.transaction(() => {
      const a = store.get("account", req.params.id),
        target = store.get("account", targetId);
      if (!a || !target || a.id === target.id || a.siteId !== target.siteId)
        throw new Problem(400, "只能关联同一站点的两个不同账号");
      const latest =
        a.confirmedAt > target.confirmedAt && a.balance !== null ? a : target;
      const rules =
        a.ruleConfirmedAt &&
        (!target.ruleConfirmedAt || a.ruleConfirmedAt > target.ruleConfirmedAt)
          ? a
          : target;
      store.put("account", {
        ...target,
        balance: latest.balance,
        unit: latest.unit,
        confirmedAt: latest.confirmedAt,
        status: latest.status,
        benefit: rules.benefit,
        quota: rules.quota,
        validUntil: rules.validUntil,
        version: target.version + 1,
      });
      for (const c of store.list("channel").filter((c) => c.accountId === a.id))
        store.put("channel", {
          ...c,
          accountId: target.id,
          version: c.version + 1,
        });
      store.db
        .prepare("UPDATE refs SET id=? WHERE kind=? AND id=?")
        .run(target.id, "account", a.id);
      store.db
        .prepare("UPDATE events SET account_id=? WHERE account_id=?")
        .run(target.id, a.id);
      store.db
        .prepare("DELETE FROM entities WHERE kind=? AND id=?")
        .run("account", a.id);
      store.action(target.id, { result: "account_associated", before: a });
      return { accountId: target.id };
    });
  });
  app.patch("/api/v1/accounts/:id", async (req) => {
    const { expectedVersion, patch } = z
      .object({
        expectedVersion: z.number(),
        patch: z.object({
          benefit: z.object({
            pool: z.enum(["daily", "long"]),
            validity: z.string(),
            tz: z.string(),
            threshold: z.string(),
            drops: z.string(),
            window: z.string(),
            resetAt: z
              .string()
              .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
              .optional(),
            checkinSupported: z.boolean().nullable().optional(),
            ruleText: z.string().optional(),
            windows: z
              .array(
                z.object({
                  start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
                  end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
                }),
              )
              .optional(),
          }),
          validUntil: z.iso.datetime().nullable().optional(),
        }),
      })
      .parse(req.body);
    const a = store.get("account", req.params.id);
    if (a.version !== expectedVersion)
      throw new Problem(409, "权益已被修改，请重新加载");
    if (patch.benefit.windows?.length && !patch.benefit.tz)
      throw new Problem(400, "可用窗口必须填写已确认的时区");
    if (patch.benefit.tz)
      new Intl.DateTimeFormat("en-CA", { timeZone: patch.benefit.tz });
    if (
      patch.benefit.pool === "daily" &&
      patch.benefit.tz &&
      patch.benefit.resetAt &&
      a.balance !== null
    )
      patch.validUntil = nextReset(
        a.confirmedAt === "—" ? new Date() : a.confirmedAt,
        patch.benefit.tz,
        patch.benefit.resetAt,
      );
    const result = store.put("account", {
      ...a,
      ...patch,
      quota: patch.benefit.pool,
      version: a.version + 1,
      ruleConfirmedAt: new Date().toISOString(),
    });
    await gateways.recalculateAndApply();
    return result;
  });
  app.post("/api/v1/accounts/:id/checkins", async (req) => {
    const a = store.get("account", req.params.id),
      s = store.get("site", a.siteId),
      p = z
        .object({
          result: z.enum([
            "成功",
            "已签到",
            "失败",
            "待确认",
            "需登录",
            "需人工操作",
            "无法签到",
          ]),
          reward: z.string().optional(),
          reason: z.string().optional(),
        })
        .parse(req.body);
    store.ref("manual", "account", a.id, a.id);
    return center.ingest("manual", [
      {
        eventId: randomBytes(16).toString("hex"),
        kind: "checkin",
        accountId: a.id,
        name: a.name,
        site: { name: s.name, url: s.url },
        occurredAt: new Date().toISOString(),
        businessDate: dayKey(new Date(), a.benefit.tz || "Asia/Shanghai"),
        method: "人工登记",
        ...p,
      },
    ]);
  });
  app.post("/api/v1/ingest", async (req) => {
    const { events } = z
      .object({ events: z.array(z.unknown()).max(200) })
      .parse(req.body);
    const result = center.ingest(
      req.centerAuth.scope.source || "all-api-hub",
      events,
    );
    await gateways.recalculateAndApply();
    return result;
  });
  app.get("/api/v1/actions", async () =>
    store.db
      .prepare("SELECT * FROM actions ORDER BY occurred_at DESC LIMIT 50")
      .all()
      .map((x) => ({ ...x, data: JSON.parse(x.data) })),
  );
  app.patch("/api/v1/settings", async (req) => {
    const p = z
      .object({ rules: rulesSchema.optional(), tmUrl: z.string().optional() })
      .parse(req.body);
    for (const [key, v] of Object.entries(p)) store.setting(key, v);
    if (p.rules) await gateways.recalculateAndApply();
    return p;
  });
  app.post("/api/v1/access-tokens", async (req) => {
    const p = z
      .object({
        role: z.enum(["ingest", "rp"]),
        channelIds: z.array(z.string()).optional(),
      })
      .parse(req.body);
    if (
      p.role === "rp" &&
      (!p.channelIds?.length ||
        p.channelIds.some((id) => store.get("channel", id)?.category !== "rp"))
    )
      throw new Problem(400, "请限定 RP 连接");
    const token = randomBytes(32).toString("base64url");
    store.db
      .prepare("INSERT INTO auth VALUES(?,?,?,NULL)")
      .run(
        hash(token),
        p.role,
        JSON.stringify(
          p.role === "ingest"
            ? { source: "all-api-hub" }
            : { channelIds: p.channelIds },
        ),
      );
    return { token, role: p.role };
  });
  app.post("/api/v1/sources", async (req) => {
    const p = z
        .object({
          id: z.string().min(1),
          name: z.string().min(1),
          kind: z.enum(["newapi", "cpa", "sillytavern"]),
          inferenceUrl: z.url().optional(),
          url: z.url(),
          userId: z.number().int().optional(),
          key: z.string().optional(),
        })
        .parse(req.body),
      sources = store.setting("sources") || [],
      old = sources.find((s) => s.id === p.id);
    const { key, ...input } = p;
    const s = {
      ...old,
      ...input,
      ...(key ? { credentialId: store.secret(key, old?.credentialId) } : {}),
    };
    store.setting("sources", [...sources.filter((x) => x.id !== s.id), s]);
    return { id: s.id };
  });
  app.post("/api/v1/sources/:id/sync", async (req) =>
    gateways.sync(req.params.id),
  );
  app.post("/api/v1/imports/preview", async (req) => {
    const p = z
      .object({
        source: z.string(),
        file: z.object({ name: z.string(), content: z.string() }).optional(),
        rows: z.array(rowSchema).optional(),
        sourceId: z.string().optional(),
      })
      .parse(req.body);
    const rows = p.file
      ? await parseFile(p.file)
      : p.sourceId
        ? (await gateways.inventory(p.sourceId)).rows
        : p.rows || [];
    const importId = randomBytes(16).toString("hex");
    store.setting(`import:${importId}`, {
      rows: rows.map((r) => {
        const { key, ...rest } = r;
        return {
          ...rest,
          ...(key ? { importCredential: store.secret(key) } : {}),
        };
      }),
      source: p.source,
      createdAt: Date.now(),
    });
    return { importId, rows: center.importPreview(rows, p.source) };
  });
  app.get("/api/v1/imports/:id", async (req) => {
    const p = store.setting(`import:${req.params.id}`);
    if (!p) throw new Problem(404, "导入记录不存在");
    const rows = p.rows.map(({ importCredential, ...r }) => ({
      ...r,
      ...(importCredential ? { key: store.reveal(importCredential) } : {}),
    }));
    return {
      importId: req.params.id,
      rows: center
        .importPreview(rows, p.source)
        .filter((r) => !(p.committed || []).includes(r.index)),
    };
  });
  app.post("/api/v1/imports/:id/commit", async (req) => {
    const p = z
        .object({
          selections: z.array(
            z.object({
              index: z.number().int().min(0),
              channelId: z.string().optional(),
              category: z.string().optional(),
            }),
          ),
        })
        .parse(req.body),
      preview = store.setting(`import:${req.params.id}`);
    if (!preview) throw new Problem(410, "导入预览已过期，请重新读取");
    const rows = preview.rows.map(({ importCredential, ...r }) => ({
      ...r,
      ...(importCredential ? { key: store.reveal(importCredential) } : {}),
    }));
    const ids = center.importRows(rows, preview.source, p.selections);
    store.setting(`import:${req.params.id}`, {
      ...preview,
      committed: [
        ...new Set([
          ...(preview.committed || []),
          ...p.selections.map((x) => x.index),
        ]),
      ],
    });
    return { ids };
  });
  async function exported(c, client, model, identity, prepared) {
    if (
      c.category !== "rp" &&
      !c.gateway &&
      !(c.category === "client" && c.gatewayAllowed === false)
    )
      throw new Problem(400, "请先接入 fn 网关，再生成应用配置");
    if (c.category === "rp" && client !== "SillyTavern")
      throw new Problem(400, "RP 连接由酒馆独占");
    if (c.category === "client" && client !== c.client && client !== "Magpie")
      throw new Problem(400, "该连接限制指定客户端");
    let key = store.reveal(c.credentialId),
      connection = c;
    if (c.gateway && c.category !== "rp") {
      if (
        c.category === "client" &&
        (!c.nativePassthrough || c.apply !== "synced")
      )
        throw new Problem(400, "请先应用客户端原生透传配置");
      const token =
        prepared || (await gateways.inferenceToken(c, identity || client));
      key = token.key;
      const source = gateways.source(c.gateway.sourceId);
      connection = {
        ...c,
        authType: "bearer",
        protocol:
          c.category === "client"
            ? c.protocol
            : client === "Claude Code"
              ? "Anthropic"
              : client === "Codex"
                ? "OpenAI Responses"
                : c.protocol === "Anthropic"
                  ? "Anthropic"
                  : "OpenAI",
        baseUrl:
          client === "Claude Code" || c.protocol === "Anthropic"
            ? token.baseUrl.replace(/\/v1\/?$/, "")
            : token.baseUrl,
      };
    }
    if (!key) throw new Problem(400, "缺少推理 key，请补充凭据");
    return clientConfig(connection, client, key, model);
  }
  app.post("/api/v1/exports", async (req) => {
    const p = z
        .object({
          channelId: z.string(),
          client: z.string(),
          model: z.string().optional(),
          application: z.string().optional(),
        })
        .parse(req.body),
      c = store.get("channel", p.channelId);
    if (!c) throw new Problem(404, "渠道不存在");
    const content = await exported(c, p.client, p.model, p.application);
    if (c.category === "client")
      store.put("channel", {
        ...c,
        clientState: "awaiting",
        applyMsg: "配置已生成，待客户端真实任务确认",
      });
    return { content };
  });
  app.post("/api/v1/channels/:id/verify", async (req) => {
    const c = store.get("channel", req.params.id),
      p = z.object({ summary: z.string().min(1) }).parse(req.body);
    if (c.category !== "client") throw new Problem(400, "仅登记客户端绑定结果");
    store.action(c.id, {
      result: "client_verified",
      summary: p.summary,
      source: "人工确认",
    });
    return store.put("channel", {
      ...c,
      clientState: "verified",
      clientVerifiedAt: new Date().toISOString(),
      applyMsg: "人工确认真实任务成功",
    });
  });
  app.post("/api/v1/identities/:id/verify", async (req) => {
    const { summary } = z
        .object({ summary: z.string().min(1) })
        .parse(req.body),
      identity = store.get("identity", req.params.id);
    if (!identity) throw new Problem(404, "配置身份不存在");
    store.action(identity.channelId, {
      result: "client_verified",
      application: identity.application,
      summary,
      source: "人工确认",
    });
    return store.put("identity", {
      ...identity,
      state: "verified",
      verifiedAt: new Date().toISOString(),
    });
  });
  app.post("/api/v1/evaluations", async (req) => {
    const p = z
        .object({
          channelId: z.string(),
          model: z.string(),
          client: z.string(),
          title: z.string().min(1),
        })
        .parse(req.body),
      c = store.get("channel", p.channelId);
    if (!c || !c.models.includes(p.model))
      throw new Problem(400, "请选择渠道的已保存模型");
    if (c.category === "rp") throw new Problem(400, "RP 禁止任务测活");
    if (!c.gateway) throw new Problem(400, "请先接入 fn 网关，再准备评估配置");
    let token;
    if (c.gateway) {
      const source = gateways.source(c.gateway.sourceId);
      if (source.kind !== "newapi" || source.version !== "v1.0.0-rc.44")
        throw new Problem(400, "未确认网关固定渠道能力，无法准备评估");
      token = await gateways.inferenceToken(
        { ...c, models: [p.model] },
        `evaluation:${randomBytes(16).toString("hex")}`,
        Math.floor(Date.now() / 1000) + 86400,
        true,
      );
    }
    const e = store.put("evaluation", {
      ...p,
      id: randomBytes(16).toString("hex"),
      state: "prepared",
      summary: "",
      rating: "",
      preparedAt: new Date().toISOString(),
      tokenId: token?.tokenId,
      sourceId: c.gateway?.sourceId,
      records: 0,
    });
    try {
      return {
        evaluation: e,
        content: await exported(c, p.client, p.model, null, token),
      };
    } catch (error) {
      if (token) await gateways.endEvaluation(e);
      throw error;
    }
  });
  app.patch("/api/v1/evaluations/:id", async (req) => {
    const p = z
        .object({
          state: z.enum(["started", "ended"]),
          summary: z.string().optional(),
          rating: z.enum(["", "优", "良", "差"]).optional(),
        })
        .parse(req.body),
      e = store.get("evaluation", req.params.id);
    if (!e) throw new Problem(404, "评估不存在");
    if (p.state === "ended") await gateways.endEvaluation(e);
    const count = e.tokenId
      ? store.db
          .prepare(
            "SELECT COUNT(*) n FROM calls WHERE token_id=? AND channel_id=?",
          )
          .get(String(e.tokenId), e.channelId).n
      : 0;
    const result = store.put("evaluation", {
      ...e,
      ...p,
      ...(p.state === "started"
        ? { startedAt: new Date().toISOString() }
        : { endedAt: new Date().toISOString() }),
      records: count,
    });
    if (p.rating) {
      const c = store.get("channel", e.channelId);
      store.put("channel", { ...c, rating: p.rating });
    }
    await gateways.recalculateAndApply();
    return result;
  });
  app.get("/api/v1/rp/connections", async (req) => {
    const ids =
      req.centerAuth.role === "admin"
        ? store
            .list("channel")
            .filter((c) => c.category === "rp")
            .map((c) => c.id)
        : req.centerAuth.scope.channelIds;
    return ids.map((id) => center.publicChannel(store.get("channel", id)));
  });
  app.post("/api/v1/rp/:id/saved", async (req) => {
    if (
      req.centerAuth.role === "rp" &&
      !req.centerAuth.scope.channelIds.includes(req.params.id)
    )
      throw new Problem(403, "RP 连接未授权");
    const p = z
      .object({
        eventId: z.string().min(1),
        expectedVersion: z.number(),
        patch: z.object({
          name: z.string().optional(),
          baseUrl: z.url(),
          protocol: z.enum([
            "OpenAI",
            "OpenAI Responses",
            "Anthropic",
            "Gemini",
          ]),
          models: z.array(z.string()),
        }),
        profileId: z.string(),
        device: z.string(),
        current: z.boolean().optional(),
      })
      .parse(req.body);
    const old = store.get("channel", req.params.id);
    const eventId = `sillytavern:${p.eventId}`;
    const delivered = store.db
      .prepare("SELECT data FROM events WHERE id=?")
      .get(eventId);
    if (delivered) return JSON.parse(delivered.data);
    if (old.version !== p.expectedVersion) {
      store.put("channel", {
        ...old,
        apply: "conflict",
        external: p.patch,
        applyMsg: "酒馆已保存的连接与中心版本冲突",
      });
      throw new Problem(409, "酒馆已保存内容保留，请选择两侧配置", {
        current: center.publicChannel(old),
        external: p.patch,
      });
    }
    if (old.category !== "rp") throw new Problem(400, "仅同步 RP 连接");
    return store.transaction(() => {
      const c = center.patchChannel(old.id, p.expectedVersion, p.patch);
      store.put("channel", {
        ...store.get("channel", c.id),
        apply: "synced",
        applyMsg: "酒馆原生保存已确认",
        tavern: {
          profileId: p.profileId,
          device: p.device,
          current: p.current,
          lastSavedAt: new Date().toISOString(),
        },
      });
      store.setting("received:sillytavern", new Date().toISOString());
      const response = {
        acceptedVersion: c.version,
        current: center.publicChannel(store.get("channel", c.id)),
      };
      store.db
        .prepare("INSERT INTO events VALUES(?,?,?,?,?)")
        .run(
          eventId,
          c.accountId,
          new Date().toISOString(),
          dayKey(new Date()),
          JSON.stringify(response),
        );
      return response;
    });
  });
  app.addHook("onClose", async () => store.close());
  if (serveWeb && existsSync(resolve("dist"))) {
    await app.register(staticFiles, { root: resolve("dist") });
    app.setNotFoundHandler((req, reply) =>
      req.url.startsWith("/api/")
        ? reply.code(404).send({ error: "接口不存在" })
        : reply.sendFile("index.html"),
    );
  }
  return { app, store, center, gateways };
}
