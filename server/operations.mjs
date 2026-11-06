import { randomUUID } from "node:crypto";
import { Problem, errorMessage } from "./errors.mjs";
import { canonical } from "./canonical.mjs";

export class Operations {
  constructor(store) {
    this.store = store;
    this.handlers = new Map();
    this.running = false;
    this.closed = false;
  }
  register(kind, handler) {
    this.handlers.set(kind, handler);
  }
  start(kind, input) {
    const { requestId, ...args } = input;
    if (!requestId)
      throw new Problem(400, "需要 requestId，重交请沿用同一标识");
    const encoded = canonical(args);
    return this.store.transaction(() => {
      const old = this.store.db
        .prepare("SELECT * FROM requests WHERE scope=? AND request_id=?")
        .get(kind, requestId);
      if (old) {
        if (old.input !== encoded)
          throw new Problem(
            409,
            "同一 requestId 的操作范围已改变",
            undefined,
            "scope_changed",
          );
        return this.store.require("operation", JSON.parse(old.result).id);
      }
      const op = this.store.put("operation", {
        id: randomUUID(),
        kind,
        input: args,
        state: "queued",
        stage: "等待执行",
        createdAt: new Date().toISOString(),
      });
      this.store.db
        .prepare("INSERT INTO requests VALUES(?,?,?,?)")
        .run(kind, requestId, encoded, JSON.stringify({ id: op.id }));
      return op;
    });
  }
  update(id, changes) {
    const old = this.store.require("operation", id);
    return this.store.put("operation", {
      ...old,
      ...changes,
      version: old.version + 1,
    });
  }
  recover() {
    for (const op of this.store
      .list("operation")
      .filter(
        (o) =>
          o.state === "waiting" &&
          (o.kind === "maintain" ||
            (o.kind === "apply" && o.stage === "执行结果未确认")),
      ))
      this.update(op.id, {
        state: "queued",
        stage:
          op.kind === "apply"
            ? "先回读网关，核对未确认的应用结果"
            : "继续扫描与编排；已启动验证只回收结果",
        reason: null,
      });
    for (const op of this.store
      .list("operation")
      .filter((o) => o.state === "running"))
      this.update(
        op.id,
        ["scan", "sync", "check", "preview", "maintain", "apply"].includes(
          op.kind,
        )
          ? {
              state: "queued",
              stage:
                op.kind === "apply"
                  ? "先回读网关，核对未确认的应用结果"
                  : "服务重启，继续读取",
            }
          : {
              state: "waiting",
              stage: "执行结果未确认",
              reason:
                "服务在执行期间重启，请核对实际任务或网关结果后继续；不会重复发起调用",
            },
      );
  }
  async drain() {
    if (this.running || this.closed) return;
    this.running = true;
    try {
      while (!this.closed) {
        const op = this.store
          .list("operation")
          .find((o) => o.state === "queued");
        if (!op) break;
        this.update(op.id, {
          state: "running",
          startedAt: new Date().toISOString(),
        });
        try {
          const handler = this.handlers.get(op.kind);
          if (!handler) throw new Problem(400, "此操作类型尚未开放");
          const result = await handler(
            op.input,
            (changes) => this.update(op.id, changes),
            op.id,
          );
          if (this.store.require("operation", op.id).state === "running")
            this.update(op.id, {
              state: "succeeded",
              stage: "已完成",
              result,
              finishedAt: new Date().toISOString(),
            });
        } catch (error) {
          this.update(op.id, {
            state: "failed",
            reason: errorMessage(error),
            code: error.code || "operation_failed",
            ...(error.details?.partialResult
              ? { result: error.details.partialResult }
              : {}),
            finishedAt: new Date().toISOString(),
          });
        }
      }
    } finally {
      this.running = false;
    }
  }
  async stop() {
    this.closed = true;
    while (this.running) await new Promise((r) => setTimeout(r, 50));
  }
}
