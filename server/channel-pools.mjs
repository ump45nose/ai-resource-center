import { z } from "zod";
import { eligible, entitlement } from "./resources.mjs";
import { gatewayBlock, taskBlock } from "./channel-rules.mjs";
import { Problem } from "./errors.mjs";

const priority = z.number().int().min(-100000).max(100000);
export const poolSchema = z.object({
  name: z.string().trim().min(1).max(100),
  enabled: z.boolean().default(true),
  scope: z.enum(["all_eligible", "selected"]).default("all_eligible"),
  channelIds: z.array(z.string().min(1)).max(1000).default([]),
  channelPriorities: z.record(z.string(), priority).default({}),
  modelPriorities: z.record(z.string(), priority).default({}),
  allowUnverified: z.boolean().default(true),
  cooldownMinutes: z.number().int().min(1).max(1440).default(30),
  maxAttempts: z.number().int().min(1).max(24).default(6),
}).strict();

// PATCH must not apply create-time defaults to omitted fields.
export const patchSchema = schema => z.object(Object.fromEntries(
  Object.entries(schema.shape).map(([name, field]) => [name,
    (field instanceof z.ZodDefault ? field.removeDefault() : field).optional()]),
)).strict();

export function validatePool(store, pool) {
  if (pool.scope === "selected" && !pool.channelIds.length)
    throw new Problem(400, "指定渠道池至少选择一个渠道");
  for (const id of new Set([...pool.channelIds, ...Object.keys(pool.channelPriorities)]))
    store.require("channel", id);
  return { ...pool, channelIds: [...new Set(pool.channelIds)] };
}

export function poolCandidates(store, pool, task, { excluded = [], now = Date.now() } = {}) {
  if (!pool.enabled) return [];
  const offerings = store.list("offering"), channels = store.list("channel"),
    links = new Map(store.list("targetLink").filter(x => x.target === "newapi").map(x => [x.subject, x])),
    excludedSet = new Set(excluded), required = task.requiredCapabilities || [];
  const candidates = [];
  for (const c of channels) {
    if (pool.scope === "selected" && !pool.channelIds.includes(c.id)) continue;
    if (!c.enabled || !c.credentialId || !eligible(store, c) || gatewayBlock(c) || taskBlock(c, task) ||
        (c.protocol || "OpenAI") !== "OpenAI" ||
        ["paused", "closed", "removed"].includes(c.management?.state) ||
        (c.availability && c.availability !== "可用")) continue;
    const account = store.get("account", c.accountId), rights = entitlement(account, new Date(now));
    if (!account || account.enabled === false || account.mergedInto ||
        !rights.available || !rights.balanceCurrent) continue;
    const version = c.connectionVersion || 1;
    const known = offerings.filter(o => o.channelId === c.id);
    if (known.some(o => ["key", "account", "quota"].includes(o.poolFailure?.errorType) &&
        o.poolFailure.connectionVersion === version &&
        now - Date.parse(o.poolFailure.at) < pool.cooldownMinutes * 60000)) continue;
    const models = new Set([...(c.models || []), ...known.filter(o => o.catalog?.present).map(o => o.modelId)]);
    for (const modelId of models) {
      const id = `${c.id}:${modelId}`, o = known.find(x => x.modelId === modelId) || { id, channelId: c.id, modelId };
      if (excludedSet.has(id) || o.catalog?.present === false) continue;
      // These API families have a different endpoint; multimodal chat models
      // remain candidates regardless of their name and must prove input support.
      if (/embedding|rerank|(?:^|[/_-])(?:tts|whisper|dall-e|gpt-image|flux|veo|sora)(?:$|[-_/.])/i.test(modelId)) continue;
      const proof = o.capabilityEvidence?.connectionVersion === version ? o.capabilityEvidence :
        o.verification?.result === "success" &&
        (o.verification.connectionVersion || 1) === version ? o.verification : null;
      const capabilities = { ...(proof?.capabilities || proof?.acceptanceChecks || {}) };
      if (proof?.recheckAfter && now >= Date.parse(proof.recheckAfter))
        for (const name of Object.keys(capabilities)) if (capabilities[name] === false) delete capabilities[name];
      if (required.some(name => capabilities[name] === false)) continue;
      const needsValidation = required.some(name => capabilities[name] !== true);
      if (needsValidation && !pool.allowUnverified) continue;
      const failure = o.poolFailure;
      if (failure?.connectionVersion === version &&
          now - Date.parse(failure.at) < pool.cooldownMinutes * 60000) continue;
      const effectivePriority = pool.channelPriorities[c.id] ?? links.get(c.id)?.snapshot?.priority ??
        c.sourceObservation?.priority ?? c.priority ?? o.applied?.priority ?? 0;
      candidates.push({ channelId: c.id, modelId, offeringId: id, channelName: c.name,
        priority: effectivePriority, modelPriority: pool.modelPriorities[modelId] ?? 0,
        needsValidation, daily: rights.daily, expiresAt: rights.expiresAt,
        lastSelectedAt: o.lastPoolSelectionAt || null });
    }
  }
  const date = (value, fallback) => value ? Date.parse(value) : fallback;
  return candidates.sort((a, b) => b.priority - a.priority || b.modelPriority - a.modelPriority ||
    Number(b.daily) - Number(a.daily) ||
    date(a.expiresAt, Infinity) - date(b.expiresAt, Infinity) ||
    date(a.lastSelectedAt, 0) - date(b.lastSelectedAt, 0) || a.offeringId.localeCompare(b.offeringId));
}

export function normalizeBinding(store, input, { creating = false } = {}) {
  if (input.poolId) {
    const pool = store.require("channelPool", input.poolId);
    if (input.enabled && !pool.enabled) throw new Problem(409, "渠道池已停用");
    if (input.validationOnly) throw new Problem(400, "渠道池用于正常任务；单模型预览使用独立验证绑定");
    return { ...input, channelId: undefined, modelId: undefined, discoverNewModels: undefined,
      unavailable: "skip" };
  }
  if (!input.channelId || !input.modelId) throw new Problem(400, "请选择渠道池");
  if (!input.validationOnly && (creating || input.enabled)) throw new Problem(400, "正常 cron 应绑定渠道池，请到渠道池与任务中配置");
  return input;
}
