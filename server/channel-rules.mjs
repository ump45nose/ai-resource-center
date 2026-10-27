import { Problem } from "./errors.mjs";

export const tagLabels = {
  client_restricted: "客户端限定",
  no_probe: "禁止测活",
  no_code: "禁止代码",
  no_nsfw: "禁止 NSFW",
  code_only: "仅能用于代码",
};
export const legacyTags = (c) =>
  c.category === "client" && c.client ? ["client_restricted"] : [];
export const tagsOf = (c) => c.tags ?? legacyTags(c);
export const channelHeaders = (store, c) =>
  c.headersManagedBy === "manual" || c.headers?.length
    ? c.headers || []
    : c.credentialHeadersId
      ? Object.entries(JSON.parse(store.reveal(c.credentialHeadersId))).map(
          ([name, value]) => ({ name, value }),
        )
      : [];
export const usageLabels = {
  general: "通用",
  image: "生图",
  video: "视频",
  rp: "酒馆",
};
export const archiveLabels = {
  website: "网站打不开",
  balance: "无余额无签到",
  invalid: "网站或 key 失效",
  unstable: "调用不稳定",
  call: "调用失败",
  maintenance: "暂停维护",
};
export function usageOf(c) {
  if (c.usage) return c.usage;
  if (c.category === "rp" || c.nativeCredentialRef || c.tavern) return "rp";
  if (c.category === "media") {
    return (c.models || []).some((m) =>
      /hailuo|veo|sora|kling|vidu|video/i.test(m),
    )
      ? "video"
      : "image";
  }
  return "general";
}
export function archiveOf(c, site) {
  if (isRemoved(c)) return [];
  if (Object.hasOwn(c, "archiveReason"))
    return c.archiveReason ? [c.archiveReason] : [];
  const issues = new Set();
  const reason = [
    c.availability,
    typeof c.callIssue === "string" ? c.callIssue : c.callIssue?.reason,
  ]
    .filter(Boolean)
    .join(" ");
  if (
    (site?.websiteObservation
      ? site.websiteObservation.status === "unreachable" ||
        site.websiteObservation.httpStatus >= 500
      : site?.siteDown) ||
    (c.management?.state === "closed" && !c.availability) ||
    /网站打不开|网站关闭|关站/.test(reason)
  )
    issues.add("website");
  if (/无余额|余额耗尽|没钱|无签到/.test(reason)) issues.add("balance");
  if (
    /网站或key失效|网站或 key 失效|key.*(失效|缺失|丢失)|已封|封禁|未注册/.test(
      reason,
    ) ||
    ["invalid", "authentication_failed", "missing_key"].includes(
      c.credentialState,
    )
  )
    issues.add("invalid");
  if (/不稳定/.test(reason)) issues.add("unstable");
  if (/调用失败|调不通|模型.*失败/.test(reason)) issues.add("call");
  if (
    c.callIssue &&
    !issues.size &&
    !/429|限流|rate.limit|余额|quota/i.test(reason)
  )
    issues.add("call");
  if (
    /维护|模型不足|没模型/.test(reason) ||
    (c.management?.state === "maintenance" && !issues.size)
  )
    issues.add("maintenance");
  return [...issues];
}
export function gatewayBlock(c) {
  if (usageOf(c) === "rp") return "酒馆分组只在酒馆维护，不导入 New API";
  if (c.gatewayAllowed === false) return "此渠道不允许导入 New API";
  return null;
}
export const capabilitiesOf = (c) =>
  c.capabilities ??
  (c.category === "media"
    ? [
        ...(c.imageAudit ||
        (c.models || []).some((m) =>
          /image|dall-e|flux|imagen|stable-diffusion/i.test(m),
        )
          ? ["image"]
          : []),
        ...(c.videoAudit ||
        (c.models || []).some((m) =>
          /hailuo|veo|sora|kling|vidu|video/i.test(m),
        )
          ? ["video"]
          : []),
      ]
    : ["text"]);
export const applicationsOf = (c) =>
  [
    ...new Set([
      ...(c.bindings || []).map((b) =>
        typeof b === "string" ? b : b.application,
      ),
      ...(c.gateway?.sourceId === "cpa" ? [] : c.gateway ? ["New API"] : []),
      ...(usageOf(c) === "rp" ? ["酒馆"] : []),
    ]),
  ].filter(Boolean);
export const isRp = (c) => usageOf(c) === "rp";
export const isRemoved = (c) =>
  c.availability === "已移除" || c.management?.state === "removed";
export const isInternal = (c) => c.internal === true;

export function validateTags(tags) {
  if (tags.some((tag) => !Object.hasOwn(tagLabels, tag)))
    throw new Problem(400, "存在不支持的渠道标签");
  if (tags.includes("no_code") && tags.includes("code_only"))
    throw new Problem(400, "禁止代码和仅能用于代码不能同时设置");
  return [...new Set(tags)];
}

export function probeBlock(store, c, channels) {
  if (c.mergedInto || c.sourceOnly) return "已合并或仅来源资料";
  if (isRemoved(c) || c.management?.prohibited) return "已移除或禁止使用";
  if (isInternal(c)) return "内部订阅转发，本版不接入";
  if (c.management?.state === "paused") return "人工暂停";
  if (tagsOf(c).includes("no_probe")) return "禁止测活";
  if (c.credentialId) {
    const fp = store.db
      .prepare("SELECT fingerprint FROM credentials WHERE id=?")
      .get(c.credentialId)?.fingerprint;
    const same = new Set(
      fp
        ? store.db
            .prepare("SELECT id FROM credentials WHERE fingerprint=?")
            .all(fp)
            .map((r) => r.id)
        : [c.credentialId],
    );
    if (
      (channels || store.list("channel")).some(
        (other) =>
          same.has(other.credentialId) && tagsOf(other).includes("no_probe"),
      )
    )
      return "同一凭据的关联渠道禁止测活";
  }
  return null;
}

export function taskBlock(c, task = {}) {
  const tags = tagsOf(c);
  if (tags.includes("no_code") && task.purpose === "code")
    return "渠道禁止代码任务";
  if (tags.includes("code_only") && task.purpose !== "code")
    return "该渠道仅能用于代码，请使用明确的代码任务";
  if (tags.includes("no_nsfw") && task.nsfw) return "渠道禁止 NSFW";
  if (
    tags.includes("client_restricted") &&
    !c.nativePassthrough &&
    ((!c.client && !c.clientRequirements?.client) ||
      task.client !== (c.clientRequirements?.client || c.client))
  )
    return "请使用渠道限定的客户端或已验证的 New API 透传";
  return null;
}
