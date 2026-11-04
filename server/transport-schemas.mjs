import { hubInventorySchema, hubCredentialsSchema } from "./hub-ingest.mjs";
import { z } from "zod";
import { accountEvent } from "./ingest.mjs";
import { rpInventorySchema, rpSaveSchema, rpCredentialSchema, rpArchiveSchema, rpResolveSchema, rpCallSchema } from "./rp-sync.mjs";
export const accessSchema = z.object({
  role: z.enum(["read", "manage", "ingest", "cron", "rp", "connector"]),
  sourceId: z.string().optional(), channelIds: z.array(z.string()).optional(),
  rpInstanceId: z.string().min(1).max(160).optional(), rpUserId: z.string().min(1).max(160).optional(), rpRegistration: z.boolean().optional(),
  target: z.enum(["all-api-hub", "chrome-bookmarks", "sillytavern"]).optional(),
});

export const taskCatalogSchema = z
  .object({
    tasks: z.array(
      z
        .object({
          id: z.string(),
          name: z.string(),
          enabled: z.boolean(),
          schedule: z.unknown().optional(),
          timezone: z.string().optional(),
          supportsRunConfig: z.boolean(),
          supportsResult: z.boolean(),
          supportsPreview: z.boolean().optional(),
          supportsScheduledRunConfig: z.boolean().optional(),
          purpose: z.enum(["code", "chat", "other"]).optional(),
          client: z.string().optional(),
          nsfw: z.boolean().optional(),
          capabilityClass: z
            .enum(["strong", "execution", "unclassified"])
            .optional(),
        })
        .strict(),
    ),
  })
  .strict();
export const prepareSchema = z
  .object({
    taskId: z.string().min(1),
    runId: z.string().min(1),
    bindingId: z.string().optional(),
    executionMode: z.enum(["preview", "scheduled"]).default("scheduled"),
  })
  .strict();
export const taskResultSchema = z
  .object({
    runId: z.string(),
    actualChannelId: z.string(),
    actualModelId: z.string(),
    result: z.enum(["success", "failure", "cancelled", "unknown"]),
    occurredAt: z.iso.datetime(),
    usedFallback: z.boolean().default(false),
    acceptance: z.enum(["passed", "failed", "unknown"]).optional(),
    capabilityClass: z.enum(["strong", "execution", "unclassified"]).optional(),
    requestId: z.string().optional(),
    artifactRef: z.string().max(500).optional(),
    errorSummary: z.string().max(400).optional(),
    materialDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    acceptanceChecks: z.record(z.string(), z.boolean()).optional(),
    errorType: z
      .enum([
        "rate",
        "quota",
        "key",
        "account",
        "input",
        "cancelled",
        "upstream",
      ])
      .optional(),
    latencyMs: z.number().nonnegative().optional(),
  })
  .strict();
export const ingestSchema = z
  .object({
    source: z.string().optional(),
    events: z.array(accountEvent).min(1).max(200),
  })
  .strict();

export const connectorReceiptSchema = z
  .object({
    id: z.string(),
    lease: z.string(),
    state: z.enum(["applied", "failed", "waiting", "conflict"]),
    remoteId: z.string().optional(),
    snapshot: z.record(z.string(), z.unknown()).nullable().optional(),
    reason: z.string().max(400).optional(),
  })
  .strict();
const identified = z
  .object({ id: z.string(), version: z.number().int() })
  .loose();
const paged = (item) =>
  z.object({ items: z.array(item), nextCursor: z.string().nullable() }).loose();
