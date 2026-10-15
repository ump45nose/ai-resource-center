import { randomUUID } from "node:crypto";
import { z } from "zod";
import { hash } from "./store.mjs";
import {
  channelPatch,
  headers,
  normalizeUrl,
  canonicalApi,
  dayKey,
  evaluate,
  nextReset,
  availability,
} from "./domain.mjs";

export class Problem extends Error {
  constructor(statusCode, message, detail) {
    super(message);
    this.statusCode = statusCode;
    this.detail = detail;
  }
}
const defaults = {
  authType: "bearer",
  category: "general",
  protocol: "OpenAI",
  models: [],
  bindings: [],
  enabled: false,
  mode: "manual",
  rating: "",
  note: "",
  order: 0,
  headers: [],
  clientState: "draft",
  samples: 0,
  success: null,
  ttft: null,
  disconnects: 0,
  lastSeen: "—",
  priority: 0,
  weight: 100,
  reason: "尚未采集",
  apply: "pending",
};
export const eventSchema = z
  .object({
    eventId: z.string().min(1),
    kind: z.enum(["account", "checkin"]),
    accountId: z.string().min(1),
    occurredAt: z.iso.datetime(),
    site: z.object({
      name: z.string(),
      url: z.url(),
      checkinUrl: z.url().optional(),
    }),
    name: z.string(),
    balance: z.number().nullable().optional(),
    unit: z.string().optional(),
    status: z.string().optional(),
    businessDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    timezone: z.string().optional(),
    method: z.string().optional(),
    result: z
      .enum([
        "成功",
        "已签到",
        "失败",
        "待确认",
        "需登录",
        "需人工操作",
        "未执行",
        "无法签到",
      ])
      .optional(),
    reason: z.string().optional(),
    reward: z.string().optional(),
  })
  .strict();
