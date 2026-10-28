import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Problem } from "./errors.mjs";
import { canonicalApi } from "./domain.mjs";
import { archiveOf, archiveLabels, isRemoved } from "./channel-rules.mjs";
import { hash } from "./store.mjs";
import { recordCall } from "./ingest.mjs";

const id = z.string().min(1).max(160);
const version = z.number().int().positive();
export const rpSnapshotSchema = z
  .object({
    name: z.string().min(1).max(300),
    baseUrl: z.url(),
    protocol: z.enum(["OpenAI", "OpenAI Responses", "Anthropic", "Gemini"]),
    selectedModel: z.string().max(300).default(""),
    order: z.number().int().nonnegative(),
    enabled: z.boolean().default(true),
    note: z.string().max(4000).default(""),
    credentialFingerprint: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable()
      .default(null),
  })
  .strict();
export const rpInventorySchema = z
  .object({
    eventId: id,
    profiles: z
      .array(
        z
          .object({
            nativeConnectionId: id,
            snapshot: rpSnapshotSchema.nullable(),
            error: z.string().max(400).optional(),
          })
          .strict(),
      )
      .max(2000),
    removedIds: z.array(id).default([]),
  })
  .strict();
export const rpSaveSchema = z
  .object({
    eventId: id,
    nativeConnectionId: id,
    localRevision: z.number().int().positive(),
    baseChannelVersion: version,
    baseBindingVersion: version,
    snapshot: rpSnapshotSchema,
  })
  .strict();
export const rpCredentialSchema = z
  .object({
    eventId: id,
    nativeConnectionId: id,
    baseChannelVersion: version,
    baseBindingVersion: version,
    credential: z.string().min(1).max(32000),
  })
  .strict();
export const rpEditSchema = z
  .object({
    version,
    channelVersion: version,
    binding: z
      .object({
        name: z.string().min(1).optional(),
        selectedModel: z.string().optional(),
        enabled: z.boolean().optional(),
        order: z.number().int().nonnegative().optional(),
        note: z.string().optional(),
      })
      .strict()
      .default({}),
    channel: z
      .object({
        baseUrl: z.url().optional(),
        protocol: rpSnapshotSchema.shape.protocol.optional(),
      })
      .strict()
      .default({}),
    resolve: z.enum(["center", "local", "merge"]).optional(),
  })
  .strict();
export const rpArchiveSchema = z
  .object({
    nativeConnectionId: id,
    channelVersion: version,
    reason: z.enum(Object.keys(archiveLabels)),
    note: z.string().optional(),
  })
  .strict();
export const rpResolveSchema = rpEditSchema
  .extend({ nativeConnectionId: id })
  .strict();
