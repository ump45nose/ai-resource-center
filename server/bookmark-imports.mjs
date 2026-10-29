import { randomUUID } from "node:crypto";
import { z } from "zod";
import { nextReset } from "./domain.mjs";
import { Problem } from "./errors.mjs";

const url = z
  .url()
  .refine((u) => ["https:", "http:"].includes(new URL(u).protocol));
export const bookmarkInventorySchema = z
  .object({
    deviceId: z.string().min(1),
    items: z
      .array(
        z
          .object({
            bookmarkId: z.string(),
            title: z.string(),
            url,
            usage: z.enum(["rp", "image"]),
            path: z.array(z.string()),
          })
          .strict(),
      )
      .max(1000),
  })
  .strict();
export const bookmarkOutcomeSchema = z
  .object({
    state: z.enum([
      "imported",
      "needs_model",
      "waiting_login",
      "waiting_security",
      "unsupported",
      "failed",
    ]),
    accountExternalId: z.string().optional(),
    reason: z.string().max(500).optional(),
    api: z
      .object({
        available: z.boolean(),
        reason: z.string().max(500).optional(),
      })
      .optional(),
  })
  .strict();
export function hasBookmarkWork(store, now = Date.now()) {
  return store
    .list("bookmark-import")
    .some(
      (j) =>
        ([
          "needs_model",
          "failed",
          "waiting_login",
          "waiting_security",
        ].includes(j.state) &&
          (!j.nextAttemptAt || Date.parse(j.nextAttemptAt) <= now)) ||
        (j.state === "model_running" && Date.parse(j.leaseUntil) < now),
    );
}
export class BookmarkImports {
  constructor(store, resources) {
    Object.assign(this, { store, resources });
    this.reconcileWebAccounts();
  }
  reconcileWebAccounts() {
    for (const job of this.store.list("bookmark-import")) {
      if (job.api?.available !== false || !job.channelId) continue;
      const channel = this.store.get("channel", job.channelId);
      if (
        !channel ||
        channel.credentialId ||
        channel.curation?.updatedAt ||
        channel.accessMode === "web"
      )
        continue;
      if (
        channel.bookmarkImportId !== job.id &&
        channel.source !== "chrome-bookmarks"
      )
        continue;
      this.store.put("channel", {
        ...channel,
        accessMode: "web",
        gatewayAllowed: false,
        version: channel.version + 1,
      });
    }
  }
  ingest(source, input) {
    const at = new Date().toISOString();
    for (const item of input.items) {
      const origin = new URL(item.url).origin;
      const ref = `${input.deviceId}:${item.bookmarkId}`;
      const oldId = this.store.ref(source, "bookmark-import", ref);
      const old = oldId && this.store.get("bookmark-import", oldId);
      if (old && old.origin === origin && old.usage === item.usage) continue;
      const site = this.store.list("site").find(
        (s) =>
          !s.mergedInto &&
          [s.url, ...(s.aliases || [])].some((u) => {
            try {
              return new URL(u).origin === origin;
            } catch {
              return false;
            }
          }),
      );
      // Existing curated resources are a baseline, not inputs to re-import.
      const known =
        site &&
        this.store
          .list("channel")
          .some((c) => c.siteId === site.id && !c.mergedInto);
      const same = this.store
        .list("bookmark-import")
        .find((j) => j.origin === origin && j.usage === item.usage);
      const row =
        same ||
        this.store.put("bookmark-import", {
          id: randomUUID(),
          ...item,
          origin,
          source,
          deviceId: input.deviceId,
          state:
            known || site?.removed || site?.resourceExcluded
              ? "existing"
              : "pending_native",
          siteId: site?.id,
          createdAt: at,
          updatedAt: at,
          attempts: 0,
          reason: known ? "沿用中心已有整理结果" : undefined,
        });
      this.store.ref(source, "bookmark-import", ref, row.id);
    }
    this.store.setting(`bookmarkDiscovery:${source}`, {
      at,
      deviceId: input.deviceId,
      count: input.items.length,
    });
    return { acknowledged: true, count: input.items.length };
  }
  jobs() {
    return {
      items: this.store
        .list("bookmark-import")
        .filter((j) =>
          ["pending_native", "recipe_ready", "waiting_sync"].includes(j.state),
        ),
    };
  }
  outcome(id, input) {
    const job = this.store.require("bookmark-import", id);
    // A duplicate browser response does not open a second connection.
    if (["imported", "existing"].includes(job.state)) return job;
    let changes = { ...input, updatedAt: new Date().toISOString() };
    if (input.state === "imported")
      changes.reason =
        input.api?.available === false
          ? "账号及签到规则已导入"
          : "原生账号和调用凭据已关联";
    if (input.state === "imported") {
      if (!input.accountExternalId) throw new Problem(400, "缺少原生账号标识");
      const accountId = this.store.ref(
        "all-api-hub",
        "account",
        input.accountExternalId,
      );
      const account = accountId && this.store.get("account", accountId);
      if (!account) changes.state = "waiting_sync";
      else {
        const site = this.store.require("site", account.siteId);
        if (job.recipe?.balance && account.source === "all-api-hub") {
          const b = job.recipe.balance;
          this.store.put("account", {
            ...account,
            quota: "daily",
            benefit: {
              ...account.benefit,
              tz: b.timezone,
              resetAt: b.resetAt,
              renewal: "checkin",
            },
            ...(account.confirmedAt
              ? {
                  validUntil: nextReset(
                    account.confirmedAt,
                    b.timezone,
                    b.resetAt,
                  ),
                }
              : {}),
          });
        }
        // Reuse the first native account/key record, never replace curated fields.
        let channel = this.store
          .list("channel")
          .find((c) => c.accountId === accountId && !c.mergedInto);
        const key = (account.hubKeys || []).find(
          (k) => k.present !== false && k.credentialId,
        );
        if (!key && !job.recipe) {
          return this.store.put("bookmark-import", {
            ...job,
            ...changes,
            state: "waiting_sync",
            reason: "原生账号已导入，等待调用 key 回传",
            version: job.version + 1,
          });
        }
        if (
          channel &&
          (channel.bookmarkImportId === job.id ||
            (job.channelId === channel.id &&
              channel.source === "chrome-bookmarks")) &&
          key &&
          !channel.credentialId
        )
          channel = this.store.put("channel", {
            ...channel,
            credentialId: key.credentialId,
            protocol: key.protocol,
            credentialState: "present",
            version: channel.version + 1,
          });
        if (!channel)
          channel = this.resources.channel({
            siteId: site.id,
            accountId,
            name: job.title || site.name,
            usage: job.usage,
            baseUrl: key?.baseUrl || job.origin,
            models: [],
            enabled: false,
            source: "chrome-bookmarks",
            bookmarkImportId: job.id,
            tags: job.usage === "rp" ? ["no_probe"] : [],
            ...(key
              ? {
                  credentialId: key.credentialId,
                  protocol: key.protocol,
                  credentialState: "present",
                }
              : {}),
          });
        else if (
          channel.source === "all-api-hub" &&
          !site.curation &&
          !channel.bookmarkImportId
        )
          channel = this.store.put("channel", {
            ...channel,
            usage: job.usage,
            category: job.usage === "rp" ? "rp" : "media",
            capabilities: job.usage === "rp" ? ["text"] : ["image"],
            tags:
              job.usage === "rp"
                ? [...new Set([...(channel.tags || []), "no_probe"])]
                : channel.tags,
            bookmarkImportId: job.id,
            ...(key
              ? {
                  credentialId: key.credentialId,
                  protocol: key.protocol,
                  credentialState: "present",
                }
              : {}),
            version: channel.version + 1,
          });
        if (input.api?.available === false || job.api?.available === false) {
          channel = this.store.put("channel", {
            ...channel,
            accessMode: "web",
            gatewayAllowed: false,
            version: channel.version + 1,
          });
        }
        changes = {
          ...changes,
          siteId: site.id,
          accountId,
          channelId: channel.id,
        };
        this.resources.onChange?.();
      }
    }
    return this.store.put("bookmark-import", {
      ...job,
      ...changes,
      version: job.version + 1,
    });
  }
  claim(source, runId, limit = 3) {
    const items = [];
    for (const job of this.store.list("bookmark-import")) {
      if (items.length >= limit) break;
      if (job.state === "model_running" && job.runId === runId) {
        items.push(job);
        continue;
      }
      const due =
        !job.nextAttemptAt || Date.parse(job.nextAttemptAt) <= Date.now();
      const expired =
        job.state === "model_running" &&
        Date.parse(job.leaseUntil) < Date.now();
      if (
        (!due ||
          ![
            "needs_model",
            "failed",
            "waiting_login",
            "waiting_security",
          ].includes(job.state)) &&
        !expired
      )
        continue;
      items.push(
        this.store.put("bookmark-import", {
          ...job,
          state: "model_running",
          runId,
          workerSource: source,
          attempts: job.attempts + 1,
          updatedAt: new Date().toISOString(),
          leaseUntil: new Date(Date.now() + 30 * 60000).toISOString(),
        }),
      );
    }
    return { items };
  }
  finish(id, source, runId, changes) {
    const job = this.store.require("bookmark-import", id);
    if (job.workerSource !== source || job.runId !== runId)
      throw new Problem(409, "任务已由其他运行接管");
    if (changes.recipe && job.usage !== "image")
      throw new Problem(400, "酒馆连接不配置生图签到规则");
    return this.store.put("bookmark-import", {
      ...job,
      ...changes,
      state: changes.recipe ? "recipe_ready" : changes.state,
      nextAttemptAt: nextReset(new Date(), "Asia/Taipei", "00:00"),
      updatedAt: new Date().toISOString(),
      version: job.version + 1,
    });
  }
}
