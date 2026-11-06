import { autoScope } from "./maintenance-policy.mjs";
import {
  tagLabels,
  usageLabels,
  archiveLabels,
  taskBlock,
} from "./channel-rules.mjs";
import { bookmarkPlan } from "./bookmarks.mjs";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { headers as normalizeHeaders } from "./domain.mjs";
import { Problem, publicValue } from "./errors.mjs";
import { paginate, policies } from "./resources.mjs";
import { listCheckins } from "./checkins.mjs";
import { history } from "./history.mjs";

const text = z.string().min(1),
  url = z
    .url()
    .refine(
      (s) => ["http:", "https:"].includes(new URL(s).protocol),
      "需要 HTTP(S) 地址",
    );
const version = z.number().int().positive();
const purpose = z.enum(["general", "media", "client"]);
const listing = {
  q: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
};
const siteFields = {
  name: text,
  websiteUrl: url,
  checkinUrl: url.nullable().optional(),
  aliases: z.array(url).optional(),
  pinned: z.boolean().optional(),
  note: z.string().optional(),
};
const benefit = z
  .object({
    tz: z
      .string()
      .refine((tz) => {
        try {
          new Intl.DateTimeFormat("en", { timeZone: tz });
          return true;
        } catch {
          return false;
        }
      })
      .optional(),
    resetAt: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
      .optional(),
    windows: z
      .array(
        z.object({
          start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
          end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
        }),
      )
      .optional(),
    threshold: z.union([z.string(), z.number()]).optional(),
    drops: z.string().optional(),
    releaseTimes: z
      .array(z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/))
      .optional(),
    validity: z.string().optional(),
    dailyLimit: z.number().nonnegative().optional(),
    balanceMode: z.enum(["observed", "fixed_daily"]).optional(),
    renewal: z.enum(["automatic", "checkin"]).optional(),
  })
  .strict();
const accountFields = {
  siteId: text,
  name: text,
  checkinEnabled: z.boolean().nullable().optional(),
  enabled: z.boolean().nullable().optional(),
  quota: z.enum(["daily", "long"]).optional(),
  benefit: benefit.optional(),
  validUntil: z.iso.datetime().nullable().optional(),
  note: z.string().optional(),
};
const channelFields = {
  siteId: text,
  accountId: text,
  name: text,
  baseUrl: url,
  protocol: z
    .enum(["OpenAI", "OpenAI Responses", "Anthropic", "Gemini"])
    .optional(),
  purpose: purpose.optional(),
  usage: z.enum(Object.keys(usageLabels)).optional(),
  tags: z.array(z.enum(Object.keys(tagLabels))).optional(),
  capabilities: z.array(z.enum(["text", "image", "video"])).optional(),
  clientRequirements: z
    .object({ client: z.string().optional(), note: z.string().optional() })
    .strict()
    .optional(),
  models: z.array(text).optional(),
  enabled: z.boolean().optional(),
  mode: z.enum(["auto", "manual"]).optional(),
  rating: z.enum(["", "优", "良", "差"]).optional(),
  note: z.string().optional(),
  order: z.number().int().nonnegative().optional(),
  client: z.string().optional(),
  recoveryPolicy: z.object({ enabled: z.boolean() }).strict().optional(),
  gatewayAllowed: z.boolean().optional(),
  management: z
    .object({
      state: z
        .enum(["active", "maintenance", "closed", "paused", "removed"])
        .optional(),
      prohibited: z.boolean().optional(),
      fixed: z.boolean().optional(),
    })
    .strict()
    .optional(),
  headers: z
    .array(z.object({ name: z.string(), value: z.string() }))
    .optional(),
};
const policyFields = {
  enabled: z.boolean(),
  normalHours: z.number().min(1),
  maintenanceHours: z.number().min(1),
  closedHours: z.number().min(1),
  keyRetryHours: z.number().min(1),
  newModelsHours: z.number().min(1),
  archiveAfterDays: z.number().int().min(1).max(365),
  archiveReviewHours: z.number().int().min(24).max(8760),
  scanConcurrency: z.number().int().min(1).max(5),
  unstableSuccesses: z.number().int().min(2).max(10),
  maxCandidates: z.number().int().min(1).max(20),
  smokeEnabled: z.boolean(),
  smokeMaxTokens: z.number().int().min(256).max(4096),
  maxEvaluationsPerDay: z.number().int().min(1).max(500),
  modelRules: z
    .array(
      z
        .object({
          match: text,
          capabilityClass: z.enum(["strong", "execution"]),
        })
        .strict(),
    )
    .min(1)
    .max(30),
  excludedModels: z.string(),
  autoApply: z.boolean(),
  newApiSourceId: text,
  days: z.number().int().min(1).max(90),
  samples: z.number().int().positive(),
  good: z.number().min(0).max(100),
  warn: z.number().min(0).max(100),
};
const sourceFields = {
  name: text,
  kind: z.enum(["newapi", "all-api-hub", "cron"]),
  url: url.nullable().optional(),
  enabled: z.boolean().optional(),
  userId: z.number().int().positive().optional(),
  syncEnabled: z.boolean().optional(),
  inventoryMinutes: z.number().int().min(1).max(1440).optional(),
  callsMinutes: z.number().int().min(1).max(1440).optional(),
};
const taskRef = z.object({ source: text, id: text }).strict();

