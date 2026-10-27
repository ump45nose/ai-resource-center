// Separate inference adapter: the resource-center process stays out of the call path.
import Fastify from "fastify";
import { DatabaseSync } from "node:sqlite";
import {
  randomBytes,
  randomUUID,
  createHash,
  createHmac,
  timingSafeEqual,
} from "node:crypto";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { nativeInput } from "./native.mjs";

const terminal = new Set(["succeeded", "failed", "uncertain"]);
const digest = (value) => createHash("sha256").update(value).digest("hex");
const equal = (a, b) =>
  typeof a === "string" &&
  typeof b === "string" &&
  timingSafeEqual(Buffer.from(digest(a)), Buffer.from(digest(b)));
const publicTask = (j) => ({
  id: j.id,
  provider: j.provider,
  status: j.state,
  upstreamTaskId: j.remote_id || null,
  created: Math.floor(j.created / 1000),
  ...(j.result ? { data: JSON.parse(j.result) } : {}),
  ...(j.error ? { error: j.error } : {}),
});

export function loadConfig(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = resolve(dir, "config.json");
  if (!existsSync(path)) {
    const key = () => randomBytes(32).toString("hex");
    writeFileSync(
      path,
      JSON.stringify(
        {
          workerKey: key(),
          providers: {
            oaichat: {
              apiKey: key(),
              userId: "5854",
              models: ["gpt-image-2.5"],
            },
            wanzij: {
              apiKey: key(),
              userId: "9d1b5da465c4",
              models: ["grok-imagine-image-2.0"],
            },
          },
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
  }
  return JSON.parse(readFileSync(path, "utf8"));
}

export function createImageBridge({ dir, config = loadConfig(dir) }) {
  const db = new DatabaseSync(resolve(dir, "tasks.sqlite"));
  db.exec(`PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY, provider TEXT NOT NULL, idem TEXT, fingerprint TEXT NOT NULL,
    input TEXT, state TEXT NOT NULL, lease TEXT, expires INTEGER, remote_id TEXT,
    result TEXT, error TEXT, created INTEGER NOT NULL, updated INTEGER NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS job_idem ON jobs(provider,idem) WHERE idem IS NOT NULL;`);
  if (!db.prepare("PRAGMA table_info(jobs)").all().some(c => c.name === "user_id")) {
    db.exec("ALTER TABLE jobs ADD COLUMN user_id TEXT");
    db.exec("UPDATE jobs SET state='failed',input=NULL,error='任务账号未绑定，请重新确认后提交' WHERE state IN ('queued','leased','submitting','running')");
  }
  const app = Fastify({
    logger: false,
    bodyLimit: 32 * 1024 * 1024,
    requestTimeout: 0,
  });
  const get = (id) => db.prepare("SELECT * FROM jobs WHERE id=?").get(id);
  const fail = (status, message) =>
    Object.assign(new Error(message), { statusCode: status });
  let lastWorkerAt = 0;
  const imageSignature = (provider, id) =>
    createHmac("sha256", config.providers[provider].apiKey)
      .update(id)
      .digest("hex");
  const sweep = () => {
    const now = Date.now();
    db.prepare(
      "UPDATE jobs SET state='uncertain',input=NULL,error='提交回执未确认，请先核对原站任务，系统不会重复提交',updated=? WHERE state='submitting' AND expires<? AND remote_id IS NULL",
    ).run(now, now);
    db.prepare(
      "UPDATE jobs SET state='failed',input=NULL,error='任务等待超过 30 分钟',updated=? WHERE state IN ('queued','leased','running') AND created<?",
    ).run(now, now - 30 * 60000);
    db.prepare(
      "DELETE FROM jobs WHERE updated<? AND state IN ('succeeded','failed','uncertain')",
    ).run(now - 24 * 3600000);
  };
  app.setErrorHandler((e, _req, reply) =>
    reply.code(e.statusCode || 500).send({
      error: {
        type: "browser_image_error",
        message: e.statusCode ? e.message : "生图适配服务错误",
      },
    }),
  );
  app.addHook("preHandler", async (req) => {
    if (req.url === "/health") return;
    const key = req.headers.authorization?.replace(/^Bearer /, "");
    if (req.url.startsWith("/worker/")) {
      if (!equal(key, config.workerKey)) throw fail(401, "执行凭据无效");
      lastWorkerAt = Date.now();
      return;
    }
    const provider = req.params.provider;
    if (
      req.routeOptions.url === "/:provider/v1/files/:id/:signature" &&
      config.providers[provider] &&
      equal(req.params.signature, imageSignature(provider, req.params.id))
    )
      return;
    if (
      !config.providers[provider] ||
      !equal(key, config.providers[provider].apiKey)
    )
      throw fail(401, "渠道凭据无效");
  });
  app.get("/health", () => ({
    status: "ok",
    workerOnline: Date.now() - lastWorkerAt < 30000,
  }));
  app.get("/:provider/v1/models", (req) => ({
    object: "list",
    data: config.providers[req.params.provider].models.map((id) => ({
      id,
      object: "model",
      owned_by: req.params.provider,
    })),
  }));
  app.get("/:provider/v1/files/:id/:signature", (req, reply) => {
    sweep();
    const j = get(req.params.id);
    if (!j || j.provider !== req.params.provider || j.state !== "succeeded")
      throw fail(404, "图片已过期或不存在");
    const bytes = Buffer.from(JSON.parse(j.result)[0].b64_json, "base64");
    const mime =
      bytes[0] === 0x89
        ? "image/png"
        : bytes[0] === 0xff
          ? "image/jpeg"
          : "image/webp";
    return reply
      .header("Cache-Control", "private, max-age=3600")
      .type(mime)
      .send(bytes);
  });
  app.get("/:provider/v1/tasks/:id", (req, reply) => {
    reply.header("Cache-Control", "no-store");
    sweep();
    const j = get(req.params.id);
    if (!j || j.provider !== req.params.provider) throw fail(404, "未找到任务");
    return publicTask(j);
  });
  app.post("/:provider/v1/images/generations", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    sweep();
    const provider = req.params.provider;
    if (!config.providers[provider].models.includes(req.body?.model))
      throw fail(400, "模型尚未接入该渠道");
    let input;
    try {
      input = nativeInput(provider, req.body, randomUUID());
    } catch (e) {
      throw fail(400, e.message);
    }
    const userId = config.providers[provider].userId;
    const fingerprint = digest(JSON.stringify({ ...input, id: null, userId }));
    const idem = req.headers["idempotency-key"];
    if (idem && (typeof idem !== "string" || idem.length > 200))
      throw fail(400, "Idempotency-Key 无效");
    let job =
      idem &&
      db
        .prepare("SELECT * FROM jobs WHERE provider=? AND idem=?")
        .get(provider, idem);
    if (job && job.fingerprint !== fingerprint)
      throw fail(409, "同一幂等标识不能用于不同请求");
    if (!job) {
      if (Date.now() - lastWorkerAt >= 30000)
        throw fail(
          503,
          "浏览器执行器离线，请启动本机执行器并保持 Chrome 已登录",
        );
      if (
        db
          .prepare(
            "SELECT count(*) n FROM jobs WHERE provider=? AND state NOT IN ('succeeded','failed','uncertain')",
          )
          .get(provider).n >= 4
      )
        throw fail(429, "该站点已有 4 个任务，请稍后再试");
      const now = Date.now();
      db.prepare(
        "INSERT INTO jobs(id,provider,idem,fingerprint,input,user_id,state,created,updated) VALUES(?,?,?,?,?,?,'queued',?,?)",
      ).run(
        input.id,
        provider,
        idem || null,
        fingerprint,
        JSON.stringify(input),
        userId,
        now,
        now,
      );
      job = get(input.id);
    }
    reply.header("X-Image-Task-Id", job.id);
    const deadline = Date.now() + 10 * 60000;
    while (
      !terminal.has(job.state) &&
      Date.now() < deadline &&
      !reply.raw.destroyed
    ) {
      await new Promise((r) => setTimeout(r, 500));
      sweep();
      job = get(job.id);
    }
    if (job.state === "succeeded")
      return {
        created: Math.floor(job.created / 1000),
        data:
          input.responseFormat === "b64_json"
            ? JSON.parse(job.result)
            : [
                {
                  url: `${config.publicUrl || `http://${req.headers.host}`}/${provider}/v1/files/${job.id}/${imageSignature(provider, job.id)}`,
                },
              ],
      };
    if (terminal.has(job.state))
      return reply.code(502).send({
        error: { type: job.state, message: job.error, task_id: job.id },
      });
    return reply.code(504).send({
      error: {
        type: "task_pending",
        message: "任务仍在原站执行，请用任务标识查询，勿重新提交",
        task_id: job.id,
      },
    });
  });
  app.post("/worker/claim", (req) => {
    sweep();
    const provider = req.body?.provider;
    if (!config.providers[provider]) throw fail(400, "未知执行站点");
    // A lost POST acknowledgement is never leased for another generation.
    const current = db
      .prepare(
        "SELECT * FROM jobs WHERE provider=? AND state IN ('leased','submitting','running') ORDER BY created LIMIT 1",
      )
      .get(provider);
    if (current && current.expires > Date.now()) return { job: null };
    const job =
      current?.state === "running" && current.remote_id
        ? current
        : current?.state === "leased"
          ? current
          : db
              .prepare(
                "SELECT * FROM jobs WHERE provider=? AND state='queued' ORDER BY created LIMIT 1",
              )
              .get(provider);
    if (!job) return { job: null };
    const lease = randomUUID(),
      state = job.remote_id ? "running" : "leased";
    db.prepare(
      "UPDATE jobs SET state=?,lease=?,expires=?,updated=? WHERE id=?",
    ).run(state, lease, Date.now() + 60000, Date.now(), job.id);
    return {
      job: {
        id: job.id,
        provider,
        lease,
        userId: job.user_id,
        remoteId: job.remote_id,
        input: JSON.parse(job.input),
      },
    };
  });
  app.post("/worker/jobs/:id", (req) => {
    const job = get(req.params.id),
      body = req.body;
    if (
      !job ||
      terminal.has(job.state) ||
      !equal(body?.lease, job.lease) ||
      job.expires < Date.now()
    )
      throw fail(409, "执行租约已结束，请勿重发生成请求");
    const state = body.state;
    const allowed = {
      leased: ["submitting", "failed"],
      submitting: ["running", "uncertain", "failed"],
      running: ["running", "succeeded", "failed"],
    };
    if (!allowed[job.state]?.includes(state))
      throw fail(409, "任务状态不允许此变更");
    if (state === "running" && !(body.remoteId || job.remote_id))
      throw fail(400, "缺少原站任务标识");
    if (
      state === "succeeded" &&
      (!Array.isArray(body.data) ||
        body.data.length !== 1 ||
        !body.data.every(
          (i) => typeof i.b64_json === "string" && i.b64_json.length > 0,
        ))
    )
      throw fail(400, "未取得实际生成图片");
    db.prepare(
      "UPDATE jobs SET state=?,remote_id=?,result=?,error=?,input=?,expires=?,updated=? WHERE id=?",
    ).run(
      state,
      body.remoteId || job.remote_id,
      body.data ? JSON.stringify(body.data) : null,
      body.error ? String(body.error).slice(0, 500) : null,
      terminal.has(state) ? null : job.input,
      Date.now() + 60000,
      Date.now(),
      job.id,
    );
    return { accepted: true };
  });
  app.addHook("onClose", async () => db.close());
  return app;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const app = createImageBridge({
    dir: process.env.IMAGE_BRIDGE_DATA || "./outputs/browser-images-runtime",
  });
  await app.listen({
    host: process.env.HOST || "127.0.0.1",
    port: Number(process.env.PORT || 18324),
  });
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, () => app.close());
}