const channel = identified.extend({
  siteId: z.string(),
  accountId: z.string(),
  name: z.string(),
  baseUrl: z.string(),
  purpose: z.enum(["general", "media", "rp", "client"]),
  usage: z.enum(["general", "image", "video", "rp"]),
  archiveReasons: z.array(z.string()),
  models: z.array(z.string()),
  tags: z.array(z.string()),
  capabilities: z.array(z.string()),
  applications: z.array(z.string()),
  probeAllowed: z.boolean(),
  recovery: z.object({ pending: z.boolean(), state: z.string() }).loose(),
  credentialStatus: z.string(),
});
const site = identified.extend({
  name: z.string(),
  websiteUrl: z.string(),
  accounts: z.array(identified),
  channels: z.array(channel),
});
const operation = identified.extend({
  kind: z.string(),
  state: z.enum([
    "queued",
    "running",
    "waiting",
    "succeeded",
    "failed",
    "cancelled",
  ]),
  stage: z.string(),
});
export const outputs = {
  resource_list_checkins: z.object({
    items: z.array(z.object({
      id: z.string(), accountId: z.string(), executorAccountId: z.string(),
      siteId: z.string(), businessDate: z.string(), timezone: z.string(),
      occurredAt: z.string(), latestResult: z.string(), confirmed: z.boolean(),
      confirmedAt: z.string().nullable(), rewardText: z.string().nullable(), reward: z.null(),
    }).loose()),
    nextCursor: z.string().nullable(),
    coverage: z.object({ startDate: z.string(), endDate: z.string(), timezone: z.string(),
      firstRecordedDate: z.string().nullable(), lastRecordedDate: z.string().nullable(),
      complete: z.boolean(), unresolvedAccounts: z.number().int(), basis: z.string() }),
  }),
  resource_list_sites: paged(site),
  resource_get_site: site,
  resource_list_models: paged(
    z
      .object({
        channelId: z.string(),
        siteId: z.string(),
        modelId: z.string(),
        purpose: z.string(),
        capabilityClass: z.string(),
      })
      .loose(),
  ),
  resource_get_operation: operation,
  resource_list_operations: paged(operation),
  resource_list_sources: z.object({
    items: z.array(
      z
        .object({
          id: z.string(),
          kind: z.string(),
          url: z.string().nullable(),
          credentialStatus: z.string(),
        })
        .loose(),
    ),
  }),
};
export const transportRoutes = [
  ["GET", "/api/v2/ingest/checkin-policy", z.object({}), "读取本来源账号的签到归档与复查策略"],
  ["GET", "/api/v2/rp/identity", z.object({}), "核对配对的来源、实例与酒馆用户"],
  ["POST", "/api/v2/access", accessSchema, "管理员签发来源或实例与用户受限的接入凭据"],
  ["POST", "/api/v2/rp/inventory", rpInventorySchema, "登记配对实例与用户的已保存连接"],
  ["POST", "/api/v2/rp/saves", rpSaveSchema, "上报原生保存及双方配置基线"],
  ["POST", "/api/v2/rp/credentials", rpCredentialSchema, "独立交付原生连接凭据"],
  ["POST", "/api/v2/rp/archive", rpArchiveSchema, "按不可用原因归档已授权连接"],
  ["POST", "/api/v2/rp/resolve", rpResolveSchema, "处理已授权连接的配置冲突"],
  ["POST", "/api/v2/ingest/rp-calls", rpCallSchema, "接收请求归属和真实调用终态"],
  [
    "GET",
    "/api/v2/connector/jobs",
    z.object({}),
    "领取绑定目标的配置任务；使用独立 connector 凭据",
  ],
  [
    "POST",
    "/api/v2/connector/receipts",
    connectorReceiptSchema,
    "回报配置实际应用结果；按任务与租约幂等",
  ],
  [
    "POST",
    "/api/v2/ingest/inventory",
    hubInventorySchema,
    "接收插件账号清单和余额观察",
  ],
  [
    "POST",
    "/api/v2/ingest/credentials",
    hubCredentialsSchema,
    "接收来源所属的调用 key，加密保存",
  ],
  [
    "POST",
    "/api/v2/session",
    z.object({ password: z.string() }),
    "建立 WebUI 管理会话",
  ],
  ["POST", "/api/v2/ingest/events", ingestSchema, "接收来源账号和签到事件"],
  ["POST", "/api/v2/cron/tasks", taskCatalogSchema, "接收现有调度层任务目录"],
  [
    "GET",
    "/api/v2/cron/verification-jobs",
    z.object({}),
    "领取本来源已绑定的草稿验证，不修改正式计划",
  ],
  [
    "POST",
    "/api/v2/cron/runs/prepare",
    prepareSchema,
    "取得本次运行的资源配置，只供受限任务适配器",
  ],
  [
    "POST",
    "/api/v2/ingest/task-results",
    taskResultSchema,
    "接收单次任务终态及验收结果",
  ],
];