export class Center {
  constructor(store) {
    this.store = store;
  }
  site(input, source) {
    const url = normalizeUrl(input.url),
      matches = this.store
        .list("site")
        .filter((s) => s.url === url || s.aliases?.includes(url));
    if (matches.length > 1)
      throw new Problem(409, "站点别名存在多个匹配，请先关联");
    const old = matches[0];
    return this.store.put(
      "site",
      old
        ? {
            ...old,
            ...(!old.checkinUrl && input.checkinUrl
              ? { checkinUrl: input.checkinUrl }
              : {}),
          }
        : {
            ...input,
            id: randomUUID(),
            url,
            category: "general",
            sources: [source],
            aliases: [],
          },
    );
  }
  account(input, source) {
    const site = this.site(input.site, source),
      id = this.store.ref(source, "account", input.accountId);
    const old = id ? this.store.get("account", id) : null;
    const observedAt = Date.parse(input.occurredAt),
      balanceFresh =
        input.balance !== undefined &&
        (!Number.isFinite(Date.parse(old?.confirmedAt)) ||
          observedAt >= Date.parse(old.confirmedAt)),
      statusFresh =
        !Number.isFinite(Date.parse(old?.observedAt || old?.confirmedAt)) ||
        observedAt >= Date.parse(old.observedAt || old.confirmedAt);
    // Login/observed balance are source facts. Purpose and entitlement rules stay local.
    const account = this.store.put(
      "account",
      old
        ? {
            ...old,
            ...(balanceFresh
              ? {
                  balance: input.balance,
                  unit: input.unit || old.unit,
                  confirmedAt: input.occurredAt,
                }
              : {}),
            ...(statusFresh
              ? {
                  status: input.status || old.status,
                  observedAt: input.occurredAt,
                }
              : {}),
          }
        : {
            id: randomUUID(),
            siteId: site.id,
            name: input.name,
            status: input.status || "正常",
            balance: input.balance ?? null,
            unit: input.unit || "待确认",
            confirmedAt: input.balance === undefined ? "—" : input.occurredAt,
            observedAt: input.occurredAt,
            quota: "long",
            benefit: {
              pool: "long",
              validity: "待确认",
              tz: "",
              threshold: "",
              drops: "",
              window: "",
            },
            source,
            sourceId: input.accountId,
          },
    );
    if (
      balanceFresh &&
      account.quota === "daily" &&
      account.benefit.tz &&
      account.benefit.resetAt
    ) {
      account.validUntil = nextReset(
        input.occurredAt,
        account.benefit.tz,
        account.benefit.resetAt,
      );
      this.store.put("account", account);
    }
    this.store.ref(source, "account", input.accountId, account.id);
    return account;
  }
  ingest(source, events) {
    return this.store.transaction(() => {
      const ack = [];
      for (const raw of events) {
        const e = eventSchema.parse(raw),
          eventId = `${source}:${e.eventId}`;
        if (
          this.store.db.prepare("SELECT id FROM events WHERE id=?").get(eventId)
        ) {
          ack.push(e.eventId);
          continue;
        }
        const a = this.account(e, source),
          date =
            e.businessDate ||
            dayKey(e.occurredAt, e.timezone || a.benefit.tz || "Asia/Shanghai");
        if (e.kind === "checkin" && !e.result)
          throw new Problem(400, "签到事件缺少结果");
        this.store.db
          .prepare("INSERT INTO events VALUES(?,?,?,?,?)")
          .run(
            eventId,
            a.id,
            e.occurredAt,
            date,
            JSON.stringify({ ...e, source }),
          );
        ack.push(e.eventId);
      }
      if (events.some((e) => e.method !== "备份导入"))
        this.store.setting(`received:${source}`, new Date().toISOString());
      return { acknowledgedIds: ack };
    });
  }
  publicChannel(c) {
    const { credentialId, applied, ...out } = c;
    return {
      ...out,
      availability:
        availability(
          { ...c, enabled: true },
          this.store.get("account", c.accountId),
        ) || undefined,
      keyMask: credentialId
        ? "••••" + this.store.reveal(credentialId).slice(-4)
        : c.nativeCredentialRef
          ? "酒馆原生凭据"
          : c.gateway
            ? "网关凭据"
            : "未填写",
      hasKey: !!credentialId || !!c.nativeCredentialRef,
    };
  }
  state() {
    const sites = this.store.list("site"),
      accounts = this.store.list("account").map((a) => ({ ...a, checkin: {} }));
    const since = new Date(Date.now() - 31 * 86400000).toISOString();
    for (const r of this.store.db
      .prepare("SELECT * FROM events WHERE occurred_at>=? ORDER BY occurred_at")
      .all(since)) {
      const e = JSON.parse(r.data),
        a = accounts.find((a) => a.id === r.account_id);
      if (e.kind === "checkin" && a)
        a.checkin[r.business_date] = {
          status: e.result,
          reward: e.reward,
          note: e.reason,
          at: r.occurred_at,
          method: e.method,
        };
    }
    const channels = this.store
      .list("channel")
      .map((c) => this.publicChannel(c));
    for (const s of sites) {
      s.categories = [
        ...new Set(
          channels.filter((c) => c.siteId === s.id).map((c) => c.category),
        ),
      ];
      s.category = s.categories[0] || "general";
    }
    const sources = this.store.setting("sources") || [];
    return {
      sites,
      accounts,
      channels,
      evals: this.store.list("evaluation"),
      identities: this.store
        .list("identity")
        .map(({ credentialId, pendingCredentialId, name, ...i }) => i),
      rules: this.store.setting("rules") || {
        days: 7,
        samples: 30,
        good: 98,
        warn: 95,
      },
      tmUrl: this.store.setting("tmUrl") || "",
      integrations: sources.map(({ credentialId, ...s }) => ({
        ...s,
        last: s.last || "尚未同步",
        state: s.error ? "failed" : s.last ? "ok" : "pending",
      })),
      received: {
        allApiHub: this.store.setting("received:all-api-hub"),
        sillyTavern: this.store.setting("received:sillytavern"),
      },
      today: dayKey(new Date()),
      pendingImports: this.store.db
        .prepare(
          "SELECT key,data FROM settings WHERE key LIKE 'import:%' ORDER BY rowid DESC LIMIT 20",
        )
        .all()
        .flatMap((x) => {
          const p = JSON.parse(x.data);
          const rows = this.importPreview(p.rows, p.source).filter(
            (r) =>
              r.kind === "待关联" && !(p.committed || []).includes(r.index),
          );
          return rows.length
            ? [{ id: x.key.slice(7), source: p.source, count: rows.length }]
            : [];
        }),
      demo: false,
    };
  }
  patchChannel(id, expectedVersion, raw) {
    const p = channelPatch.parse(raw),
      old = this.store.get("channel", id);
    if (!old) throw new Problem(404, "渠道不存在");
    if (old.version !== expectedVersion)
      throw new Problem(409, "渠道已被修改，请处理两侧差异", {
        current: this.publicChannel(old),
      });
    const { key, ...patch } = p,
      c = {
        ...old,
        ...patch,
        version: old.version + 1,
        apply: "pending",
        applyMsg: "中心已保存，待应用",
      };
    if (c.category === "rp") {
      c.bindings = ["酒馆"];
      c.mode = "manual";
      c.accessMode = "rp_direct";
    } else if (c.category === "client") {
      if (!c.client) throw new Problem(400, "客户端绑定必须填写客户端");
      c.bindings = [c.client];
      if (!c.gateway || !c.nativePassthrough) c.mode = "manual";
      c.accessMode = "client_bound";
      c.clientState = "draft";
      if (!c.gateway) {
        c.apply = "saved";
        c.applyMsg =
          c.gatewayAllowed === false
            ? "站点禁止网关转发，保留客户端直连"
            : "已保存；确认 key、原生协议和实际模型名后接入 New API";
      }
    } else c.accessMode = "gateway";
    if (
      c.mode === "auto" &&
      (old.mode !== "auto" ||
        (p.priority !== undefined && p.priority !== old.priority) ||
        (p.weight !== undefined && p.weight !== old.weight))
    )
      c.baseRouting = { priority: c.priority, weight: c.weight };
    if (c.mode === "manual") delete c.baseRouting;
    c.headers = headers(c.headers);
    if (key) {
      c.credentialId = this.store.secret(key);
      if (c.gateway) c.credentialPending = true;
    }
    if (
      !this.store.get("account", c.accountId) ||
      !this.store.get("site", c.siteId)
    )
      throw new Problem(400, "账号或站点未关联");
    this.store.put("channel", c);
    this.store.action(id, {
      fields: Object.keys(p).filter((k) => k !== "key"),
      before: Object.fromEntries(
        Object.keys(p)
          .filter((k) => k !== "key")
          .map((k) => [k, old[k]]),
      ),
      ...(key ? { previousCredentialId: old.credentialId } : {}),
      result: "saved",
    });
    return this.publicChannel(c);
  }
  createChannel(input) {
    const { site, account, key, ...raw } = input,
      p = channelPatch.parse(raw),
      s = this.site(site, "manual");
    let a = this.store
      .list("account")
      .find((a) => a.siteId === s.id && a.name === (account || "手动维护"));
    if (!a)
      a = this.store.put("account", {
        id: randomUUID(),
        siteId: s.id,
        name: account || "手动维护",
        status: "正常",
        balance: null,
        unit: "待确认",
        quota: "long",
        confirmedAt: "—",
        benefit: {
          pool: "long",
          validity: "待确认",
          tz: "",
          threshold: "",
          drops: "",
          window: "",
        },
      });
    const c = this.store.put("channel", {
      ...defaults,
      ...p,
      id: randomUUID(),
      siteId: s.id,
      accountId: a.id,
      baseUrl: p.baseUrl || s.url,
      version: 1,
    });
    return this.patchChannel(c.id, 1, {
      ...p,
      ...(key ? { key } : {}),
      siteId: s.id,
      accountId: a.id,
    });
  }
  importPreview(rows, source) {
    return rows.map((r, index) => {
      const url = normalizeUrl(r.site.url),
        site = this.store
          .list("site")
          .find((s) => s.url === url || s.aliases?.includes(url));
      let channel = r.sourceId && this.store.ref(source, "channel", r.sourceId);
      channel = channel ? this.store.get("channel", channel) : null;
      if (!channel && site) {
        let matches = this.store
          .list("channel")
          .filter(
            (c) =>
              c.siteId === site.id &&
              canonicalApi(c.baseUrl, c.protocol) ===
                canonicalApi(r.baseUrl, r.protocol) &&
              c.protocol === (r.protocol || "OpenAI"),
          );
        if (r.gateway)
          matches = matches.filter(
            (c) =>
              !c.gateway ||
              (c.gateway.sourceId === r.gateway.sourceId &&
                c.gateway.channelId === r.gateway.channelId &&
                c.gateway.provider === r.gateway.provider),
          );
        if (r.nativeCredentialRef)
          matches = matches.filter(
            (c) =>
              !c.nativeCredentialRef ||
              (c.nativeCredentialRef.profileId ===
                r.nativeCredentialRef.profileId &&
                c.nativeCredentialRef.device === r.nativeCredentialRef.device),
          );
        if (r.key || r.credentialFingerprint) {
          const exact = matches.filter(
            (c) =>
              c.credentialId &&
              this.store.db
                .prepare("SELECT fingerprint FROM credentials WHERE id=?")
                .get(c.credentialId)?.fingerprint ===
                (r.credentialFingerprint || hash(r.key)),
          );
          if (exact.length) matches = exact;
          else matches = matches.filter((c) => !c.credentialId);
        }
        if (matches.length === 1) channel = matches[0];
        if (matches.length > 1)
          return {
            index,
            name: r.site.name,
            url,
            kind: "待关联",
            channelIds: matches.map((c) => c.id),
            detail: "同地址有多个连接，请选择关联目标",
          };
      }
      return {
        index,
        name: r.site.name,
        url,
        kind:
          channel && channel.category !== (r.category || "general")
            ? "用途冲突"
            : channel
              ? "合并"
              : r.key || r.gateway
                ? "新增"
                : "缺 key",
        channelId: channel?.id,
        detail: r.note || "",
        category: channel?.category || r.category || "general",
      };
    });
  }
  importRows(rows, source, selections) {
    const preview = this.importPreview(rows, source);
    return this.store.transaction(() =>
      selections.map(({ index, channelId, category }) => {
        const row = rows[index],
          p = preview[index];
        if (!row) throw new Problem(400, "导入条目不存在");
        if (p.kind === "待关联" && !channelId)
          throw new Problem(409, "请先选择待关联连接");
        const existing = channelId || p.channelId;
        if (existing) {
          const c = this.store.get("channel", existing);
          if (!c) throw new Problem(404, "关联连接不存在");
          if (row.key && !c.credentialId)
            c.credentialId = this.store.secret(row.key);
          if (row.nativeCredentialRef && !c.nativeCredentialRef)
            c.nativeCredentialRef = row.nativeCredentialRef;
          if (category && category !== c.category)
            throw new Problem(
              409,
              "用途迁移请在渠道详情完成，导入不覆盖人工用途",
            );
          if (row.gateway && !c.gateway) {
            c.gateway = row.gateway;
            c.applied = row.applied;
            c.group = row.group;
            c.priority = row.priority ?? c.priority;
            c.weight = row.weight ?? c.weight;
            c.apply = "saved";
            c.applyMsg = "已关联网关，人工用途和选定模型保留；未提交配置变更";
            this.backfill(row.gateway.sourceId);
          }
          this.store.put("channel", {
            ...c,
            sources: [...new Set([...(c.sources || []), source])],
          });
          if (row.sourceId)
            this.store.ref(source, "channel", row.sourceId, c.id);
          this.importRules(c.accountId, row, source);
          return c.id;
        }
        const s = this.site(row.site, source);
        let accountId = this.store.ref(
          source,
          "account",
          row.accountSourceId || `${s.id}:default`,
        );
        if (!accountId) {
          const a = this.account(
            {
              site: row.site,
              accountId: row.accountSourceId || `${s.id}:default`,
              name: row.accountName || "待关联账号",
              occurredAt: row.observedAt || new Date().toISOString(),
            },
            source,
          );
          accountId = a.id;
        }
        const c = {
          ...defaults,
          ...row,
          id: randomUUID(),
          siteId: s.id,
          accountId,
          category: row.category || "general",
          baseUrl: row.baseUrl || s.url,
          enabled: row.enabled !== false,
          mode: "manual",
          version: 1,
          sources: [source],
          reason: "导入历史，不计入评价样本",
          apply: "saved",
          applyMsg: "来源已记录，未提交配置变更",
        };
        delete c.key;
        delete c.site;
        if (row.key) c.credentialId = this.store.secret(row.key);
        c.accessMode =
          c.category === "rp"
            ? "rp_direct"
            : c.category === "client"
              ? "client_bound"
              : "gateway";
        if (c.category === "rp") c.bindings = ["酒馆"];
        this.store.put("channel", c);
        if (row.gateway) this.backfill(row.gateway.sourceId);
        this.importRules(accountId, row, source);
        if (row.sourceId) this.store.ref(source, "channel", row.sourceId, c.id);
        return c.id;
      }),
    );
  }
  importRules(accountId, row, source) {
    const a = this.store.get("account", accountId);
    if (
      !a.ruleConfirmedAt &&
      (row.ruleText || row.checkinSupported !== undefined)
    ) {
      this.store.put("account", {
        ...a,
        benefit: {
          ...a.benefit,
          ...(row.ruleText ? { ruleText: row.ruleText } : {}),
          ...(row.checkinSupported !== undefined
            ? { checkinSupported: row.checkinSupported }
            : {}),
        },
        ruleSource: source,
      });
    }
  }
  backfill(sourceId) {
    const sources = this.store.setting("sources") || [],
      start = Date.now() - 7 * 86400000;
    this.store.setting(
      "sources",
      sources.map((s) =>
        s.id !== sourceId
          ? s
          : s.kind === "newapi"
            ? {
                ...s,
                cursor: Math.min(
                  s.cursor || Infinity,
                  Math.floor(start / 1000),
                ),
              }
            : { ...s, cursorMs: Math.min(s.cursorMs || Infinity, start) },
      ),
    );
  }
  recompute(now = new Date()) {
    const rules = this.store.setting("rules") || {
      days: 7,
      samples: 30,
      good: 98,
      warn: 95,
    };
    const calls = this.store.db
      .prepare("SELECT * FROM calls WHERE occurred_at>=? ORDER BY occurred_at")
      .all(new Date(now.getTime() - rules.days * 86400000).toISOString());
    const result = evaluate(
      this.store.list("channel"),
      this.store.list("account"),
      calls,
      rules,
      now,
    );
    this.store.transaction(() => {
      for (const c of result) this.store.put("channel", c);
    });
    return result;
  }
}
