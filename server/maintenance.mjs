import {
  autoManaged,
  autoScope,
  reviewManaged,
} from "./maintenance-policy.mjs";
import { policies, maintenanceStatus } from "./maintenance-policy.mjs";
import { gatewayBlock, taskBlock, tagsOf } from "./channel-rules.mjs";
import { dayKey } from "./domain.mjs";

export class Maintenance {
  constructor(store, scans, operations, gateway) {
    Object.assign(this, { store, scans, operations, gateway });
  }
  pilotVerified(offering, verification) {
    const pilot = this.store.setting("automationPilot");
    if (
      !pilot ||
      pilot.state !== "waiting" ||
      !policies(this.store).enabled ||
      offering.channelId !== pilot.channelId ||
      offering.modelId !== pilot.modelId ||
      verification.method !== "cron" ||
      verification.executionMode !== "preview" ||
      verification.result !== "success" ||
      verification.quality !== "passed"
    )
      return;
    const run = this.store.get("run", verification.runId);
    if (
      !run ||
      run.taskId !== pilot.taskRef.id ||
      run.source !== pilot.taskRef.source
    )
      return;
    this.store.setting("maintenancePolicy", {
      ...policies(this.store),
      autoApply: true,
    });
    this.store.setting("automationPilot", {
      ...pilot,
      state: "applying",
      runId: run.id,
    });
  }
  pilotApplied(job) {
    const pilot = this.store.setting("automationPilot"),
      p = policies(this.store);
    if (
      !pilot ||
      pilot.state !== "applying" ||
      !p.enabled ||
      !p.autoApply ||
      job.target !== "newapi" ||
      job.subject !== pilot.channelId ||
      !job.payload.models.includes(pilot.modelId)
    )
      return;
    this.store.transaction(() => {
      for (const c of this.store
        .list("channel")
        .filter((c) => autoScope(this.store, c)))
        this.store.put("channel", {
          ...c,
          mode: "auto",
          version: c.version + 1,
        });
      this.store.setting("maintenancePolicy", { ...p, smokeEnabled: true });
      this.store.setting("automationPilot", {
        ...pilot,
        state: "completed",
        appliedAt: new Date().toISOString(),
      });
    });
  }
  budget() {
    const today = dayKey(new Date()),
      p = policies(this.store);
    const reservations = new Set(
      this.store
        .list("operation")
        .filter(
          (o) =>
            o.kind === "evaluate" &&
            dayKey(o.executionStartedAt || o.startedAt || o.createdAt) ===
              today &&
            o.state !== "cancelled",
        )
        .map((o) => `operation:${o.id}`),
    );
    for (const run of this.store
      .list("run")
      .filter((r) => dayKey(r.createdAt) === today))
      reservations.add(
        run.operationId ? `operation:${run.operationId}` : `run:${run.id}`,
      );
    const used = reservations.size;
    return {
      date: today,
      used,
      limit: p.maxEvaluationsPerDay,
      remaining: Math.max(0, p.maxEvaluationsPerDay - used),
    };
  }
  taskFor(c, modelId) {
    for (const b of this.store
      .list("binding")
      .filter(
        (b) =>
          b.enabled &&
          b.channelId === c.id &&
          (!modelId || b.modelId === modelId || b.discoverNewModels),
      )) {
      const task = this.store
        .list("task")
        .find(
          (t) => t.source === b.taskRef.source && t.externalId === b.taskRef.id,
        );
      if (
        task?.enabled &&
        task.supportsRunConfig &&
        task.supportsResult &&
        !taskBlock(c, task)
      )
        return b;
    }
    return null;
  }
  status(c, options) {
    const status = maintenanceStatus(this.store, c, options);
    let validationBlocked =
      status.waitingFor || status.validationWaitingFor || gatewayBlock(c);
    if (
      !validationBlocked &&
      c.catalogObservation &&
      c.catalogObservation.status !== "ok"
    )
      validationBlocked = "模型目录检查未通过，等待下次扫描";
    if (!validationBlocked && !this.taskFor(c)) {
      if (tagsOf(c).includes("client_restricted") || c.protocol !== "OpenAI")
        validationBlocked = "等待对应客户端任务适配";
      else if (!policies(this.store).smokeEnabled)
        validationBlocked = "请绑定已适配 cron 或启用小任务";
    }
    if (!validationBlocked && !this.gateway.allowWrites)
      validationBlocked = "网关写入未开启，暂不准备验证连接";
    const automatic =
      policies(this.store).enabled && reviewManaged(this.store, c);
    return {
      ...status,
      validationBlocked,
      automatic,
      nextCheckAt: automatic ? status.nextCheckAt : null,
      automaticReason: automatic
        ? null
        : !policies(this.store).enabled
          ? "自动维护已关闭"
          : c.management?.fixed
            ? "人工固定，不自动调整"
            : c.management?.manualOnly || c.mode !== "auto"
              ? "人工管理，未安排自动检查"
              : "本批仅自动维护允许测活的通用文字渠道",
    };
  }
  summary() {
    const channels = this.store
      .list("channel")
      .filter(
        (c) =>
          !c.mergedInto && !c.sourceOnly && c.management?.state !== "removed",
      );
    const rows = channels.map((c) => ({ channelId: c.id, ...this.status(c) }));
    return {
      policy: policies(this.store),
      pilot: this.store.setting("automationPilot"),
      budget: this.budget(),
      gatewayWrites: this.gateway.allowWrites,
      tasks: {
        total: this.store.list("task").length,
        ready: this.store
          .list("task")
          .filter((t) => t.enabled && t.supportsRunConfig && t.supportsResult)
          .length,
      },
      coverage: Object.fromEntries(
        [
          "website",
          "balance",
          "invalid",
          "unstable",
          "call",
          "maintenance",
        ].map((reason) => [
          reason,
          rows
            .filter((r) => r.archiveReasons?.includes(reason))
            .map((r) => ({
              channelId: r.channelId,
              state: r.state,
              nextCheckAt: r.nextCheckAt,
              waitingFor: r.waitingFor || r.validationBlocked,
            })),
        ]),
      ),
      channels: rows,
      bindings: this.store.list("binding").map((b) => ({
        ...b,
        taskName:
          this.store
            .list("task")
            .find(
              (t) =>
                t.source === b.taskRef.source && t.externalId === b.taskRef.id,
            )?.name || b.taskRef.id,
      })),
      runs: this.store.list("run").slice(-20).reverse(),
      operations: this.store
        .list("operation")
        .filter((o) =>
          ["maintain", "scan", "evaluate", "apply"].includes(o.kind),
        )
        .slice(-30)
        .reverse()
        .map((o) => ({
          id: o.id,
          kind: o.kind,
          state: o.state,
          stage: o.stage,
          reason: o.reason,
          input: o.input,
          createdAt: o.createdAt,
          result: o.kind === "evaluate" ? o.result : undefined,
        })),
    };
  }
  queue(channelIds, cycleId) {
    const queued = [],
      waiting = [];
    let remaining = this.budget().remaining;
    for (const c of this.store
      .list("channel")
      .filter((c) => channelIds.includes(c.id))) {
      if (!autoManaged(this.store, c)) continue;
      const state = this.status(c);
      if (state.validationBlocked) {
        waiting.push({ channelId: c.id, reason: state.validationBlocked });
        continue;
      }
      if (
        c.maintenance?.validationScanAt &&
        c.maintenance.validationScanAt === c.lastScanAt &&
        c.maintenance.validationConnectionVersion === (c.connectionVersion || 1)
      )
        continue;
      const before = queued.length;
      const candidates = this.scans.candidates(c.id);
      if (!candidates.length) {
        waiting.push({
          channelId: c.id,
          reason: "暂无需要验证的认可模型；已通过模型不重复测试",
        });
        continue;
      }
      for (const o of candidates) {
        if (
          this.store
            .list("operation")
            .some(
              (op) =>
                op.kind === "evaluate" &&
                ["queued", "running", "waiting"].includes(op.state) &&
                op.input.channelId === c.id &&
                op.input.modelId === o.modelId,
            )
        )
          continue;
        if (!remaining) {
          waiting.push({ channelId: c.id, reason: "今日验证次数已用完" });
          break;
        }
        const binding = this.taskFor(c, o.modelId);
        if (
          !binding &&
          (!policies(this.store).smokeEnabled ||
            tagsOf(c).includes("client_restricted") ||
            c.protocol !== "OpenAI")
        ) {
          waiting.push({
            channelId: c.id,
            modelId: o.modelId,
            reason: "等待该模型的兼容 cron 绑定或小任务适配",
          });
          continue;
        }
        queued.push(
          this.operations.start("evaluate", {
            requestId: `maintenance:${cycleId}:${o.id}`,
            channelId: c.id,
            modelId: o.modelId,
            ...(binding
              ? {
                  taskRef: binding.taskRef,
                  bindingId: binding.id,
                  executionMode: binding.validationOnly
                    ? "preview"
                    : "scheduled",
                }
              : {}),
            automatic: true,
            parentId: cycleId,
          }).id,
        );
        remaining--;
      }
      if (queued.length > before)
        this.store.put("channel", {
          ...this.store.require("channel", c.id),
          maintenance: {
            ...c.maintenance,
            validationScanAt: c.lastScanAt,
            validationConnectionVersion: c.connectionVersion || 1,
          },
        });
    }
    return { queued, waiting, budget: this.budget() };
  }
  async run(input, progress, operationId) {
    const scan = await this.scans.run(input, progress);
    const channelIds = scan.sites.flatMap((s) =>
      s.channelCatalogs
        .filter((c) => c.status === "ok")
        .map((c) => c.channelId),
    );
    const result = { ...scan, validation: this.queue(channelIds, operationId) };
    progress({
      stage: result.validation.queued.length
        ? "扫描完成，任务验证已排队"
        : "扫描完成，等待验证条件",
      result,
    });
    return result;
  }
}
