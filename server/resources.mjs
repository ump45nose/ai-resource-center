import {
  policies,
  entitlement,
  maintenanceStatus,
} from "./maintenance-policy.mjs";
export { defaults, policies, entitlement } from "./maintenance-policy.mjs";
import { randomUUID } from "node:crypto";
import { Problem, publicValue } from "./errors.mjs";
import { normalizeUrl, canonicalApi, dayKey } from "./domain.mjs";
import { dailyResources } from "./checkins.mjs";
import {
  linkCheckinAccounts,
  archiveDepletedAccounts,
  automaticCheckin,
} from "./account-state.mjs";
import {
  tagsOf,
  capabilitiesOf,
  applicationsOf,
  isInternal,
  validateTags,
  probeBlock,
  legacyTags,
  usageOf,
  archiveOf,
  gatewayBlock,
  archiveLabels,
} from "./channel-rules.mjs";

export const removed = (c) =>
  c.availability === "已移除" || c.management?.state === "removed";
export const purpose = (c) => c.category || "general";
export function paginate(rows, { cursor = "0", limit = 50 } = {}) {
  const offset = Number(cursor),
    size = Number(limit);
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(size) ||
    size < 1 ||
    size > 200
  )
    throw new Problem(400, "分页参数不合法");
  return {
    items: rows.slice(offset, offset + size),
    nextCursor: offset + size < rows.length ? String(offset + size) : null,
  };
}

export function eligible(store, c, { media = false } = {}) {
  return !probeBlock(store, c) && (media || capabilitiesOf(c).includes("text"));
}