export const rpCallSchema = z
  .object({
    events: z
      .array(
        z
          .object({
            eventId: id,
            profileId: id.optional(),
            model: z.string().max(300),
            baseUrl: z.url().optional(),
            protocol: rpSnapshotSchema.shape.protocol.optional(),
            credentialFingerprint: z
              .string()
              .regex(/^[a-f0-9]{64}$/)
              .nullable(),
            credentialVerified: z.boolean().optional(),
            occurredAt: z.iso.datetime(),
            origin: z.literal("live"),
            result: z.enum([
              "pending",
              "success",
              "failure",
              "cancelled",
              "unknown",
            ]),
            latency: z.number().nonnegative().optional(),
            ttft: z.number().nonnegative().optional(),
            isStream: z.boolean().optional(),
            inputTokens: z.number().int().nonnegative().optional(),
            outputTokens: z.number().int().nonnegative().optional(),
            tokenBasis: z.literal("provider").optional(),
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
            statusCode: z.number().int().min(100).max(599).optional(),
            streamStatus: z
              .enum([
                "completed",
                "disconnected",
                "failed",
                "cancelled",
                "unknown",
              ])
              .optional(),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();
const stable = (x) =>
  JSON.stringify(x, (_k, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v).sort(([a], [b]) => a.localeCompare(b)),
        )
      : v,
  );
const same = (a, b) => stable(a) === stable(b);
const now = () => new Date().toISOString();

/** RP bindings have their own configuration version. Observations never advance it. */
export class RpSync {
  constructor(store, resources) {
    Object.assign(this, { store, resources });
  }
  identity(auth) {
    if (
      !["rp", "connector"].includes(auth.role) ||
      !auth.scope?.rpInstanceId ||
      !auth.scope?.rpUserId ||
      !auth.scope?.sourceId
    )
      throw new Problem(403, "需要配对具体实例及用户的酒馆凭据");
    return {
      sourceId: auth.scope.sourceId,
      instanceId: auth.scope.rpInstanceId,
      userId: auth.scope.rpUserId,
    };
  }
  owns(auth, b) {
    const s = this.identity(auth);
    return Object.entries(s).every(([k, v]) => b[k] === v);
  }
  bindings(auth) {
    if (!["admin", "manage", "read"].includes(auth.role)) this.identity(auth);
    return this.store
      .list("rpConnection")
      .filter(
        (b) =>
          auth.role === "admin" ||
          auth.role === "manage" ||
          auth.role === "read" ||
          this.owns(auth, b),
      );
  }
  binding(auth, nativeId) {
    const b = this.bindings(auth).find(
      (b) => b.nativeConnectionId === nativeId,
    );
    if (!b) throw new Problem(403, "酒馆连接未授权");
    return b;
  }
  fingerprint(c) {
    return c.credentialId
      ? this.store.db
          .prepare("SELECT fingerprint FROM credentials WHERE id=?")
          .get(c.credentialId)?.fingerprint || null
      : null;
  }
  rememberConfig(b) {
    const s = this.desired(b),
      id = hash(stable([b.id, s.baseUrl, s.protocol, s.credentialFingerprint]));
    if (!this.store.get("rpConfig", id))
      this.store.put("rpConfig", {
        id,
        bindingId: b.id,
        channelId: b.channelId,
        baseUrl: s.baseUrl,
        protocol: s.protocol,
        credentialFingerprint: s.credentialFingerprint,
      });
  }
  desired(b) {
    const c = this.store.require("channel", b.channelId);
    return {
      name: b.name,
      baseUrl: canonicalApi(c.baseUrl, c.protocol),
      protocol: c.protocol,
      selectedModel: b.selectedModel || "",
      order: b.order || 0,
      enabled: b.enabled !== false,
      note: b.note || "",
      credentialFingerprint: this.fingerprint(c),
    };
  }
  view(b) {
    if (b.conflict?.reason === "首次接入的共享配置或凭据与中心不同") {
      const desired = this.desired(b),
        local = b.conflict.local;
      const equivalent = {
        ...local,
        baseUrl: canonicalApi(local.baseUrl, local.protocol),
        credentialFingerprint: desired.credentialFingerprint,
      };
      if (
        same(equivalent, desired) &&
        (!local.credentialFingerprint ||
          !desired.credentialFingerprint ||
          local.credentialFingerprint === desired.credentialFingerprint)
      )
        b = this.store.put("rpConnection", {
          ...b,
          conflict: null,
          state: "waiting",
        });
    }
    const c = this.store.require("channel", b.channelId);
    return {
      id: b.id,
      sourceId: b.sourceId,
      instanceId: b.instanceId,
      userId: b.userId,
      nativeConnectionId: b.nativeConnectionId,
      channelId: c.id,
      version: b.version,
      channelVersion: c.version,
      ...this.desired(b),
      tags: c.tags || [],
      archiveReasons: archiveOf(c, this.store.get("site", c.siteId)),
      removed: isRemoved(c),
      channelEnabled: c.enabled,
      conflict: b.conflict || null,
      state: b.conflict
        ? "conflict"
        : b.state === "applied" &&
            (b.appliedRevision !== this.revision(b) ||
              !same(b.lastApplied, this.desired(b)))
          ? "waiting"
          : b.state || "waiting",
      lastAppliedAt: b.lastAppliedAt || null,
      lastCallAt: b.lastCallAt || null,
      lastResolution: b.lastResolution || null,
      acceptance: b.lastCallAt ? "已采集真实调用" : "待真实调用验收",
    };
  }
  list(auth) {
    const items = this.bindings(auth).map((b) => this.view(b));
    return {
      items,
      unresolved: this.store
        .list("rpUnresolved")
        .filter(
          (b) =>
            b.state === "unresolved" &&
            (["admin", "manage", "read"].includes(auth.role) ||
              this.owns(auth, b)),
        )
        .map(
          ({
            id,
            sourceId,
            instanceId,
            userId,
            nativeConnectionId,
            error,
          }) => ({
            id,
            sourceId,
            instanceId,
            userId,
            nativeConnectionId,
            error,
          }),
        ),
    };
  }
  once(auth, eventId, fn) {
    const scope = stable(this.identity(auth));
    const old = this.store.db
      .prepare("SELECT data FROM receipts WHERE source=? AND event_id=?")
      .get(scope, eventId);
    if (old) return JSON.parse(old.data);
    return this.store.transaction(() => {
      const result = fn();
      this.store.db
        .prepare("INSERT INTO receipts VALUES(?,?,?)")
        .run(scope, eventId, JSON.stringify(result));
      return result;
    });
  }
  mapped(identity, nativeId) {
    const key = stable([identity.instanceId, identity.userId, nativeId]);
    const ref = this.store.ref(identity.sourceId, "rpConnection", key);
    if (ref) return this.store.require("rpConnection", ref);
    return null;
  }
  legacy(identity, nativeId) {
    const devices = new Set([
      `${identity.instanceId}:${identity.userId}`,
      `${identity.instanceId}:${identity.userId}:native-import`,
    ]);
    const matches = new Map();
    for (const c of this.store.list("channel")) {
      if (
        ["nativeCredentialRef", "tavern"].some(
          (k) => c[k]?.profileId === nativeId && devices.has(c[k]?.device),
        )
      )
        matches.set(c.id, c);
    }
    for (const r of this.store.db
      .prepare("SELECT external_id,id FROM refs WHERE source=? AND kind=?")
      .all(identity.sourceId, "channel")) {
      if (
        [
          `${identity.userId}:${nativeId}`,
          `${identity.instanceId}:${identity.userId}:${nativeId}`,
        ].includes(r.external_id)
      ) {
        const c = this.store.get("channel", r.id);
        if (c) matches.set(c.id, c);
      }
    }
    if (matches.size > 1)
      throw new Problem(409, "原生连接存在多个历史映射，请先处理关联");
    return [...matches.values()][0];
  }
  inventory(auth, input) {
    if (auth.role !== "rp" || !auth.scope.rpRegistration)
      throw new Problem(403, "凭据没有登记本实例连接的权限");
    return this.once(auth, input.eventId, () => {
      const identity = this.identity(auth),
        items = [];
      for (const p of input.profiles) {
        const unresolvedId = hash(
          stable([
            identity.sourceId,
            identity.instanceId,
            identity.userId,
            p.nativeConnectionId,
          ]),
        );
        if (!p.snapshot)
          this.store.put("rpUnresolved", {
            id: unresolvedId,
            ...identity,
            nativeConnectionId: p.nativeConnectionId,
            state: "unresolved",
            error: p.error || "连接字段尚未解析",
          });
        else if (this.store.get("rpUnresolved", unresolvedId))
          this.store.put("rpUnresolved", {
            id: unresolvedId,
            ...identity,
            nativeConnectionId: p.nativeConnectionId,
            state: "resolved",
          });
        let b = this.mapped(identity, p.nativeConnectionId);
        if (!b && p.snapshot) {
          let c = this.legacy(identity, p.nativeConnectionId);
          if (!c) {
            // No address-based merge: a newly registered profile gets its own channel and account.
            const site = this.resources.site(
              {
                url: new URL(p.snapshot.baseUrl).origin,
                name: new URL(p.snapshot.baseUrl).host,
              },
              identity.sourceId,
            );
            const account = this.store.put("account", {
              id: randomUUID(),
              siteId: site.id,
              name: `酒馆 · ${identity.userId}`,
              enabled: true,
              sources: [identity.sourceId],
            });
            c = this.resources.channel({
              siteId: site.id,
              accountId: account.id,
              name: p.snapshot.name,
              baseUrl: p.snapshot.baseUrl,
              protocol: p.snapshot.protocol,
              usage: "rp",
              enabled: true,
              models: [],
              tags: [],
              mode: "manual",
              recoveryPolicy: { enabled: false },
            });
          }
          b = this.store.put("rpConnection", {
            id: randomUUID(),
            ...identity,
            nativeConnectionId: p.nativeConnectionId,
            channelId: c.id,
            name: p.snapshot.name,
            selectedModel: p.snapshot.selectedModel,
            enabled: p.snapshot.enabled,
            order: p.snapshot.order,
            note: p.snapshot.note,
            localRevision: 0,
            nativeSnapshot: p.snapshot,
            lastApplied: p.snapshot,
            state: "waiting",
          });
          this.store.ref(
            identity.sourceId,
            "rpConnection",
            stable([
              identity.instanceId,
              identity.userId,
              p.nativeConnectionId,
            ]),
            b.id,
          );
          this.rememberConfig(b);
          // Preserve the center's shared configuration on first contact. Key delivery is separate.
          const desired = this.desired(b),
            comparable = {
              ...p.snapshot,
              credentialFingerprint: desired.credentialFingerprint,
            };
          if (
            !same(desired, comparable) ||
            (p.snapshot.credentialFingerprint &&
              desired.credentialFingerprint &&
              p.snapshot.credentialFingerprint !==
                desired.credentialFingerprint)
          )
            b = this.store.put("rpConnection", {
              ...b,
              state: "conflict",
              conflict: {
                local: p.snapshot,
                center: desired,
                reason: "首次接入的共享配置或凭据与中心不同",
              },
            });
        }
        items.push(
          b
            ? this.view(b)
            : {
                nativeConnectionId: p.nativeConnectionId,
                state: "unresolved",
                error: p.error || "连接字段尚未解析",
              },
        );
      }
      for (const nativeId of input.removedIds) {
        const b = this.mapped(identity, nativeId);
        if (b)
          this.store.update("rpConnection", b.id, b.version, {
            nativeRemoved: true,
            enabled: false,
            state: "applied",
          });
      }
      return { eventId: input.eventId, items };
    });
  }
  conflict(b, snapshot, reason) {
    const c = this.store.require("channel", b.channelId);
    const next = this.store.put("rpConnection", {
      ...b,
      state: "conflict",
      conflict: { local: snapshot, center: this.desired(b), reason },
    });
    return {
      state: "conflict",
      connection: this.view(next),
      channelVersion: c.version,
    };
  }
  save(auth, p) {
    if (auth.role !== "rp") throw new Problem(403, "需要酒馆保存凭据");
    if (
      this.store.db
        .prepare("SELECT 1 FROM events WHERE id=?")
        .get(`${this.identity(auth).sourceId}:${p.eventId}`)
    )
      return {
        state: "superseded",
        connection: this.view(this.binding(auth, p.nativeConnectionId)),
      };
    return this.once(auth, p.eventId, () => {
      const b = this.binding(auth, p.nativeConnectionId),
        c = this.store.require("channel", b.channelId);
      if (b.conflict) return { state: "conflict", connection: this.view(b) };
      if (p.localRevision <= (b.localRevision || 0))
        return { state: "superseded", connection: this.view(b) };
      if (
        c.version !== p.baseChannelVersion ||
        b.version !== p.baseBindingVersion
      )
        return this.conflict(b, p.snapshot, "两端基线版本不同");
      this.rememberConfig(b);
      const channel = {
        baseUrl: canonicalApi(p.snapshot.baseUrl, p.snapshot.protocol),
        protocol: p.snapshot.protocol,
      };
      if (
        channel.baseUrl !== canonicalApi(c.baseUrl, c.protocol) ||
        channel.protocol !== c.protocol
      )
        this.resources.update("channel", c.id, c.version, channel);
      const { name, selectedModel, enabled, order, note } = p.snapshot;
      let next = this.store.update("rpConnection", b.id, b.version, {
        name,
        selectedModel,
        enabled,
        order,
        note,
        localRevision: p.localRevision,
        nativeSnapshot: p.snapshot,
        lastApplied: p.snapshot,
        state: "applied",
        lastAppliedAt: now(),
      });
      next = this.store.put("rpConnection", {
        ...next,
        appliedRevision: this.revision(next),
      });
      this.rememberConfig(next);
      return { state: "applied", connection: this.view(next) };
    });
  }
  credentials(auth, p) {
    if (auth.role !== "rp") throw new Problem(403, "需要酒馆凭据交付权限");
    return this.once(auth, p.eventId, () => {
      const b = this.binding(auth, p.nativeConnectionId),
        c = this.store.require("channel", b.channelId),
        fp = hash(p.credential);
      if (b.conflict) return { state: "conflict", connection: this.view(b) };
      if (fp === this.fingerprint(c))
        return { state: "applied", connection: this.view(b) };
      if (
        c.version !== p.baseChannelVersion ||
        b.version !== p.baseBindingVersion
      )
        return this.conflict(b, b.nativeSnapshot, "凭据基线版本不同");
      this.rememberConfig(b);
      this.resources.saveCredential(c.id, c.version, p.credential);
      const next = this.store.put("rpConnection", {
        ...b,
        nativeSnapshot: { ...b.nativeSnapshot, credentialFingerprint: fp },
        lastApplied: { ...b.lastApplied, credentialFingerprint: fp },
        ...(b.state === "applied" ? { appliedRevision: this.revision(b) } : {}),
        state: b.state,
      });
      this.rememberConfig(next);
      return { state: "applied", connection: this.view(next) };
    });
  }
  edit(auth, bindingId, p) {
    if (!["admin", "manage"].includes(auth.role))
      throw new Problem(403, "需要管理权限");
    const b = this.store.require("rpConnection", bindingId),
      c = this.store.require("channel", b.channelId);
    if (b.version !== p.version || c.version !== p.channelVersion)
      throw new Problem(409, "配置版本已变化，请刷新");
    return this.store.transaction(() => {
      this.rememberConfig(b);
      const local = p.resolve === "local" ? b.conflict?.local : null;
      if (local)
        p = {
          ...p,
          binding: {
            ...p.binding,
            ...Object.fromEntries(
              ["name", "selectedModel", "order", "enabled", "note"].map((k) => [
                k,
                local[k],
              ]),
            ),
          },
          channel: { baseUrl: local.baseUrl, protocol: local.protocol },
        };
      if (Object.keys(p.channel).length)
        this.resources.update("channel", c.id, c.version, p.channel);
      const next = this.store.update("rpConnection", b.id, b.version, {
        ...p.binding,
        conflict: null,
        state: "waiting",
        ...(p.resolve
          ? {
              lastApplied: b.conflict?.local || b.lastApplied,
              lastResolution: p.resolve,
            }
          : {}),
        forceApply: !!p.resolve,
      });
      return this.view(next);
    });
  }
  archive(auth, input) {
    if (auth.role !== "rp") throw new Problem(403, "需要酒馆归档权限");
    const b = this.binding(auth, input.nativeConnectionId),
      c = this.store.require("channel", b.channelId);
    if (c.version !== input.channelVersion)
      throw new Problem(409, "归档前渠道已更新，请刷新");
    if (isRemoved(c)) throw new Problem(409, "永久移除的连接保持移除");
    this.resources.lifecycle(
      c.id,
      c.version,
      "archive",
      input.reason,
      input.note || "",
      false,
    );
    return this.view(b);
  }
  revision(b) {
    const c = this.store.require("channel", b.channelId);
    return hash(
      stable([
        c.version,
        b.version,
        this.desired(b),
        archiveOf(c),
        isRemoved(c),
        c.enabled,
      ]),
    );
  }
  claim(auth) {
    if (auth.role !== "connector" || auth.scope.target !== "sillytavern")
      throw new Problem(403, "需要酒馆执行凭据");
    const items = [];
    for (const b of this.bindings(auth).filter(
      (b) => !b.nativeRemoved && !b.conflict,
    )) {
      const c = this.store.require("channel", b.channelId),
        revision = this.revision(b),
        jobId = `rp:${b.id}:${revision}`;
      if (
        b.state === "applied" &&
        b.appliedRevision === revision &&
        same(b.lastApplied, this.desired(b))
      )
        continue;
      this.rememberConfig(b);
      let j = this.store.get("rpDelivery", jobId);
      if (
        j?.state === "applied" ||
        (j?.leaseUntil && Date.parse(j.leaseUntil) > Date.now()) ||
        (j?.retryAt && Date.parse(j.retryAt) > Date.now())
      )
        continue;
      j = this.store.put("rpDelivery", {
        id: jobId,
        bindingId: b.id,
        channelId: c.id,
        revision,
        lease: randomUUID(),
        leaseUntil: new Date(Date.now() + 120000).toISOString(),
        state: "running",
      });
      items.push({
        id: j.id,
        lease: j.lease,
        revision,
        subject: c.id,
        expected: b.lastApplied,
        payload: {
          ...this.view(b),
          credential: c.credentialId ? this.store.reveal(c.credentialId) : null,
          switchCurrent: false,
        },
        force: !!b.forceApply,
      });
      if (items.length >= 20) break;
    }
    return { items };
  }
  receipt(auth, p) {
    const j = this.store.require("rpDelivery", p.id),
      b = this.store.require("rpConnection", j.bindingId);
    if (
      auth.role !== "connector" ||
      auth.scope.target !== "sillytavern" ||
      !this.owns(auth, b)
    )
      throw new Problem(403, "无权回执");
    if (j.lease !== p.lease)
      throw new Problem(409, "任务租约已变化，请重新领取");
    if (j.state !== "running")
      return { acknowledged: true, id: j.id, state: j.state };
    if (
      p.state === "applied" &&
      (j.revision !== this.revision(b) || !same(p.snapshot, this.desired(b)))
    )
      throw new Problem(409, "回读配置与任务版本不同");
    this.store.put("rpDelivery", {
      ...j,
      state: p.state,
      leaseUntil: null,
      retryAt: new Date(Date.now() + 30000).toISOString(),
      reason: p.reason,
    });
    this.store.put("rpConnection", {
      ...b,
      state: p.state,
      forceApply: false,
      ...(p.state === "applied"
        ? {
            lastApplied: p.snapshot,
            nativeSnapshot: p.snapshot,
            lastAppliedAt: now(),
            appliedRevision: j.revision,
          }
        : {}),
      ...(p.state === "conflict"
        ? {
            conflict: {
              local: p.snapshot,
              center: this.desired(b),
              reason: p.reason || "酒馆配置已改变",
            },
          }
        : {}),
    });
    return { acknowledged: true, id: j.id, state: p.state };
  }
  calls(auth, input) {
    if (auth.role !== "rp") throw new Problem(403, "需要酒馆调用凭据");
    const identity = this.identity(auth),
      bs = this.bindings(auth),
      device = `${identity.instanceId}:${identity.userId}`;
    return this.store.transaction(() => {
      const acknowledgedIds = [];
      for (const e of input.events) {
        const sourceId = `${device}:${e.eventId}`,
          old = this.store.db
            .prepare("SELECT * FROM calls WHERE source=? AND source_id=?")
            .get(identity.sourceId, sourceId);
        if (old && old.result !== "pending") {
          acknowledgedIds.push(e.eventId);
          continue;
        }
        const b = bs.find((b) => b.nativeConnectionId === e.profileId);
        if (b) this.rememberConfig(b);
        const proof =
          b &&
          e.credentialVerified !== false &&
          e.baseUrl &&
          this.store
            .list("rpConfig")
            .find(
              (p) =>
                p.bindingId === b.id &&
                p.protocol === e.protocol &&
                p.credentialFingerprint === e.credentialFingerprint &&
                canonicalApi(p.baseUrl, p.protocol) ===
                  canonicalApi(e.baseUrl, e.protocol),
            );
        const channelId = old?.channel_id || proof?.channelId;
        recordCall(
          this.store,
          identity.sourceId,
          sourceId,
          channelId,
          e.model,
          e.occurredAt,
          e.result,
          {
            errorType: e.errorType,
            latencyMs: e.latency,
            ttftMs: e.ttft,
            requestId: e.eventId,
            upstreamChannel: e.profileId,
            application: `酒馆 · ${device}`,
            isStream: e.isStream,
            streamStatus: e.streamStatus,
            inputTokens: e.inputTokens,
            outputTokens: e.outputTokens,
            tokenBasis: e.tokenBasis,
            origin: "live",
            summary: !channelId
              ? "未能核实请求地址、协议与凭据归属；未推测最终上游"
              : e.result === "unknown"
                ? "未采集到明确生成终态"
                : null,
          },
        );
        if (b && channelId && e.result !== "pending")
          this.store.put("rpConnection", {
            ...this.store.require("rpConnection", b.id),
            lastCallAt: e.occurredAt,
          });
        acknowledgedIds.push(e.eventId);
      }
      this.store.setting("received:sillytavernCalls", now());
      return { acknowledgedIds };
    });
  }
}

export function registerRp(app, rp) {
  app.get("/api/v2/rp/identity", (req) => rp.identity(req.auth));
  for (const [path, schema, method] of [
    ["inventory", rpInventorySchema, "inventory"],
    ["saves", rpSaveSchema, "save"],
    ["credentials", rpCredentialSchema, "credentials"],
  ])
    app.post(`/api/v2/rp/${path}`, (req) =>
      rp[method](req.auth, schema.parse(req.body)),
    );
  app.post("/api/v2/rp/archive", (req) =>
    rp.archive(req.auth, rpArchiveSchema.parse(req.body)),
  );
  app.post("/api/v2/rp/resolve", (req) => {
    const p = rpResolveSchema.parse(req.body);
    if (req.auth.role !== "rp") throw new Problem(403, "需要酒馆冲突处理权限");
    const b = rp.binding(req.auth, p.nativeConnectionId);
    if (!p.resolve) throw new Problem(400, "请选择冲突处理方式");
    return rp.edit({ role: "manage" }, b.id, p);
  });
  app.post("/api/v2/ingest/rp-calls", (req) =>
    rp.calls(req.auth, rpCallSchema.parse(req.body)),
  );
}