export function capabilities({
  store,
  resources,
  sources,
  scans,
  operations,
  gateway,
  evaluations,
  maintenance,
  distribution,
}) {
  const all = [];
  const add = (
    name,
    method,
    path,
    description,
    shape,
    handler,
    write = false,
    options = {},
  ) =>
    all.push({
      name: `resource_${name}`,
      method,
      path,
      description,
      schema: z.object(shape).strict(),
      handler,
      write,
      ...options,
    });
  add(
    "capabilities",
    "GET",
    "/capabilities",
    "已实现及当前启用的能力，供前端按实际状态接入",
    {},
    () => ({
      version: "2.0.0",
      resources: true,
      sourceSync: true,
      configurationSync: true,
      archiveReview: true,
      mirrorTargets: ["notion", "chrome-bookmarks"],
      connectorRole: "connector",
      modelScan: true,
      cronValidation: true,
      gatewayWrites: gateway.allowWrites,
      automationEnabled: policies(store).enabled,
      channelTags: tagLabels,
      channelUsages: usageLabels,
      archiveReasons: archiveLabels,
      excludedSources: ["cpa"],
      sourceSyncEnabled: sources.list().some((s) => s.syncEnabled),
      migration: store.setting("migration:channel-tags-v1"),
      legacyImport: store.setting("legacyImport"),
      mediaValidation: false,
    }),
  );
  add(
    "overview",
    "GET",
    "/overview",
    "今日资源、权益、签到和待处理事项",
    {},
    () => resources.overview(),
  );
  add(
    "list_checkins", "GET", "/checkins",
    "按业务日期和受益账号归并签到记录，保留最新尝试和已确认成果",
    { cursor: listing.cursor, limit: listing.limit, siteId: text.optional(),
      start_date: z.string().optional(), end_date: z.string().optional() },
    (query) => listCheckins(store, query),
  );
  add(
    "list_sites",
    "GET",
    "/sites",
    "按站点聚合查询来源和渠道",
    {
      ...listing,
      purpose: purpose.optional(),
      usage: z.enum(Object.keys(usageLabels)).optional(),
      archiveReason: z.enum(Object.keys(archiveLabels)).optional(),
      status: text.optional(),
      tag: text.optional(),
      capability: text.optional(),
      application: text.optional(),
      recoveryState: text.optional(),
    },
    (a) => resources.sites(a),
  );
  add(
    "bookmark_plan",
    "GET",
    "/bookmarks",
    "按通用、生图、视频及归档原因生成 Chrome 书签分类；酒馆目录保持 RP 移出中心时的书签",
    {},
    () => bookmarkPlan(resources),
  );
  add(
    "get_site",
    "GET",
    "/sites/:id",
    "查看站点账号、渠道、签到与权益",
    { id: text },
    ({ id }) => resources.detail(id),
  );
  add(
    "list_models",
    "GET",
    "/models",
    "按具体模型查询可用渠道与验证结果",
    {
      ...listing,
      purpose: purpose.optional(),
      tag: text.optional(),
      capability: text.optional(),
      application: text.optional(),
      availability: text.optional(),
      capabilityClass: z
        .enum(["strong", "execution", "unclassified"])
        .optional(),
    },
    (a) => resources.models(a),
  );
  add(
    "list_attention",
    "GET",
    "/attention",
    "需要人工处理的事项，不包含普通维护错误",
    listing,
    (a) => paginate(resources.attention(), a),
  );
  add(
    "update_attention",
    "PATCH",
    "/attention/:id",
    "标记已读或稍后处理，不改变资源状态",
    { id: text, state: z.enum(["open", "read", "snoozed"]) },
    ({ id, state }) => {
      store.setting(`attention:${id}`, { state });
      return { id, state };
    },
    true,
  );
  add(
    "history",
    "GET",
    "/history",
    "查看维护、调用和修改历史，保留来源与覆盖范围",
    {
      ...listing,
      siteId: text.optional(),
      channelId: text.optional(),
      modelId: text.optional(),
      from: z.iso.datetime().optional(),
      to: z.iso.datetime().optional(),
      kind: z.enum(["calls", "changes", "operations"]).optional(),
    },
    (a) => history(store, a),
  );
  add(
    "create_site",
    "POST",
    "/sites",
    "新增站点资料，不调用上游",
    { data: z.object(siteFields).strict() },
    ({ data }) => publicValue(resources.site(data)),
    true,
  );
  add(
    "create_account",
    "POST",
    "/accounts",
    "新增独立账号和权益规则",
    { data: z.object(accountFields).strict() },
    ({ data }) => {
      store.require("site", data.siteId);
      return store.put("account", {
        id: randomUUID(),
        balance: null,
        unit: "待确认",
        quota: "long",
        benefit: {},
        ...data,
      });
    },
    true,
  );
  add(
    "create_channel",
    "POST",
    "/channels",
    "新增调用连接，默认通用且暂停",
    { data: z.object(channelFields).strict() },
    ({ data }) => resources.publicChannel(resources.channel(data)),
    true,
  );
  for (const [kind, fields] of [
    ["site", siteFields],
    ["account", accountFields],
    ["channel", channelFields],
  ])
    add(
      `update_${kind}`,
      "PATCH",
      `/${kind === "site" ? "sites" : kind === "account" ? "accounts" : "channels"}/:id`,
      "更新人工资料并校验版本",
      { id: text, version, changes: z.object(fields).partial().strict() },
      ({ id, version, changes }) => {
        if (changes.headers) {
          try {
            changes.headers = normalizeHeaders(changes.headers);
          } catch (e) {
            throw new Problem(400, e.message);
          }
        }
        return resources.update(kind, id, version, changes);
      },
      true,
    );
  add(
    "update_credential",
    "PUT",
    "/channels/:id/credential",
    "保存推理 key，不回显、不触发上游请求",
    { id: text, version, key: text },
    ({ id, version, key }) => resources.saveCredential(id, version, key),
    true,
    { mcp: false },
  );
  add(
    "credential_choices",
    "GET",
    "/channels/:id/credentials",
    "列出同账号已保存的调用凭据，不回显 key",
    { id: text },
    ({ id }) => ({
      items: resources.credentialChoices(id).map(({ credentialId, ...x }) => x),
    }),
  );
  add(
    "select_credential",
    "POST",
    "/channels/:id/credentials/select",
    "关联同账号凭据，保留归档和暂停",
    { id: text, version, choiceId: text },
    ({ id, version, choiceId }) =>
      resources.selectCredential(id, version, choiceId),
    true,
  );
  add(
    "channel_lifecycle",
    "POST",
    "/channels/:id/lifecycle",
    "归档、暂停、复查或永久移除",
    {
      id: text,
      version,
      action: z.enum(["archive", "pause", "resume", "review", "remove"]),
      reason: z.enum(Object.keys(archiveLabels)).optional(),
      note: z.string().optional(),
      recoveryEnabled: z.boolean().optional(),
    },
    (a) => {
      if (a.action === "archive" && !a.reason)
        throw new Problem(400, "请选择归档原因");
      return resources.lifecycle(
        a.id,
        a.version,
        a.action,
        a.reason,
        a.note,
        a.recoveryEnabled,
      );
    },
    true,
  );
  const targetId = z.enum([
    "newapi",
    "all-api-hub",
    "notion",
    "chrome-bookmarks",
  ]);
  add(
    "sync_targets",
    "GET",
    "/sync/targets",
    "独立同步目标与回执状态",
    {},
    () => ({ items: distribution.list() }),
  );
  add(
    "sync_target_update",
    "PATCH",
    "/sync/targets/:id",
    "配置同步目标，首次接管必须预览确认",
    {
      id: targetId,
      version,
      changes: z
        .object({
          enabled: z.boolean().optional(),
          sourceId: text.optional(),
          databaseId: text.optional(),
          dataSourceId: text.optional(),
          rootId: text.optional(),
        })
        .strict(),
    },
    (a) => distribution.save(a.id, a.version, a.changes),
    true,
  );
  add(
    "sync_target_credential",
    "PUT",
    "/sync/targets/:id/credential",
    "保存镜像服务凭据",
    { id: z.literal("notion"), version, key: text },
    (a) => distribution.credential(a.id, a.version, a.key),
    true,
    { mcp: false },
  );
  add(
    "sync_preview",
    "POST",
    "/sync/targets/:id/preview",
    "预览新增、修改、停用和托管字段冲突",
    { id: targetId },
    (a) => distribution.preview(a.id),
    true,
  );
  add(
    "sync_confirm",
    "POST",
    "/sync/targets/:id/confirm",
    "确认首次接管，后续保存自动排队",
    {
      id: targetId,
      previewId: text,
      subjectIds: z.array(text).min(1).optional(),
    },
    (a) => distribution.confirm(a.id, a.previewId, a.subjectIds),
    true,
  );
  add(
    "sync_jobs",
    "GET",
    "/sync/jobs",
    "查看同步任务与失败原因",
    { target: targetId.optional(), subject: text.optional() },
    (a) => ({ items: distribution.jobs(a) }),
  );
  add(
    "sync_diff",
    "GET",
    "/sync/jobs/:id/diff",
    "查看托管字段的两侧差异，不返回凭据",
    { id: text },
    (a) => distribution.diff(a.id),
  );
  add(
    "sync_retry",
    "POST",
    "/sync/jobs/:id/retry",
    "重试幂等同步任务",
    { id: text },
    (a) => distribution.retry(a.id),
    true,
  );
  add(
    "sync_resolve",
    "POST",
    "/sync/jobs/:id/resolve",
    "采用目标配置或恢复中心配置",
    { id: text, choice: z.enum(["target", "center"]) },
    (a) => distribution.resolve(a.id, a.choice),
    true,
  );
  add(
    "preview_changes",
    "POST",
    "/changes/preview",
    "预览站点合并或渠道批量整理，保留独立账号余额",
    {
      action: z.enum(["merge_sites", "purpose", "pause", "remove"]),
      ids: z.array(text).min(1),
      targetId: text.optional(),
      purpose: purpose.optional(),
    },
    (a) => {
      if (a.action === "purpose" && !a.purpose)
        throw new Problem(400, "请选择用途");
      return resources.previewChanges(a);
    },
    true,
  );
  add(
    "apply_changes",
    "POST",
    "/changes/:id/apply",
    "应用已确认范围，版本变化时停止",
    { id: text, requestId: text },
    ({ id, requestId }) => resources.applyChanges(id, requestId),
    true,
  );
  add(
    "get_policies",
    "GET",
    "/policies",
    "自动维护周期、验证预算和评价阈值",
    {},
    () => policies(store),
  );
  add(
    "update_policies",
    "PATCH",
    "/policies",
    "配置自动维护，不立即运行任务",
    { changes: z.object(policyFields).partial().strict() },
    ({ changes }) => {
      const p = { ...policies(store), ...changes };
      if (p.good < p.warn) throw new Problem(400, "优先阈值不能低于常规阈值");
      if (p.enabled && !policies(store).enabled) {
        for (const c of store
          .list("channel")
          .filter((c) => autoScope(store, c)))
          store.put("channel", { ...c, mode: "auto", version: c.version + 1 });
      }
      store.setting("maintenancePolicy", p);
      distribution.reconcile("newapi");
      return p;
    },
    true,
  );
  add(
    "list_sources",
    "GET",
    "/sources",
    "来源接入、同步状态和本次数据变化",
    {},
    () => ({ items: sources.list() }),
  );
  add(
    "check_source",
    "POST",
    "/sources/:id/check",
    "检查来源授权与可同步能力，不运行任务",
    { id: text, requestId: text },
    ({ id, requestId }) =>
      operations.start("check", { requestId, sourceId: id }),
    true,
    { accepted: true },
  );
  add(
    "preview_source",
    "POST",
    "/sources/:id/preview",
    "预览首次同步的站点和渠道范围，不导入",
    { id: text, requestId: text },
    ({ id, requestId }) =>
      operations.start("preview", { requestId, sourceId: id }),
    true,
    { accepted: true },
  );
  add(
    "create_source",
    "POST",
    "/sources",
    "配置同步来源，凭据通过单独受限接口保存",
    { data: z.object(sourceFields).strict() },
    ({ data }) => sources.save(data),
    true,
  );
  add(
    "update_source",
    "PATCH",
    "/sources/:id",
    "修改来源地址、启停及配置",
    { id: text, version, changes: z.object(sourceFields).partial().strict() },
    ({ id, version, changes }) => sources.save(changes, id, version),
    true,
  );
  add(
    "source_credential",
    "PUT",
    "/sources/:id/credential",
    "保存来源管理凭据",
    { id: text, version, key: text },
    ({ id, version, key }) => {
      const s = sources.get(id);
      if ((s.version || 1) !== version)
        throw new Problem(
          409,
          "来源已更新",
          { currentVersion: s.version || 1 },
          "version_conflict",
        );
      sources.update(id, {
        credentialId: store.secret(key, s.credentialId),
        version: version + 1,
      });
      return sources.list().find((s) => s.id === id);
    },
    true,
    { mcp: false },
  );
  add(
    "get_operation",
    "GET",
    "/operations/:id",
    "查询同步、扫描或测试的逐项进度及结果",
    { id: text },
    ({ id }) => store.require("operation", id),
  );
  add(
    "list_evaluations",
    "GET",
    "/evaluations",
    "历史实测与本轮任务验证，历史结果不冒充当前成功率",
    { ...listing, channelId: text.optional(), modelId: text.optional() },
    (a) =>
      paginate(
        [
          ...resources.evaluations(a.channelId, a.modelId),
          ...store
            .list("operation")
            .filter(
              (o) =>
                o.kind === "evaluate" &&
                (!a.channelId || o.input.channelId === a.channelId) &&
                (!a.modelId || o.input.modelId === a.modelId),
            )
            .map((o) => ({ ...o, origin: "current" })),
        ],
        a,
      ),
  );
  add(
    "list_operations",
    "GET",
    "/operations",
    "扫描与测试运行列表",
    { ...listing, state: text.optional(), kind: text.optional() },
    (a) => {
      // Page through ids, newest first, so only the returned operations are parsed.
      const page = paginate(
        store
          .sql(
            `SELECT id FROM entities WHERE kind='operation'${a.state ? " AND json_extract(data,'$.state')=?" : ""}${a.kind ? " AND json_extract(data,'$.kind')=?" : ""} ORDER BY rowid DESC`,
          )
          .all(...[a.state, a.kind].filter(Boolean))
          .map((r) => r.id),
        a,
      );
      return {
        ...page,
        items: page.items.map((id) => store.get("operation", id)),
      };
    },
  );
  add(
    "sync_source",
    "POST",
    "/sources/:id/sync",
    "同步来源配置和新增调用记录，不触发模型请求",
    {
      id: text,
      requestId: text,
      scope: z.enum(["all", "inventory", "calls"]).default("all"),
      previewId: text.optional(),
    },
    ({ id, ...a }) => operations.start("sync", { ...a, sourceId: id }),
    true,
    { accepted: true },
  );
  add(
    "maintenance_status",
    "GET",
    "/maintenance",
    "扫描、验证预算和逐渠道等待原因",
    {},
    () => maintenance.summary(),
  );
  add(
    "maintain_channels",
    "POST",
    "/maintenance/runs",
    "扫描渠道并按策略安排任务验证与恢复",
    {
      requestId: text,
      channelIds: z.array(text).min(1).optional(),
      siteIds: z.array(text).min(1).optional(),
    },
    (a) => operations.start("maintain", a),
    true,
    { accepted: true },
  );
  add(
    "scan_models",
    "POST",
    "/scans",
    "批量扫描目录、站方模型表现和 key 可见模型，遵守禁止测活标签",
    {
      requestId: text,
      channelIds: z.array(text).min(1).optional(),
      siteIds: z.array(text).min(1).optional(),
    },
    (a) => operations.start("scan", a),
    true,
    { accepted: true },
  );
  add(
    "scan_candidates",
    "GET",
    "/channels/:id/candidates",
    "查看扫描后的任务验证候选",
    { id: text },
    ({ id }) => ({ items: scans.candidates(id) }),
  );
  add(
    "evaluate",
    "POST",
    "/evaluations",
    "安排已有 cron 或明确启用的小任务验证",
    {
      requestId: text,
      channelId: text,
      modelId: text,
      taskRef: taskRef.optional(),
      bindingId: text.optional(),
      executionMode: z.enum(["preview", "scheduled"]).optional(),
    },
    (a) => {
      evaluations.offering(a.channelId, a.modelId);
      const bound =
        !a.taskRef &&
        maintenance.taskFor(store.require("channel", a.channelId), a.modelId);
      return operations.start("evaluate", {
        ...a,
        ...(bound
          ? {
              taskRef: bound.taskRef,
              bindingId: bound.id,
              executionMode: bound.validationOnly ? "preview" : "scheduled",
            }
          : {}),
      });
    },
    true,
    { accepted: true },
  );
  add(
    "apply_channel",
    "POST",
    "/channels/:id/apply",
    "将已验证模型应用到 New API 并回读",
    { id: text, modelId: text, requestId: text },
    ({ id, modelId, requestId }) =>
      operations.start("apply", { requestId, offeringId: `${id}:${modelId}` }),
    true,
    { accepted: true },
  );
  add(
    "resolve_channel",
    "POST",
    "/channels/:id/resolve",
    "处理具体模型的网关配置差异",
    {
      id: text,
      modelId: text,
      choice: z.enum(["external", "center"]),
      requestId: text,
    },
    async ({ id, modelId, choice, requestId }) => {
      const o = store.require("offering", `${id}:${modelId}`);
      if (o.apply?.state !== "conflict")
        throw new Problem(409, "当前没有待处理配置冲突");
      if (choice === "center")
        return operations.start("apply", {
          requestId,
          offeringId: o.id,
          force: true,
        });
      return gateway.acceptExternal(o);
    },
    true,
  );
  add(
    "list_tasks",
    "GET",
    "/cron/tasks",
    "原调度层任务目录，不复制正文和投递配置",
    listing,
    (a) => paginate(store.list("task"), a),
  );
  add(
    "list_bindings",
    "GET",
    "/cron/bindings",
    "现有任务的资源绑定",
    listing,
    (a) => paginate(store.list("binding"), a),
  );
  add(
    "list_task_runs",
    "GET",
    "/cron/runs",
    "任务预览、验收与请求关联；不返回正文",
    listing,
    (a) => paginate(store.list("run").reverse(), a),
  );
  const bindingFields = {
    taskRef,
    channelId: text,
    modelId: text,
    enabled: z.boolean(),
    unavailable: z.enum(["original", "skip"]),
    capabilityClass: z.enum(["strong", "execution", "unclassified"]),
    discoverNewModels: z.boolean(),
    validationOnly: z.boolean(),
  };
  const binding = z
    .object({
      ...bindingFields,
      enabled: bindingFields.enabled.default(true),
      unavailable: bindingFields.unavailable.default("original"),
      capabilityClass: bindingFields.capabilityClass.default("unclassified"),
      discoverNewModels: bindingFields.discoverNewModels.default(false),
      validationOnly: bindingFields.validationOnly.default(false),
    })
    .strict();
  const checkBinding = (b) => {
    const task = evaluations.task(b.taskRef);
    if (
      b.enabled &&
      (!task.enabled || !task.supportsRunConfig || !task.supportsResult)
    )
      throw new Problem(409, "任务尚未适配或原任务暂停，请先保存为停用绑定");
    if (
      b.enabled &&
      !b.validationOnly &&
      task.supportsScheduledRunConfig === false
    )
      throw new Problem(409, "该任务目前仅支持验证预览，不能绑定正式运行");
    const blocked = taskBlock(store.require("channel", b.channelId), task);
    if (blocked) throw new Problem(409, blocked);
    evaluations.offering(b.channelId, b.modelId);
  };
  add(
    "create_binding",
    "POST",
    "/cron/bindings",
    "绑定已有任务，不运行或恢复任务",
    { data: binding },
    ({ data }) => {
      checkBinding(data);
      const existing = store
        .list("binding")
        .find(
          (b) =>
            b.channelId === data.channelId &&
            b.modelId === data.modelId &&
            b.taskRef.source === data.taskRef.source &&
            b.taskRef.id === data.taskRef.id &&
            !!b.validationOnly === data.validationOnly,
        );
      return existing
        ? store.update("binding", existing.id, existing.version, data)
        : store.put("binding", { id: randomUUID(), ...data });
    },
    true,
  );
  add(
    "update_binding",
    "PATCH",
    "/cron/bindings/:id",
    "修改任务资源绑定，保留原计划",
    { id: text, version, changes: z.object(bindingFields).partial().strict() },
    ({ id, version, changes }) => {
      checkBinding({ ...store.require("binding", id), ...changes });
      return store.update("binding", id, version, changes);
    },
    true,
  );
  return all;
}