export class Resources {
  constructor(store) {
    this.store = store;
  }
  reconcileAccountState(accountIds = []) {
    const linked = linkCheckinAccounts(this.store);
    const archived = archiveDepletedAccounts(this.store, accountIds);
    if (linked.length || archived.length) this.onChange?.();
    return { linked, archived };
  }
  site(input, source = "manual") {
    const url = normalizeUrl(input.websiteUrl || input.url);
    if (!["http:", "https:"].includes(new URL(url).protocol))
      throw new Problem(400, "站点需要 HTTP(S) 地址");
    const sites = this.store
      .list("site")
      .filter((s) => !s.mergedInto && (source !== "manual" || !s.removed));
    let matches = sites.filter((s) =>
      [s.url, ...(s.aliases || [])].some((u) => normalizeUrl(u) === url),
    );
    if (!matches.length)
      matches = sites.filter((s) =>
        [s.url, ...(s.aliases || [])].some(
          (u) =>
            /^https?:/.test(u) && new URL(u).origin === new URL(url).origin,
        ),
      );
    if (matches.length > 1)
      throw new Problem(409, "站点存在多个关联，请确认归属");
    if (matches[0]) {
      const old = matches[0];
      const aliases = [
        ...new Set([...(old.aliases || []), ...(old.url !== url ? [url] : [])]),
      ];
      const sources = [...new Set([...(old.sources || []), source])];
      if (
        aliases.length === (old.aliases || []).length &&
        sources.length === (old.sources || []).length
      )
        return old;
      return this.store.put("site", {
        ...old,
        aliases,
        sources,
        version: old.version + 1,
      });
    }
    return this.store.put("site", {
      id: randomUUID(),
      name: input.name || new URL(url).host,
      url,
      checkinUrl: input.checkinUrl,
      aliases: input.aliases || [],
      sources: [source],
      pinned: false,
    });
  }
  channel(input) {
    this.store.require("site", input.siteId);
    const account = this.store.require("account", input.accountId);
    if (account.siteId !== input.siteId)
      throw new Problem(400, "账号不属于该站点");
    return this.store.put("channel", {
      id: randomUUID(),
      name: input.name,
      category: input.usage
        ? input.usage === "rp"
          ? "rp"
          : ["image", "video"].includes(input.usage)
            ? "media"
            : "general"
        : input.purpose || "general",
      curation: { authority: "center" },
      protocol: "OpenAI",
      authType: "bearer",
      models: [],
      headers: [],
      bindings: [],
      enabled: false,
      mode: "manual",
      priority: 0,
      weight: 100,
      ...input,
      baseUrl: canonicalApi(input.baseUrl, input.protocol),
      tags: validateTags(
        input.tags ?? legacyTags({ category: input.purpose, ...input }),
      ),
      usage: usageOf({ category: input.purpose, ...input }),
      capabilities:
        input.capabilities ??
        capabilitiesOf({ category: input.purpose, ...input }),
    });
  }
  update(kind, id, version, changes) {
    const old = this.store.require(kind, id);
    if (old.version !== version)
      throw new Problem(
        409,
        "资料已被修改，请读取最新版本",
        { currentVersion: old.version },
        "version_conflict",
      );
    if (["site", "channel"].includes(kind))
      changes.curation = {
        ...old.curation,
        authority: "center",
        updatedAt: new Date().toISOString(),
      };
    if (kind === "account" && changes.benefit)
      changes.benefit = { ...old.benefit, ...changes.benefit };
    if (
      kind === "account" &&
      old.checkinAccountId &&
      Object.hasOwn(changes, "checkinEnabled")
    ) {
      const executor = this.store.require("account", old.checkinAccountId);
      this.store.update("account", executor.id, executor.version, {
        checkinEnabled: changes.checkinEnabled,
      });
    }
    if (kind === "channel" && changes.management)
      changes.management = { ...old.management, ...changes.management };
    if (kind === "channel") {
      if (Object.hasOwn(changes, "headers"))
        changes.headersManagedBy = "manual";
      if (changes.tags) {
        changes.tags = validateTags(changes.tags);
        changes.tagHistory = [
          ...(old.tagHistory || []),
          {
            tags: changes.tags,
            source: "人工修改",
            at: new Date().toISOString(),
          },
        ];
      }
      const account = this.store.require(
        "account",
        changes.accountId || old.accountId,
      );
      if (changes.accountId && changes.accountId !== old.accountId) {
        if (old.credentialId) {
          const a = this.store.require("account", old.accountId);
          this.store.put("account", {
            ...a,
            managedCredentials: [
              ...(a.managedCredentials || []),
              {
                id: randomUUID(),
                name: old.name,
                credentialId: old.credentialId,
              },
            ],
          });
        }
        changes.credentialId = null;
        changes.nativeCredentialRef = null;
        changes.credentialHeadersId = null;
        changes.credentialState = "missing_key";
        changes.connectionVersion = (old.connectionVersion || 1) + 1;
      }

      if (account.siteId !== (changes.siteId || old.siteId))
        throw new Problem(400, "渠道账号不属于目标站点");
      if (changes.baseUrl)
        changes.baseUrl = canonicalApi(
          changes.baseUrl,
          changes.protocol || old.protocol,
        );
      if (
        ["baseUrl", "protocol", "headers"].some(
          (key) =>
            Object.hasOwn(changes, key) &&
            JSON.stringify(changes[key]) !==
              JSON.stringify(old[key] || (key === "headers" ? [] : undefined)),
        )
      ) {
        changes.connectionVersion = (old.connectionVersion || 1) + 1;
        changes.connectionChangedAt = new Date().toISOString();
        for (const o of this.store
          .list("offering")
          .filter((o) => o.channelId === id))
          this.store.put("offering", { ...o, verification: null });
      }
    }
    if (kind === "site" && changes.websiteUrl) {
      changes.url = normalizeUrl(changes.websiteUrl);
      delete changes.websiteUrl;
    }
    if (kind === "channel" && changes.purpose) {
      changes.category = changes.purpose;
      changes.usage ??= usageOf({
        ...old,
        usage: undefined,
        category: changes.purpose,
      });
      changes.tags ??= validateTags([
        ...tagsOf(old),
        ...legacyTags({
          category: changes.purpose,
          client: changes.client || old.client,
        }),
      ]);
      delete changes.purpose;
    }
    if (kind === "channel" && changes.usage)
      changes.category =
        changes.usage === "rp"
          ? "rp"
          : ["image", "video"].includes(changes.usage)
            ? "media"
            : "general";
    if (kind === "channel" && Object.hasOwn(changes, "mode"))
      changes.management = {
        ...old.management,
        ...changes.management,
        manualOnly: changes.mode === "manual",
      };
    if (kind === "channel" && changes.baseUrl)
      changes.baseUrl = canonicalApi(
        changes.baseUrl,
        changes.protocol || this.store.require(kind, id).protocol,
      );
    const saved = this.store.update(kind, id, version, changes);
    if (kind === "account" && changes.checkinEnabled === false)
      this.reconcileAccountState([id]);
    this.onChange?.();
    return kind === "channel" ? this.publicChannel(saved) : publicValue(saved);
  }
  saveCredential(id, version, key) {
    const c = this.store.require("channel", id);
    if (c.version !== version)
      throw new Problem(409, "渠道已更新，请读取最新版本");
    const credentialId = this.store.secret(key),
      a = this.store.require("account", c.accountId);
    this.store.put("account", {
      ...a,
      managedCredentials: [
        ...(a.managedCredentials || []),
        {
          id: randomUUID(),
          name: `${c.name} · ${new Date().toLocaleDateString("zh-CN")}`,
          credentialId,
          createdAt: new Date().toISOString(),
        },
      ],
    });
    for (const o of this.store
      .list("offering")
      .filter((o) => o.channelId === id))
      this.store.put("offering", { ...o, verification: null });
    const saved = this.store.update("channel", id, version, {
      credentialId,
      credentialState: "present",
      credentialChangedAt: new Date().toISOString(),
      connectionVersion: (c.connectionVersion || 1) + 1,
    });
    this.onChange?.();
    return this.publicChannel(saved);
  }
  credentialChoices(id) {
    const c = this.store.require("channel", id),
      a = this.store.require("account", c.accountId);
    const choices = [
      ...(a.managedCredentials || []).map((k) => ({
        id: `saved:${k.id}`,
        name: k.name,
        credentialId: k.credentialId,
      })),
      ...this.store
        .list("channel")
        .filter((x) => x.accountId === c.accountId && x.credentialId)
        .map((x) => ({
          id: `channel:${x.id}`,
          name: x.name,
          credentialId: x.credentialId,
        })),
      ...(a.hubKeys || [])
        .filter((k) => k.credentialId && k.present !== false)
        .map((k) => ({
          id: `hub:${k.id || k.externalId}`,
          name: k.name || "插件调用 key",
          credentialId: k.credentialId,
        })),
    ];
    return choices.filter(
      (x, i, all) =>
        all.findIndex((y) => y.credentialId === x.credentialId) === i,
    );
  }
  selectCredential(id, version, choiceId) {
    const choice = this.credentialChoices(id).find((x) => x.id === choiceId);
    if (!choice) throw new Problem(400, "请选择该账号已经保存的调用 key");
    const c = this.store.require("channel", id);
    if (c.version !== version) throw new Problem(409, "资料已更新，请重新读取");
    for (const o of this.store
      .list("offering")
      .filter((o) => o.channelId === id))
      this.store.put("offering", { ...o, verification: null });
    const saved = this.store.update("channel", id, version, {
      credentialId: choice.credentialId,
      credentialState: "present",
      credentialChangedAt: new Date().toISOString(),
      connectionVersion: (c.connectionVersion || 1) + 1,
    });
    this.onChange?.();
    return this.publicChannel(saved);
  }
  lifecycle(id, version, action, reason, note, recoveryEnabled) {
    const c = this.store.require("channel", id);
    let changes;
    if (action === "archive")
      changes = {
        archiveReason: reason,
        availability: archiveLabels[reason],
        archiveNote: note || "",
        archivedAt: new Date().toISOString(),
        enabled: false,
        management: { ...c.management, state: "maintenance" },
        recoveryPolicy: {
          ...c.recoveryPolicy,
          enabled: recoveryEnabled !== false,
        },
      };
    else if (action === "pause")
      changes = {
        enabled: false,
        management: { ...c.management, state: "paused" },
      };
    else if (action === "remove")
      changes = {
        enabled: false,
        availability: "已移除",
        management: { ...c.management, state: "removed" },
        recoveryPolicy: { ...c.recoveryPolicy, enabled: false },
      };
    else if (action === "review") {
      if (removed(c)) throw new Problem(409, "永久移除的渠道不能自动恢复");
      changes = {
        enabled: false,
        management: { ...c.management, state: "maintenance" },
        recoveryPolicy: { ...c.recoveryPolicy, enabled: true },
        maintenance: {
          ...c.maintenance,
          lastScanAttemptAt: null,
          validationScanAt: null,
        },
      };
    } else if (action === "resume") {
      if (c.management?.state !== "paused")
        throw new Problem(409, "当前渠道不是人工暂停状态");
      const archived = archiveOf(c).length > 0;
      changes = {
        enabled: !archived,
        management: {
          ...c.management,
          state: archived ? "maintenance" : "active",
        },
        ...(/^人工暂停$/.test(c.availability || "")
          ? { availability: null }
          : {}),
      };
    } else throw new Problem(400, "未知管理操作");
    return this.update("channel", id, version, changes);
  }
  snapshot() {
    return {
      sites: this.store.list("site"),
      accounts: this.store.list("account"),
      channels: this.store.list("channel"),
      offerings: this.store.list("offering"),
      evaluations: this.store.list("evaluation"),
      scans: this.store.list("modelScan"),
    };
  }
  publicChannel(c, data = this.snapshot()) {
    const blocked = probeBlock(this.store, c, data.channels);
    const archiveReasons = archiveOf(
      c,
      data.sites.find((s) => s.id === c.siteId),
    );
    const recovery = maintenanceStatus(this.store, c, { blocked });
    const stats = this.store.db
      .prepare(
        "SELECT count(*) total, sum(result='success') success, sum(result='failure') failure, max(occurred_at) lastAt FROM calls WHERE channel_id=?",
      )
      .get(c.id);
    const verification = data.offerings.filter((x) => x.channelId === c.id);
    return {
      ...publicValue(c),
      synchronization: this.distribution?.channelStatus(c.id) || [],
      runtimeEnabled: this.distribution?.runtimeEnabled(c) ?? null,
      piAudit: undefined,
      nativeAudit: undefined,
      imageAudit: undefined,
      videoAudit: undefined,
      purpose: purpose(c),
      usage: usageOf(c),
      archiveReasons,
      gatewayBlockedReason: gatewayBlock(c),
      tags: tagsOf(c),
      capabilities: capabilitiesOf(c),
      applications: applicationsOf(c),
      probeAllowed: !blocked,
      probeBlockedReason: blocked,
      recovery: {
        ...recovery,
        pending: recovery.pending || archiveReasons.length > 0,
        reason:
          recovery.reason ||
          archiveReasons.map((r) => archiveLabels[r]).join("、"),
      },
      credentialStatus: c.credentialId
        ? "present"
        : c.nativeCredentialRef
          ? "native_only"
          : c.gateway && c.gateway.sourceId !== "cpa"
            ? "gateway_only"
            : "missing",
      credentialCheckState: c.credentialState || null,
      modelAvailability: verification,
      historicalEvaluations: this.evaluations(c.id, undefined, data),
      calls: stats,
      scan: this.scanObservation(c, data),
    };
  }
  scanObservation(c, data) {
    const scans = (data?.scans || this.store.list("modelScan"))
      .filter((s) => s.channelCatalogs?.some((r) => r.channelId === c.id))
      .sort((a, b) => b.scannedAt.localeCompare(a.scannedAt));
    const scan = scans[0];
    if (!scan) return null;
    const catalog = scan.channelCatalogs.find((r) => r.channelId === c.id);
    return {
      scannedAt: scan.scannedAt,
      catalogStatus: catalog.status,
      catalogModels: catalog.models || [],
      websiteStatus: scan.website?.status || null,
      metricCount: scan.metrics?.length || 0,
    };
  }
  evaluations(channelId, modelId, data) {
    return (data?.evaluations || this.store.list("evaluation"))
      .filter(
        (e) =>
          (!channelId || e.channelId === channelId) &&
          (!modelId || e.model === modelId),
      )
      .map((e) => ({
        id: e.id,
        channelId: e.channelId,
        modelId: e.model,
        client: e.client,
        state: e.state,
        startedAt: e.startedAt || e.preparedAt,
        endedAt: e.endedAt,
        rating: e.rating,
        records: e.records,
        piAudit: e.piAudit
          ? {
              rounds: e.piAudit.rounds,
              complete: e.piAudit.complete,
              svg: e.piAudit.svg,
              seconds: e.piAudit.seconds,
              visualReviewed: e.piAudit.visualReviewed,
            }
          : undefined,
        image: e.image
          ? { file: e.image.file, width: e.image.width, height: e.image.height }
          : undefined,
        origin: "legacy",
        countsTowardCurrentGrade: false,
      }));
  }
  detail(id, data = this.snapshot()) {
    const site = data.sites.find((s) => s.id === id);
    if (!site) throw new Problem(404, "站点不存在");
    const accounts = data.accounts
      .filter((a) => a.siteId === id && !a.mergedInto && a.role !== "checkin")
      .map((a) => {
        const rights = entitlement(a);
        const executor = a.checkinAccountId
          ? data.accounts.find((x) => x.id === a.checkinAccountId)
          : a;
        const checkins = this.store.db
          .prepare(
            "SELECT occurred_at,business_date,data FROM events WHERE account_id=? AND json_extract(data,'$.kind')='checkin' ORDER BY occurred_at DESC LIMIT 30",
          )
          .all(executor.id)
          .map((e) => ({
            ...JSON.parse(e.data),
            businessDate: e.business_date,
          }));
        return {
          ...publicValue(a),
          ...(rights.balanceBasis === "fixed_daily" ? {balance: rights.balance} : {}),
          automaticCheckin: a.enabled !== false && automaticCheckin(this.store, a),
          integration: this.distribution?.hubEligibility(a),
          entitlement: rights,
          checkins,
          ...(executor.id !== a.id
            ? {
                checkinAccount: {
                  ...publicValue(executor),
                  entitlement: entitlement(executor),
                  checkins,
                },
              }
            : {}),
        };
      });
    return {
      ...publicValue(site),
      websiteUrl: site.url,
      accounts,
      channels: data.channels
        .filter((c) => c.siteId === id && !removed(c) && !isInternal(c))
        .map((c) => this.publicChannel(c, data)),
    };
  }
  sites(query = {}) {
    const q = (query.q || "").toLowerCase();
    const data = this.snapshot();
    const rows = data.sites
      .map((s) => this.detail(s.id, data))
      .filter((s) => {
        if (s.removed || s.resourceExcluded) return false;
        if (!s.channels.length) {
          if (!s.accounts.length) return false;
          if (
            !s.accounts.some(
              (a) =>
                a.enabled !== false &&
                a.sourceObservation?.enabled !== false &&
                a.sourceObservation?.present !== false,
            )
          )
            return false;
          // Account-only sources are visible; retired/removed connections are not
          // brought back as empty sites merely because their history has accounts.
          if (
            data.channels.some(
              (c) => c.siteId === s.id && !c.sourceOnly && !c.mergedInto,
            )
          )
            return false;
        }
        if (query.usage && !s.channels.some((c) => c.usage === query.usage))
          return false;
        if (
          query.archiveReason &&
          !s.channels.some((c) =>
            c.archiveReasons.includes(query.archiveReason),
          )
        )
          return false;
        if (
          query.tag &&
          !s.channels.some((c) =>
            query.tag.split(",").every((tag) => c.tags.includes(tag)),
          )
        )
          return false;
        if (
          query.capability &&
          !s.channels.some((c) => c.capabilities.includes(query.capability))
        )
          return false;
        if (
          query.application &&
          !s.channels.some((c) => c.applications.includes(query.application))
        )
          return false;
        if (
          query.recoveryState &&
          !s.channels.some((c) =>
            query.recoveryState === "pending"
              ? c.recovery.pending
              : c.recovery.state === query.recoveryState,
          )
        )
          return false;
        if (
          query.purpose &&
          !s.channels.some((c) => c.purpose === query.purpose)
        )
          return false;
        if (
          query.status &&
          !s.channels.some(
            (c) =>
              c.availability === query.status ||
              c.lifecycle === query.status ||
              c.credentialStatus === query.status,
          )
        )
          return false;
        return (
          !q ||
          JSON.stringify([
            s.name,
            s.url,
            s.aliases,
            s.channels.map((c) => [c.name, c.models]),
          ])
            .toLowerCase()
            .includes(q)
        );
      })
      .sort(
        (a, b) =>
          Number(b.pinned || 0) - Number(a.pinned || 0) ||
          a.name.localeCompare(b.name),
      );
    return paginate(rows, query);
  }
  models(query = {}) {
    const data = this.snapshot(),
      offerings = data.offerings;
    const rows = data.channels
      .filter((c) => !removed(c) && !isInternal(c) &&
        !this.store.get("site", c.siteId)?.resourceExcluded)
      .flatMap((c) => {
        const scan = this.scanObservation(c, data);
        const names = new Set([
          ...(c.models || []),
          ...(c.hubObservation?.present !== false
            ? c.hubObservation?.models || []
            : []),
          ...(c.sourceObservation?.present !== false
            ? c.sourceObservation?.models || []
            : []),
          ...(scan?.catalogStatus === "ok" ? scan.catalogModels : []),
          ...offerings
            .filter((o) => o.channelId === c.id)
            .map((o) => o.modelId),
        ]);
        return [...names].map((modelId) => {
          const o = offerings.find(
            (o) => o.channelId === c.id && o.modelId === modelId,
          );
          return {
            channelId: c.id,
            siteId: c.siteId,
            name: c.name,
            modelId,
            purpose: purpose(c),
            tags: tagsOf(c),
            capabilities: capabilitiesOf(c),
            applications: applicationsOf(c),
            capabilityClass: o?.capabilityClass || "unclassified",
            ...o,
            account: publicValue(this.store.get("account", c.accountId)),
            gatewayApplied: o?.apply?.state || c.apply || "pending",
            historicalEvaluations: this.evaluations(c.id, modelId, data),
            configured: (
              c.sourceObservation?.models ||
              c.models ||
              []
            ).includes(modelId),
            scan,
          };
        });
      })
      .filter(
        (o) =>
          (!query.q ||
            o.modelId.toLowerCase().includes(query.q.toLowerCase())) &&
          (!query.purpose || o.purpose === query.purpose) &&
          (!query.tag ||
            query.tag.split(",").every((tag) => o.tags.includes(tag))) &&
          (!query.capability || o.capabilities.includes(query.capability)) &&
          (!query.application || o.applications.includes(query.application)) &&
          (!query.capabilityClass ||
            o.capabilityClass === query.capabilityClass) &&
          (!query.availability ||
            o.verification?.result === query.availability),
      );
    return paginate(rows, query);
  }
  attention() {
    const rows = [];
    for (const c of this.store
      .list("channel")
      .filter((c) => !removed(c) && !isInternal(c) &&
        !this.store.get("site", c.siteId)?.resourceExcluded)) {
      const kind =
        !c.credentialId && !c.gateway && !c.nativeCredentialRef
          ? "missing_key"
          : c.credentialState === "authentication_failed"
            ? "authentication_failed"
            : c.credentialState === "invalid"
              ? "invalid_key"
              : c.apply === "diff"
                ? "configuration_conflict"
                : null;
      if (kind)
        rows.push({
          id: `${c.id}:${kind}`,
          siteId: c.siteId,
          channelId: c.id,
          kind,
          title:
            kind === "configuration_conflict"
              ? "配置存在差异"
              : kind === "authentication_failed"
                ? "调用鉴权未通过，请检查 key 或客户端要求"
                : "需要补 key",
          action:
            kind === "configuration_conflict"
              ? "resolve_configuration"
              : kind === "authentication_failed"
                ? "review_connection"
                : "update_credential",
          state:
            this.store.setting(`attention:${c.id}:${kind}`)?.state || "open",
        });
    }
    return rows;
  }
  overview() {
    const channels = this.store
      .list("channel")
      .filter((c) => !removed(c) && !isInternal(c) &&
        !this.store.get("site", c.siteId)?.resourceExcluded);
    const accounts = this.store.list("account");
    return {
      observedAt: new Date().toISOString(),
      sites: this.store.list("site").filter((s) => !s.removed && !s.mergedInto && !s.resourceExcluded).length,
      channels: Object.fromEntries(
        ["general", "media", "rp", "client"].map((p) => [
          p,
          channels.filter((c) => purpose(c) === p).length,
        ]),
      ),
      dailyEntitlements: accounts
        .filter(
          (a) => !a.mergedInto && a.enabled !== false &&
            !this.store.get("site", a.siteId)?.resourceExcluded && entitlement(a).daily,
        )
        .map((a) => ({ accountId: a.id, ...entitlement(a) })),
      checkins: this.store.db
        .prepare(
          "SELECT account_id,data FROM events WHERE business_date=? ORDER BY occurred_at DESC",
        )
        .all(dayKey(new Date()))
        .filter((r) => JSON.parse(r.data).kind === "checkin")
        .map((r) => ({ accountId: r.account_id, ...JSON.parse(r.data) })),
      attention: this.attention(),
      daily: dailyResources(this),
    };
  }
  previewChanges(input) {
    const ids = [...new Set(input.ids)];
    const kind = input.action === "merge_sites" ? "site" : "channel";
    if (
      input.action === "merge_sites" &&
      (!input.targetId || ids.includes(input.targetId))
    )
      throw new Problem(400, "请选择独立的合并目标站点");
    const targets = ids.map((id) => this.store.require(kind, id));
    if (input.targetId)
      targets.push(this.store.require("site", input.targetId));
    const preview = this.store.put("changePreview", {
      id: randomUUID(),
      input: { ...input, ids },
      versions: targets.map((x) => ({ kind, id: x.id, version: x.version })),
      createdAt: new Date().toISOString(),
    });
    return {
      previewId: preview.id,
      action: input.action,
      affected: targets.map((x) => ({
        id: x.id,
        name: x.name,
        version: x.version,
      })),
      accountsKeptSeparate: true,
    };
  }
  applyChanges(previewId, requestId) {
    return this.store.transaction(() => {
      const preview = this.store.require("changePreview", previewId);
      if (preview.applied) return preview.applied;
      for (const x of preview.versions)
        if (this.store.require(x.kind, x.id).version !== x.version)
          throw new Problem(
            409,
            "预览范围已改变，请重新预览",
            undefined,
            "scope_changed",
          );
      const { action, ids, targetId, purpose: category } = preview.input;
      if (action === "merge_sites") {
        const target = this.store.require("site", targetId);
        const merged = ids.map((id) => this.store.require("site", id));
        this.store.put("site", {
          ...target,
          aliases: [
            ...new Set([
              ...(target.aliases || []),
              ...merged.flatMap((s) => [s.url, ...(s.aliases || [])]),
            ]),
          ],
          sources: [
            ...new Set([
              ...(target.sources || []),
              ...merged.flatMap((s) => s.sources || []),
            ]),
          ],
          version: target.version + 1,
        });
        for (const kind of ["account", "channel"])
          for (const x of this.store
            .list(kind)
            .filter((x) => ids.includes(x.siteId)))
            this.store.put(kind, {
              ...x,
              siteId: targetId,
              version: x.version + 1,
            });
        for (const site of merged) {
          this.store.put("site", {
            ...site,
            removed: true,
            mergedInto: targetId,
            version: site.version + 1,
          });
          this.store.db
            .prepare("UPDATE refs SET id=? WHERE kind='site' AND id=?")
            .run(targetId, site.id);
        }
      } else
        for (const id of ids) {
          const c = this.store.require("channel", id);
          if (action === "purpose") {
            this.update("channel", id, c.version, { purpose: category });
            continue;
          }
          const change =
            action === "pause"
              ? {
                  enabled: false,
                  management: { ...c.management, state: "paused" },
                }
              : {
                  availability: "已移除",
                  enabled: false,
                  management: { ...c.management, state: "removed" },
                };
          this.store.put("channel", {
            ...c,
            ...change,
            version: c.version + 1,
          });
        }
      const applied = {
        requestId,
        previewId,
        affected: ids,
        result: "applied",
      };
      this.store.put("changePreview", { ...preview, applied });
      this.store.action(previewId, {
        result: "batch_applied",
        action,
        affected: ids,
      });
      return applied;
    });
  }
}
