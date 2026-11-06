import { observeTaskHealth } from "./channel-health.mjs";
import { tagsOf, taskBlock, channelHeaders } from "./channel-rules.mjs";
import { verificationTask } from "./verification-task.mjs";
import { verified, autoManaged } from "./maintenance-policy.mjs";
import { eligible, entitlement, policies } from "./resources.mjs";
import { Problem, errorMessage } from "./errors.mjs";
import { errorType, errorLabel, dayKey } from "./domain.mjs";
import { poolCandidates } from "./channel-pools.mjs";

export class Evaluations {
  constructor(store, gateway, operations, fetcher = fetch) {
    Object.assign(this, { store, gateway, operations, fetch: fetcher });
    this.preparing = new Map();
  }
  offering(channelId, modelId) {
    const c = this.store.require("channel", channelId);
    if (!eligible(this.store, c))
      throw new Problem(
        400,
        "禁止测活、媒体或禁止使用的资源不参加文字任务验证",
      );
    const old = this.store.get("offering", `${channelId}:${modelId}`);
    if (!old && !(c.models || []).includes(modelId))
      throw new Problem(400, "模型未在该渠道目录或已选模型中");
    return (
      old ||
      this.store.put("offering", {
        id: `${channelId}:${modelId}`,
        channelId,
        modelId,
        capabilityClass: "unclassified",
      })
    );
  }
  async run(input, progress, operationId) {
    if (
      input.automatic &&
      !autoManaged(this.store, this.store.require("channel", input.channelId))
    ) {
      progress({
        state: "cancelled",
        stage: "自动维护已关闭或渠道改为人工管理，未发起验证",
      });
      return { skipped: true };
    }
    if (this.budget?.().used > policies(this.store).maxEvaluationsPerDay) {
      progress({ state: "cancelled", stage: "今日验证预算已用完，未发起调用" });
      return { skipped: true };
    }
    const o = this.offering(input.channelId, input.modelId),
      c = this.store.require("channel", o.channelId);
    const rights = entitlement(this.store.get("account", c.accountId));
    if (!rights.available) throw new Problem(409, rights.reasons.join("、"));
    if (input.taskRef) {
      if (input.bindingId) {
        const binding = this.store.require("binding", input.bindingId);
        if (binding.poolId)
          throw new Problem(409, "任务已绑定渠道池，在正常运行时按优先级选型，不固定单个模型");
        if (
          !binding.enabled ||
          binding.channelId !== c.id ||
          binding.taskRef.source !== input.taskRef.source ||
          binding.taskRef.id !== input.taskRef.id ||
          (!binding.discoverNewModels && binding.modelId !== o.modelId)
        )
          throw new Problem(409, "验证绑定与本次渠道、模型或任务不一致");
      }
      const task = this.task(input.taskRef);
      const blocked = taskBlock(c, task);
      if (blocked) throw new Problem(409, blocked);
      if (task.enabled === false)
        throw new Problem(409, "原任务处于暂停状态，不会恢复执行");
      if (!task.supportsRunConfig || !task.supportsResult)
        throw new Problem(409, "任务需要适配单次模型配置和结果回执");
      if (input.executionMode === "preview" && task.supportsPreview === false)
        throw new Problem(409, "该任务仅在正常定时运行时验证，不额外执行业务操作");
      progress({
        state: "waiting",
        stage:
          input.executionMode === "preview"
            ? "等待 cron 草稿预览"
            : "等待选定 cron 的正常执行",
        taskRef: input.taskRef,
      });
      return;
    }
    const p = policies(this.store);
    if (!p.smokeEnabled)
      throw new Problem(409, "请绑定真实 cron，或先明确启用小任务验证");
    const task = verificationTask(c);
    const blocked = taskBlock(c, task);
    if (blocked) throw new Problem(409, blocked);
    if (tagsOf(c).includes("client_restricted") || c.protocol !== "OpenAI")
      throw new Problem(
        409,
        "此调用方式使用对应客户端任务验证，不使用通用小任务",
      );
    if (!c.credentialId) throw new Problem(409, "缺少上游推理 key");
    progress({ stage: "通过固定 New API 渠道执行小任务" });
    const started = Date.now(),
      connectionVersion = c.connectionVersion || 1;
    let response, verification;
    try {
      const config = await this.gateway.inference(o, operationId, {
        origin: "evaluation",
      });
      response = await this.fetch(`${config.baseUrl}/chat/completions`, {
        method: "POST",
        redirect: "error",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          model: config.modelId,
          messages: [{ role: "user", content: task.prompt }],
          max_tokens: p.smokeMaxTokens,
          stream: false,
        }),
        signal: AbortSignal.timeout(120000),
      });
      const text = await response.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        data = {};
      }
      const content = data.choices?.[0]?.message?.content;
      const evidence = response.ok
        ? await this.gateway.evidence(
            operationId,
            this.store.require("offering", o.id),
          )
        : null;
      const accepted =
        response.ok &&
        evidence?.matched &&
        evidence?.successful &&
        typeof content === "string" &&
        task.accept(content);
      const type = response.ok
        ? null
        : errorType(data.error?.message || text.slice(0, 300), response.status);
      verification = {
        result: accepted ? "success" : "failure",
        quality: accepted ? "passed" : "failed",
        reason: accepted
          ? "小任务返回满足验收条件"
          : response.ok
            ? "返回内容未通过小任务验收"
            : `${errorLabel(type)}（HTTP ${response.status}）`,
        errorType: type,
        httpStatus: response.status,
        requestId: data.id,
        latencyMs: Date.now() - started,
        taskId: task.id,
        method: "small_task",
        operationId,
        at: new Date().toISOString(),
        connectionVersion,
        capabilityClass: "unclassified",
      };
    } catch (error) {
      verification = {
        result: "unconfirmed",
        quality: "unknown",
        reason: errorMessage(error),
        method: "small_task",
        taskId: task.id,
        operationId,
        at: new Date().toISOString(),
        connectionVersion,
      };
    }
    const current = this.store.require("channel", c.id);
    if (
      (current.connectionVersion || 1) !== connectionVersion ||
      !eligible(this.store, current)
    )
      verification = {
        ...verification,
        result: "unconfirmed",
        reason: "连接或管理规则已变化，未采用这次结果",
      };
    await this.complete(o, verification);
    await this.gateway.pauseEvaluation(o.id);
    try {
      await this.gateway.revoke(operationId);
    } catch {
      this.store.put("identity", {
        ...this.store.require("identity", `evaluation:${operationId}`),
        cleanupPending: true,
      });
    }
    // Request facts are collected from New API. The task receipt is not a second call.
    return {
      channelId: c.id,
      modelId: o.modelId,
      passed: verification.result === "success",
      ...verification,
    };
  }

  task(ref) {
    const task = this.store
      .list("task")
      .find((t) => t.source === ref.source && t.externalId === ref.id);
    if (!task) throw new Problem(404, "任务未在调度层目录中上报");
    return task;
  }
  async complete(offering, verification) {
    const channel = this.store.require("channel", offering.channelId);
    const previous = this.store.require("offering", offering.id).verification;
    const sameVersion =
      (previous?.connectionVersion || 1) === (channel.connectionVersion || 1);
    verification = {
      ...verification,
      stableSamples:
        verification.stableSamples ??
        (verification.result === "success" && verification.quality === "passed"
          ? (sameVersion ? previous?.stableSamples || 0 : 0) + 1
          : 0),
      requiredStableSamples: policies(this.store).unstableSuccesses || 3,
    };

    const saved = this.store.put("offering", {
      ...this.store.require("offering", offering.id),
      verification,
      ...(verification.result === "success" && verification.quality === "passed"
        ? { lastPassedVerification: verification }
        : {}),
      ...(verification.result === "success" &&
      verification.quality === "passed" &&
      verification.capabilityClass
        ? { capabilityClass: verification.capabilityClass }
        : {}),
    });
    observeTaskHealth(this.store, saved, verification);
    this.gateway.distribution?.reconcile("newapi");
    this.onVerified?.(saved, verification);
    if (policies(this.store).autoApply) this.gateway.refreshGrades();
    if (
      (verified(saved, this.store.require("channel", saved.channelId)) ||
        (saved.apply?.state === "synced" &&
          saved.lastPassedVerification &&
          verification.result === "failure")) &&
      saved.autoManaged !== false &&
      saved.apply?.state !== "conflict" &&
      autoManaged(this.store, this.store.require("channel", saved.channelId)) &&
      policies(this.store).autoApply
    ) {
      const operation = this.operations.start("apply", {
        requestId: `verified:${verification.operationId || verification.runId}`,
        offeringId: offering.id,
        automatic: true,
      });
      return { ...saved, applyOperationId: operation.id };
    }
    return saved;
  }
  work(source) {
    return {
      items: this.store
        .list("operation")
        .filter(
          (op) =>
            op.kind === "evaluate" &&
            ["waiting", "running"].includes(op.state) &&
            op.input.executionMode === "preview" &&
            op.input.taskRef?.source === source &&
            (!op.input.automatic ||
              autoManaged(
                this.store,
                this.store.require("channel", op.input.channelId),
              )),
        )
        .map((op) => ({
          operationId: op.id,
          runId: `evaluation-${op.id}`,
          taskId: op.input.taskRef.id,
          bindingId: op.input.bindingId,
          executionMode: "preview",
        })),
    };
  }
  async prepare(input, source) {
    const key = `${source}:${input.runId}`;
    if (this.preparing.has(key)) return this.preparing.get(key);
    const promise = this.prepareOnce(input, source);
    this.preparing.set(key, promise);
    try {
      return await promise;
    } finally {
      this.preparing.delete(key);
    }
  }
  async prepareOnce(input, source) {
    const task = this.task({ source, id: input.taskId });
    if (
      task.enabled === false ||
      !task.supportsRunConfig ||
      (input.executionMode === "preview" && task.supportsPreview === false) ||
      ((input.executionMode || "scheduled") === "scheduled" &&
        task.supportsScheduledRunConfig === false)
    )
      return {
        state: "not_applicable",
        reason: "任务暂停或尚不支持本次执行模式的单次配置",
      };
    let run = this.store.get("run", `${source}:${input.runId}`);
    const executionMode = input.executionMode || "scheduled";
    if (
      run &&
      ((run.executionMode || "scheduled") !== executionMode ||
        (input.bindingId && run.bindingId !== input.bindingId))
    )
      throw new Problem(409, "同一运行标识不能改变绑定或执行模式");
    if (run && run.taskId !== input.taskId)
      throw new Problem(409, "同一个 runId 不能用于另一项任务");
    if (run?.completedAt) return { state: "completed", runId: input.runId };
    let pending = this.store
      .list("operation")
      .find(
        (op) =>
          op.kind === "evaluate" &&
          op.state === "waiting" &&
          !op.claimedRunId &&
          (op.input.executionMode || "scheduled") === executionMode &&
          (!input.bindingId || op.input.bindingId === input.bindingId) &&
          op.input.taskRef?.source === source &&
          op.input.taskRef?.id === input.taskId,
      );
    const binding = this.store
      .list("binding")
      .find(
        (b) =>
          b.enabled &&
          (!input.bindingId || b.id === input.bindingId) &&
          (executionMode === "preview" || !b.validationOnly) &&
          b.taskRef.source === source &&
          b.taskRef.id === input.taskId,
      );
    if (input.bindingId && !binding && !run)
      throw new Problem(409, "绑定已停用或不属于本次任务");
    if (
      !run?.poolId && !binding?.poolId &&
      pending?.input.automatic &&
      !autoManaged(
        this.store,
        this.store.require("channel", pending.input.channelId),
      )
    )
      return { state: "not_applicable", reason: "该渠道已退出自动维护" };
    if (!run && !pending && !binding)
      return {
        state: "not_applicable",
        reason: "本次任务没有资源绑定或待验证模型",
      };
    const poolId = run?.poolId || binding?.poolId;
    const pool = poolId ? this.store.require("channelPool", poolId) : null;
    let selection;
    if (pool && !run) {
      const candidates = poolCandidates(this.store, pool, task, { excluded: input.excludedOfferings || [] });
      selection = candidates[0];
      if (!selection) return { state: "skip", poolId: pool.id, reason: "渠道池暂无符合要求且有可用额度的模型" };
      // A historical per-model operation cannot override the pool's priority.
      pending = null;
    }
    const channelId =
      run?.channelId || selection?.channelId || pending?.input.channelId || binding.channelId;
    const modelId = run?.modelId || selection?.modelId || pending?.input.modelId || binding.modelId;
    const o = this.offering(channelId, modelId),
      c = this.store.require("channel", channelId);
    const blocked = taskBlock(c, task);
    if (blocked) return { state: "not_applicable", reason: blocked };
    const rights = entitlement(this.store.get("account", c.accountId));
    if (!rights.available)
      return {
        state: binding?.unavailable === "skip" ? "skip" : "not_applicable",
        reason: rights.reasons.join("、"),
      };
    if (
      executionMode === "preview" &&
      !run &&
      (c.catalogObservation?.status !== "ok" ||
        !o.catalog?.present ||
        Date.now() - Date.parse(c.lastScanAt || 0) >
          policies(this.store).maintenanceHours * 3600000 ||
        !rights.balanceCurrent)
    )
      return {
        state: "not_applicable",
        reason: "等待新目录及权益观察后再验证预览",
      };
    if (
      !run &&
      this.budget &&
      this.budget().remaining <= 0 &&
      (!pending ||
        dayKey(
          pending.executionStartedAt || pending.startedAt || pending.createdAt,
        ) !== dayKey(new Date()))
    )
      return {
        state: "not_applicable",
        reason: "今日验证预算已用完，等待次日",
      };
    if (!run)
      run = this.store.put("run", {
        id: `${source}:${input.runId}`,
        source,
        externalId: input.runId,
        taskId: input.taskId,
        channelId,
        modelId,
        connectionVersion: c.connectionVersion || 1,
        operationId: pending?.id,
        bindingId: binding?.id,
        executionMode,
        requiredCapabilities: task.requiredCapabilities || [],
        ...(pool ? { poolId: pool.id, poolVersion: pool.version,
          poolRunId: input.poolRunId || input.runId, selection } : {}),
        createdAt: new Date().toISOString(),
      });
    if (pool && selection) this.store.put("offering", { ...o, lastPoolSelectionAt: run.createdAt });
    if (
      run.operationId &&
      !this.store.require("operation", run.operationId).claimedRunId
    )
      this.operations.update(run.operationId, {
        state: "running",
        stage: "cron 正在验证指定渠道",
        claimedRunId: run.id,
        executionStartedAt: run.createdAt,
      });
    if ((c.connectionVersion || 1) !== run.connectionVersion)
      throw new Problem(409, "本次验证期间连接配置已改变，不重复使用旧配置");
    let config;
    try {
      config = await this.gateway.inference(this.store.require("offering", o.id), run.id, {
        origin: executionMode === "preview" ? "evaluation" : "live",
      });
    } catch (error) {
      if (!pool) throw error;
      const at = new Date().toISOString(), reason = errorMessage(error);
      this.store.put("run", { ...run, completedAt: at, preparationFailed: true,
        verification: { result: "unconfirmed", quality: "unknown", reason, at, method: "preparation" } });
      this.store.put("offering", { ...this.store.require("offering", o.id),
        poolFailure: { at, connectionVersion: c.connectionVersion || 1, reason, errorType: "upstream" } });
      try { await this.gateway.revoke(run.id); await this.gateway.pauseEvaluation(o.id); }
      catch { this.store.put("run", { ...this.store.require("run", run.id), credentialCleanupPending: true }); }
      return { state: "unavailable", runId: input.runId, channelId, modelId, poolId: pool.id,
        maxAttempts: pool.maxAttempts, reason: "候选渠道准备失败，按池优先级尝试下一项" };
    }
    return {
      state: "prepared",
      runId: input.runId,
      channelId,
      modelId,
      ...(pool ? { poolId: pool.id, poolRunId: run.poolRunId, maxAttempts: pool.maxAttempts,
        selection: run.selection } : {}),
      operationId: run.operationId || null,
      configuration: {
        ...config,
        protocol: c.protocol,
        headers: Object.fromEntries(
          channelHeaders(this.store, c).map((h) => [h.name, h.value]),
        ),
        allowFallback: false,
      },
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    };
  }
  async result(input, source) {
    const run = this.store.require("run", `${source}:${input.runId}`);
    if (run.completedAt) {
      await this.complete(
        this.store.require("offering", `${run.channelId}:${run.modelId}`),
        run.verification,
      );
      try {
        await this.gateway.revoke(run.id);
      } catch {
        /* Revoke again on the next receipt; never rerun the task. */
      }
      return { acknowledged: true, runId: input.runId };
    }
    if (!input.actualChannelId || !input.actualModelId)
      throw new Problem(400, "任务结果必须说明实际使用的渠道与模型");
    const current = this.store.require("channel", run.channelId);
    const evidence = await this.gateway.evidence(
      run.id,
      this.store.require("offering", `${run.channelId}:${run.modelId}`),
    );
    if (
      input.result === "success" &&
      !evidence.observed &&
      input.actualChannelId === run.channelId &&
      input.actualModelId === run.modelId &&
      !input.usedFallback
    )
      throw new Problem(
        409,
        "等待 New API 请求记录，保留回执补交，不重复执行任务",
      );
    const matched =
      evidence.matched &&
      input.actualChannelId === run.channelId &&
      input.actualModelId === run.modelId &&
      !input.usedFallback &&
      (current.connectionVersion || 1) === run.connectionVersion;
    const passed =
      matched &&
      evidence.successful &&
      input.result === "success" &&
      input.acceptance === "passed" &&
      (run.requiredCapabilities || []).every(
        (capability) => input.acceptanceChecks?.[capability] === true,
      );
    const o = this.store.require("offering", `${run.channelId}:${run.modelId}`);
    const result = {
      result: passed
        ? "success"
        : matched &&
            (input.result === "failure" || input.acceptance === "failed")
          ? "failure"
          : "unconfirmed",
      connectionVersion: run.connectionVersion,
      at: input.occurredAt,
      method: "cron",
      runId: run.id,
      operationId: run.operationId,
      requestId: input.requestId || evidence.requestIds?.[0],
      requestIds: evidence.requestIds,
      errorType: input.errorType,
      latencyMs: input.latencyMs,
      artifactRef: input.artifactRef,
      materialDate: input.materialDate,
      acceptanceChecks: input.acceptanceChecks,
      verifiedCapabilities: passed ? run.requiredCapabilities || [] : [],
      executionMode: run.executionMode || "scheduled",
      quality: input.acceptance || "unknown",
      capabilityClass: input.capabilityClass || "unclassified",
      reason: !matched
        ? input.errorSummary || "实际渠道模型不匹配或发生备用切换"
        : passed
          ? "实际渠道与模型一致，任务验收通过"
          : input.errorSummary || "任务未通过日期、结构或来源验收",
    };
    const previous = o.verification;
    result.stableSamples = passed
      ? ((previous?.connectionVersion || 1) === run.connectionVersion
          ? previous?.stableSamples || 0
          : 0) + 1
      : 0;
    result.requiredStableSamples = policies(this.store).unstableSuccesses || 3;
    this.store.transaction(() => {
      // A task can contain many requests. Its result is not an additional billable call.
      this.store.put("run", {
        ...run,
        completedAt: new Date().toISOString(),
        verification: result,
      });
      const capabilities = Object.fromEntries(["vision", "tool_calling"]
        .filter(name => input.acceptanceChecks?.[name] === true).map(name => [name, true]));
      if (input.errorSummary === "ai_vision_check_failed") capabilities.vision = false;
      if (["ai_single_tool_call_required", "ai_invalid_tool_call"].includes(input.errorSummary)) capabilities.tool_calling = false;
      const oldEvidence = o.capabilityEvidence?.connectionVersion === run.connectionVersion ? o.capabilityEvidence.capabilities : {};
      this.store.put("offering", { ...o, verification: result,
        ...(matched && evidence.successful && Object.keys(capabilities).length ? {
          capabilityEvidence: { at: input.occurredAt, connectionVersion: run.connectionVersion,
            capabilities: { ...oldEvidence, ...capabilities },
            ...(Object.values(capabilities).includes(false)
              ? { recheckAfter: new Date(Date.parse(input.occurredAt) + 7 * 86400000).toISOString() }
              : o.capabilityEvidence?.recheckAfter ? { recheckAfter: o.capabilityEvidence.recheckAfter } : {}),
          },
        } : {}),
        ...(run.poolId ? { poolFailure: input.result === "failure" || input.acceptance === "failed"
          ? { at: input.occurredAt, connectionVersion: run.connectionVersion, reason: input.errorSummary || result.reason,
            errorType: input.errorType || "upstream" }
          : null } : {}),
      });
      if (run.operationId)
        this.operations.update(run.operationId, {
          state: "succeeded",
          stage: "任务结果已回收",
          result,
          finishedAt: new Date().toISOString(),
        });
    });
    await this.complete(o, result);
    await this.gateway.pauseEvaluation(o.id);
    try {
      await this.gateway.revoke(run.id);
    } catch {
      this.store.put("run", {
        ...this.store.require("run", run.id),
        credentialCleanupPending: true,
      });
    }
    return { acknowledged: true, runId: input.runId, verification: result };
  }
}
