import { routableModels } from "./channel-health.mjs";
import { randomUUID } from "node:crypto";
import { digest, same } from "./canonical.mjs";
import {
  channelType,
  headerOverride,
  passthroughSetting,
  findByTag,
} from "./newapi-channel.mjs";
import { withoutSecrets } from "./redaction.mjs";
import { canonicalApi } from "./domain.mjs";
import { Problem, publicValue, errorMessage } from "./errors.mjs";
import {
  usageOf,
  archiveOf,
  isRemoved,
  isInternal,
  isRp,
  channelHeaders,
  tagsOf,
} from "./channel-rules.mjs";
import {
  verified,
  entitlement,
  policies,
  autoManaged,
} from "./maintenance-policy.mjs";
import { bookmarkPlan } from "./bookmarks.mjs";
import { NotionMirror } from "./notion-mirror.mjs";

const targetNames = {
  newapi: "New API",
  "all-api-hub": "All API Hub",
  notion: "Notion",
  "chrome-bookmarks": "Chrome 书签",
};
const now = () => new Date().toISOString();
const later = (minutes) =>
  new Date(Date.now() + minutes * 60000).toISOString();
// The extension's own account snapshot: site_name, customCheckIn.url || null,
// automaticExecutionEnabled and !!disabled.
const hubFields = [
  "name",
  "checkinUrl",
  "automaticExecutionEnabled",
  "disabled",
];
const hubExact = (s) =>
  typeof s?.name === "string" &&
  (s.checkinUrl === null || typeof s.checkinUrl === "string") &&
  typeof s.automaticExecutionEnabled === "boolean" &&
  typeof s.disabled === "boolean";
// site.checkinUrl in the inventory may be a static route; only
// checkin.customUrl is the saved custom entry.
const hubObserved = (o) => ({
  name: o.siteName,
  checkinUrl: Object.hasOwn(o.checkin || {}, "customUrl")
    ? o.checkin.customUrl
    : undefined,
  automaticExecutionEnabled: o.checkin?.enabled,
  disabled: typeof o.enabled === "boolean" ? !o.enabled : undefined,
});
const hubWaiting = "等待插件回报当前名称、签到入口和停用状态，暂不下发";
const hubInPlace = "插件已是中心要求的自动签到状态";
const owned = (r) => ({
  name: r.name,
  base_url: r.base_url || "",
  models: (r.models || "").split(",").filter(Boolean).sort().join(","),
  status: r.status,
  type: r.type,
  header_override: r.header_override || "",
  setting: r.setting || "",
  model_mapping: r.model_mapping || "",
  priority: r.priority || 0,
  weight: r.weight ?? 100,
});
const active = (c) =>
  c.enabled &&
  !archiveOf(c).length &&
  !isRemoved(c) &&
  !["paused", "maintenance", "closed"].includes(c.management?.state) &&
  !c.management?.prohibited;

// One durable outbox serves all targets. Credentials stay in the vault; jobs contain references only.
export class Distribution {
  constructor(store, resources, sources, gateway, fetcher = fetch) {
    Object.assign(this, { store, resources, sources, gateway });
    this.notion = new NotionMirror(store, fetcher);
    this.running = false;
  }
  config(id) {
    if (!targetNames[id]) throw new Problem(404, "同步目标不存在");
    return {
      id,
      name: targetNames[id],
      enabled: false,
      version: 1,
      ...(this.store.setting(`target:${id}`) || {}),
    };
  }
  hubEligibility(a) {
    const source = this.config("all-api-hub").sourceId || "all-api-hub";
    if (a.mergedInto) return { state: "not_applicable", reason: "账号已合并" };
    if (
      a.sourceObservation?.source === source &&
      a.sourceObservation.present !== false
    )
      return {
        state: "linked",
        reason: "已关联插件账号，继续同步余额与签到观察",
      };
    if (a.hubIntegration === "none" || a.checkinEnabled === false)
      return { state: "not_applicable", reason: "无需签到且未关联插件账号" };
    return { state: "needs_link", reason: "需要在插件完成登录关联" };
  }
  hubAccounts() {
    const sites = new Set(
      this.store
        .list("site")
        .filter((s) => !s.removed && !s.mergedInto)
        .map((s) => s.id),
    );
    return this.store
      .list("account")
      .filter(
        (a) =>
          !a.mergedInto &&
          sites.has(a.siteId) &&
          this.hubEligibility(a).state !== "not_applicable",
      );
  }
  // Newest of the last receipt and the inventory, or null unless it is exact.
  hubCurrent(a, link) {
    const source = this.config("all-api-hub").sourceId || "all-api-hub",
      o = a?.sourceObservation;
    if (o?.source === source && o.present === false) return null;
    const latest = [
      link?.reported ||
        (link?.appliedAt && link.snapshot
          ? { at: link.appliedAt, snapshot: link.snapshot }
          : null),
      o?.source === source ? { at: o.observedAt, snapshot: hubObserved(o) } : null,
    ]
      .filter(Boolean)
      .sort((x, y) => Date.parse(y.at) - Date.parse(x.at))[0];
    return hubExact(latest?.snapshot)
      ? Object.fromEntries(hubFields.map((k) => [k, latest.snapshot[k]]))
      : null;
  }
  hubDecision(a, link) {
    if (a.checkinArchive?.active)
      return { automaticExecutionEnabled: false, reason: "archived" };
    if (a.checkinAccountId)
      return { automaticExecutionEnabled: false, reason: "delegated" };
    if (link?.checkinHold)
      return { automaticExecutionEnabled: true, reason: "restored" };
    return { automaticExecutionEnabled: null, reason: null };
  }
  hubView(a) {
    const status = this.hubEligibility(a);
    if (status.state !== "linked") return status;
    const link = this.store.get("targetLink", `all-api-hub:${a.id}`);
    return {
      ...status,
      extension: this.hubCurrent(a, link),
      automaticCheckin: this.hubDecision(a, link),
    };
  }
  managedEntries(id) {
    const t = this.config(id);
    return this.entries(id).filter(
      (e) =>
        !t.baselineSubjects?.includes(e.subject) ||
        t.managedSubjects?.includes(e.subject),
    );
  }
  currentJobs(id) {
    if (
      !this.config(id).enabled &&
      !this.store.list("delivery").some((j) => j.target === id)
    )
      return [];
    const cacheKey = `${this.store.revision}:${Math.floor(Date.now() / 5000)}`;
    this.jobCache ||= new Map();
    if (this.jobCache.get(id)?.key === cacheKey)
      return this.jobCache.get(id).jobs;
    const entries = new Map(
      this.managedEntries(id).map((e) => [e.subject, digest(e.payload)]),
    );
    const jobs = [
      ...new Map(
        this.store
          .list("delivery")
          .filter(
            (j) =>
              j.target === id &&
              j.state !== "superseded" &&
              entries.get(j.subject) === j.revision,
          )
          .map((j) => [j.subject, j]),
      ).values(),
    ];
    this.jobCache.set(id, { key: cacheKey, jobs });
    return jobs;
  }
  list() {
    return Object.keys(targetNames).map((id) => {
      const t = this.config(id),
        jobs = [
          ...this.currentJobs(id),
          ...(id === "all-api-hub" ? this.hubPending() : []),
        ];
      const notApplicable =
        id === "all-api-hub"
          ? this.store
              .list("account")
              .filter(
                (a) =>
                  !a.mergedInto && !this.store.get("site", a.siteId)?.removed,
              )
              .filter((a) => this.hubEligibility(a).state === "not_applicable")
              .length
          : 0;
      return {
        ...publicValue(t),
        credentialStatus: t.credentialId ? "present" : "missing",
        counts: {
          ...Object.fromEntries(
            [
              "pending",
              "running",
              "applied",
              "failed",
              "conflict",
              "waiting",
            ].map((s) => [s, jobs.filter((j) => j.state === s).length]),
          ),
          not_applicable: notApplicable,
        },
        lastAppliedAt:
          jobs
            .filter((j) => j.state === "applied")
            .map((j) => j.appliedAt)
            .sort()
            .at(-1) || null,
      };
    });
  }
  save(id, version, changes) {
    const t = this.config(id);
    if (t.version !== version)
      throw new Problem(
        409,
        "同步设置已改变",
        { currentVersion: t.version },
        "version_conflict",
      );
    if (changes.enabled && !t.adoptedAt)
      throw new Problem(409, "请先预览并确认首次接管");
    const changedDestination = [
      "sourceId",
      "databaseId",
      "dataSourceId",
      "rootId",
    ].some((k) => Object.hasOwn(changes, k) && changes[k] !== t[k]);
    const next = {
      ...t,
      ...changes,
      version: version + 1,
      ...(changedDestination ? { enabled: false, adoptedAt: null } : {}),
    };
    this.store.transaction(() => {
      if (changedDestination) {
        for (const link of this.store
          .list("targetLink")
          .filter((l) => l.target === id)) {
          this.store.put("targetLinkHistory", {
            ...link,
            id: randomUUID(),
            previousId: link.id,
          });
          this.store.db
            .prepare("DELETE FROM entities WHERE kind='targetLink' AND id=?")
            .run(link.id);
        }
        for (const j of this.store
          .list("delivery")
          .filter((j) => j.target === id && j.state !== "applied"))
          this.store.put("delivery", { ...j, state: "superseded" });
      }
      this.store.setting(`target:${id}`, next);
    });
    return this.list().find((x) => x.id === id);
  }
  credential(id, version, value) {
    const t = this.config(id);
    if (t.version !== version)
      throw new Problem(
        409,
        "同步设置已改变",
        { currentVersion: t.version },
        "version_conflict",
      );
    this.store.setting(`target:${id}`, {
      ...t,
      credentialId: this.store.secret(value, t.credentialId),
      version: version + 1,
    });
    return this.list().find((x) => x.id === id);
  }
  source(t) {
    return t.sourceId ? this.sources.get(t.sourceId) : this.gateway.target();
  }
  routing(c) {
    const rights = entitlement(this.store.get("account", c.accountId)),
      p = policies(this.store);
    const result = {
      available: rights.available,
      reasons: rights.reasons,
      priority: null,
      weight: null,
    };
    if (
      p.autoApply &&
      autoManaged(this.store, c) &&
      routableModels(this.store, c).length
    ) {
      const offerings = routableModels(this.store, c).map((model) =>
        this.store
          .list("offering")
          .find((o) => o.channelId === c.id && o.modelId === model),
      );
      if (offerings.every(Boolean)) {
        const grades = offerings.map((o) => {
          const g = o.grade || this.gateway.grade(o);
          return {
            ...g,
            priority:
              g.tier === "backup"
                ? 0
                : rights.daily
                  ? g.tier === "preferred"
                    ? 400
                    : 300
                  : g.tier === "preferred"
                    ? 200
                    : 100,
          };
        });
        if (grades.every((g) => g.samples >= p.samples)) {
          result.priority = Math.min(...grades.map((g) => g.priority));
          result.weight =
            usageOf(c) === "general"
              ? Math.round(
                  grades.reduce((sum, g) => sum + g.weight, 0) / grades.length,
                )
              : 100;
        }
      }
    }
    return result;
  }
  entries(id) {
    if (id === "chrome-bookmarks")
      return [
        { subject: "bookmarks", payload: bookmarkPlan(this.resources) },
      ].map((e) => {
        delete e.payload.generatedAt;
        return e;
      });
    const sites = this.store
      .list("site")
      .filter((s) => !s.removed && !s.mergedInto);
    const channels = this.store
      .list("channel")
      .filter(
        (c) => !c.sourceOnly && !c.mergedInto && !isInternal(c) && !isRp(c),
      );
    if (id === "notion")
      return sites.map((s) => ({
        subject: s.id,
        payload: this.notion.project(this.resources.detail(s.id)),
      }));
    // Only the automatic check-in decision is the center's; the fields the
    // extension owns are echoed when a job is claimed.
    if (id === "all-api-hub")
      return this.hubAccounts().map((a) => ({
        subject: a.id,
        payload: {
          centerAccountId: a.id,
          externalId:
            a.sourceObservation?.source ===
            (this.config(id).sourceId || "all-api-hub")
              ? a.sourceObservation.externalId
              : null,
          siteId: a.siteId,
          ...this.hubDecision(
            a,
            this.store.get("targetLink", `${id}:${a.id}`),
          ),
        },
      }));
    return channels
      .filter(
        (c) =>
          active(c) ||
          !!this.store.get("targetLink", `${id}:${c.id}`)?.remoteId ||
          c.gateway?.sourceId === this.source(this.config(id)).id,
      )
      .map((c) => ({
        subject: c.id,
        // Field set and values are part of each stored delivery revision.
        payload: {
          channelId: c.id,
          siteId: c.siteId,
          accountId: c.accountId,
          name: c.name,
          baseUrl: canonicalApi(c.baseUrl, c.protocol),
          protocol: c.protocol,
          models: routableModels(this.store, c),
          usage: usageOf(c),
          tags: tagsOf(c),
          enabled:
            active(c) &&
            c.gatewayAllowed !== false &&
            routableModels(this.store, c).length > 0,
          order: c.order || 0,
          credentialId: c.credentialId || null,
          credentialHeadersId: c.credentialHeadersId || null,
          nativeCredentialRef: c.nativeCredentialRef || null,
          credentialFingerprint: c.credentialId
            ? this.store.db
                .prepare("SELECT fingerprint FROM credentials WHERE id=?")
                .get(c.credentialId)?.fingerprint
            : null,
          routing: this.routing(c),
          connectionVersion: c.connectionVersion || 1,
          headerValues: channelHeaders(this.store, c),
        },
      }));
  }
  revision(id) {
    return digest({
      destination:
        id === "newapi"
          ? (({ id, url, userId, version, credentialId }) => ({
              id,
              url,
              userId,
              version,
              credentialId,
            }))(this.source(this.config(id)))
          : null,
      config: this.config(id).version,
      entries: this.entries(id),
    });
  }
  async preview(id) {
    const t = this.config(id),
      entries = this.entries(id),
      rows = [];
    let remotes = [],
      notionPages = [];
    if (id === "newapi")
      remotes = await this.sources.pages(this.source(t), "/api/channel/");
    if (id === "notion") {
      const destination = await this.notion.inspect(t);
      Object.assign(t, destination);
      notionPages = await this.notion.pages(t);
    }
    for (const e of entries) {
      const link = this.store.get("targetLink", `${id}:${e.subject}`);
      const c = id === "newapi" ? this.store.get("channel", e.subject) : null;
      const remote =
        id === "newapi"
          ? remotes.find(
              (r) =>
                String(r.id) ===
                  String(
                    link?.remoteId ||
                      (c?.gateway?.sourceId === this.source(t).id
                        ? c.gateway.channelId
                        : ""),
                  ) || r.tag === `arc-managed-${e.subject}`,
            )
          : null;
      const account =
        id === "all-api-hub" ? this.store.get("account", e.subject) : null;
      const initial = account ? this.hubCurrent(account, null) : null;
      const notionPage =
        id === "notion" && !link?.remoteId
          ? this.notion.match(notionPages, e.payload)
          : null;
      const baseline = remote ? owned(remote) : link?.snapshot || initial;
      const conflict = !!(
        remote &&
        link?.snapshot &&
        digest(baseline) !== digest(link.snapshot)
      );
      rows.push({
        subject: e.subject,
        name: account
          ? account.sourceObservation?.siteName || account.name
          : e.payload.name || e.payload.title || "公益站书签",
        action:
          id === "all-api-hub" && !e.payload.externalId
            ? "waiting_login"
            : conflict
              ? "conflict"
              : e.payload.enabled === false || e.payload.disabled
                ? id === "newapi" && (!remote || remote.status === 2)
                  ? "keep"
                  : "disable"
                : link ||
                    remote ||
                    notionPage ||
                    (id === "all-api-hub" && e.payload.externalId)
                  ? "update"
                  : "create",
        current: publicValue(baseline),
        desired: publicValue({ ...e.payload, headerValues: undefined }),
        remoteId: remote?.id || link?.remoteId || notionPage?.id || null,
        baseline,
      });
    }
    const preview = this.store.put("distributionPreview", {
      id: randomUUID(),
      target: id,
      revision: this.revision(id),
      configVersion: t.version,
      destination: { dataSourceId: t.dataSourceId, databaseId: t.databaseId },
      rows,
      createdAt: now(),
    });
    return publicValue({
      previewId: preview.id,
      target: id,
      rows,
      browserReadbackRequired: ["all-api-hub", "chrome-bookmarks"].includes(id),
    });
  }
  confirm(id, previewId, subjectIds) {
    const p = this.store.require("distributionPreview", previewId),
      t = this.config(id);
    if (p.target !== id) throw new Problem(400, "预览目标不一致");
    if (p.confirmedAt) {
      if (
        subjectIds &&
        !same(
          [...subjectIds].sort(),
          [...(p.selectedSubjects || p.rows.map((r) => r.subject))].sort(),
        )
      )
        throw new Problem(409, "已确认的预览不能扩大接管范围");
      return this.list().find((x) => x.id === id);
    }
    if (p.configVersion !== t.version || p.revision !== this.revision(id))
      throw new Problem(409, "预览后资料已变化，请重新预览");
    const selected = subjectIds || p.rows.map((r) => r.subject);
    if (
      !selected.length ||
      selected.some((subject) => !p.rows.some((r) => r.subject === subject))
    )
      throw new Problem(400, "请选择预览中的接管范围");
    return this.store.transaction(() => {
      for (const row of p.rows.filter((r) => selected.includes(r.subject))) {
        this.store.put("targetLink", {
          ...(this.store.get("targetLink", `${id}:${row.subject}`) || {}),
          id: `${id}:${row.subject}`,
          target: id,
          subject: row.subject,
          remoteId: row.remoteId,
          snapshot: row.baseline,
          approvedModels: row.desired.models || [],
          approvedConnectionVersion: row.desired.connectionVersion,
          state: row.action === "conflict" ? "conflict" : "adopted",
        });
      }
      this.store.setting(`target:${id}`, {
        ...t,
        ...Object.fromEntries(
          Object.entries(p.destination).filter(([, v]) => v),
        ),
        enabled: true,
        adoptedAt: t.adoptedAt || now(),
        managedSubjects: [
          ...new Set([...(t.managedSubjects || []), ...selected]),
        ],
        baselineSubjects: [
          ...new Set([
            ...(t.baselineSubjects || []),
            ...p.rows.map((r) => r.subject),
          ]),
        ],
        version: t.version + 1,
      });
      this.store.put("distributionPreview", {
        ...p,
        selectedSubjects: selected,
        confirmedAt: now(),
      });
      this.reconcile(id);
      return this.list().find((x) => x.id === id);
    });
  }
  reconcile(only) {
    for (const id of Object.keys(targetNames).filter(
      (id) => !only || only === id,
    )) {
      const target = this.config(id);
      if (!target.enabled) continue;
      if (id === "all-api-hub") this.observeHub();
      const entries = this.managedEntries(id);
      const subjects = new Set(entries.map((e) => e.subject));
      for (const j of this.store
        .list("delivery")
        .filter(
          (j) =>
            j.target === id &&
            j.state !== "superseded" &&
            !subjects.has(j.subject),
        ))
        this.store.put("delivery", {
          ...j,
          state: "superseded",
          supersededAt: now(),
          reason: "配置已合并、移除或不再需要分发；保留历史",
        });
      for (const e of entries) {
        if (
          target.baselineSubjects?.includes(e.subject) &&
          !target.managedSubjects?.includes(e.subject)
        )
          continue;
        const revision = digest(e.payload),
          link = this.store.get("targetLink", `${id}:${e.subject}`);
        const jobs = this.store
          .list("delivery")
          .filter((j) => j.target === id && j.subject === e.subject);
        const latest = jobs.filter((j) => j.state !== "superseded").at(-1);
        for (const j of jobs.filter(
          (j) => j.state === "conflict" && j.id !== latest?.id,
        ))
          this.store.put("delivery", {
            ...j,
            state: "superseded",
            supersededBy: latest.id,
          });
        if (id === "all-api-hub") {
          this.reconcileHub(e, revision, link, jobs);
          continue;
        }
        if (latest?.revision === revision) continue;
        for (const j of jobs.filter(
          (j) =>
            ["pending", "waiting", "failed", "conflict"].includes(j.state) ||
            (j.state === "running" &&
              Date.parse(j.leaseUntil || 0) <= Date.now()),
        ))
          this.store.put("delivery", { ...j, state: "superseded" });
        this.store.put("delivery", {
          id: randomUUID(),
          target: id,
          subject: e.subject,
          revision,
          payload: e.payload,
          state: link?.state === "conflict" ? "conflict" : "pending",
          createdAt: now(),
          attempts: 0,
        });
      }
    }
  }
  // Acts once per decision: a job only when the extension's current switch
  // differs. Later changes made in the extension are left alone.
  reconcileHub(e, revision, link, jobs) {
    if (link?.decidedRevision === revision) return;
    if (
      jobs.some(
        (j) =>
          j.state === "running" && Date.parse(j.leaseUntil || 0) > Date.now(),
      )
    )
      return;
    const want = e.payload.automaticExecutionEnabled;
    const current =
      want == null
        ? null
        : e.payload.externalId &&
          this.hubCurrent(this.store.get("account", e.subject), link);
    if (want != null && !current) return;
    const needed = want != null && current.automaticExecutionEnabled !== want;
    for (const j of jobs.filter((j) =>
      ["pending", "waiting", "failed", "conflict", "running"].includes(j.state),
    ))
      this.store.put("delivery", {
        ...j,
        state: "superseded",
        supersededAt: now(),
        reason:
          want == null
            ? "中心不再调整自动签到"
            : needed
              ? "中心决定已更新"
              : hubInPlace,
      });
    if (needed)
      this.store.put("delivery", {
        id: randomUUID(),
        target: "all-api-hub",
        subject: e.subject,
        revision,
        payload: e.payload,
        state: "pending",
        createdAt: now(),
        attempts: 0,
      });
    this.store.put("targetLink", {
      ...(link || {
        id: `all-api-hub:${e.subject}`,
        target: "all-api-hub",
        subject: e.subject,
      }),
      decidedRevision: revision,
    });
  }
  hubStatus(e) {
    if (!e.payload.externalId)
      return { state: "waiting", reason: "需要在插件完成登录关联" };
    const link = this.store.get("targetLink", `all-api-hub:${e.subject}`);
    if (
      e.payload.automaticExecutionEnabled != null &&
      link?.decidedRevision !== digest(e.payload) &&
      !this.hubCurrent(this.store.get("account", e.subject), link)
    )
      return { state: "waiting", reason: hubWaiting };
    return null;
  }
  diff(id) {
    const j = this.store.require("delivery", id),
      link = this.store.get("targetLink", `${j.target}:${j.subject}`),
      p = j.payload;
    const desired =
      j.target === "newapi"
        ? {
            name: p.name,
            base_url: p.baseUrl,
            models: p.models.join(","),
            status: p.enabled ? 1 : 2,
          }
        : j.target === "all-api-hub"
          ? p.automaticExecutionEnabled == null
            ? {}
            : { automaticExecutionEnabled: p.automaticExecutionEnabled }
          : Object.fromEntries(
              ["name", "baseUrl", "protocol", "models", "enabled", "order"].map(
                (k) => [k, p[k]],
              ),
            );
    const actual = publicValue(
      (j.target === "all-api-hub" &&
        this.hubCurrent(this.store.get("account", j.subject), link)) ||
        link?.conflictSnapshot ||
        link?.snapshot ||
        {},
    );
    return {
      id,
      changes: Object.keys(desired)
        .filter((k) => !same(desired[k], actual[k]))
        .map((field) => ({
          field,
          center: desired[field] ?? null,
          target: actual[field] ?? null,
        })),
    };
  }
  jobs(query = {}) {
    const jobs = Object.keys(targetNames)
      .filter((id) => !query.target || id === query.target)
      .flatMap((id) => this.currentJobs(id));
    const result = jobs
      .filter((j) => !query.subject || query.subject === j.subject)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((j) =>
        publicValue({ ...j, payload: undefined, receipt: undefined }),
      );
    if (!query.target || query.target === "all-api-hub") {
      for (const a of this.store
        .list("account")
        .filter(
          (a) =>
            !a.mergedInto &&
            (!query.subject || query.subject === a.id) &&
            !this.store.get("site", a.siteId)?.removed,
        )) {
        const status = this.hubEligibility(a);
        if (status.state === "not_applicable")
          result.push({
            id: `not-applicable:${a.id}`,
            subject: a.id,
            target: "all-api-hub",
            ...status,
          });
      }
      result.push(...this.hubPending(query.subject));
    }
    return result.slice(0, query.subject ? undefined : 200);
  }
  // Waiting states that have no job: nothing is sent until the account is
  // linked and its current values are known exactly.
  hubPending(subject) {
    if (!this.config("all-api-hub").enabled) return [];
    const current = new Set(
      this.currentJobs("all-api-hub").map((j) => j.subject),
    );
    return this.managedEntries("all-api-hub")
      .filter(
        (e) => (!subject || e.subject === subject) && !current.has(e.subject),
      )
      .flatMap((e) => {
        const status = this.hubStatus(e);
        return status
          ? [
              {
                id: `waiting:${e.subject}`,
                subject: e.subject,
                target: "all-api-hub",
                retryable: false,
                ...status,
              },
            ]
          : [];
      });
  }
  channelStatus(id) {
    return this.currentJobs("newapi")
      .filter((j) => j.subject === id)
      .map((j) => publicValue({ ...j, payload: undefined, receipt: undefined }));
  }
  observeNewApi(sourceId, channels, startedAt) {
    const target = this.config("newapi");
    if (!target.enabled || this.source(target).id !== sourceId) return;
    for (const link of this.store
      .list("targetLink")
      .filter((l) => l.target === "newapi" && l.remoteId)) {
      // An inventory read begun before a write cannot contradict its readback.
      if (Date.parse(link.appliedAt || 0) > startedAt) continue;
      const remote = channels.find(
        (c) => String(c.id) === String(link.remoteId),
      );
      if (!remote) continue;
      this.observeConfiguration(link, owned(remote), now());
    }
  }
  // A stop is held until its reason ends. Archiving requires automatic
  // check-in to be on, so a recovered archive turns it back on.
  observeHub() {
    for (const a of this.hubAccounts()) {
      const id = `all-api-hub:${a.id}`,
        link = this.store.get("targetLink", id);
      if (a.checkinArchive?.active && !link?.checkinHold)
        this.store.put("targetLink", {
          ...(link || { id, target: "all-api-hub", subject: a.id }),
          checkinHold: { reason: "archived", at: now() },
        });
      else if (
        link?.checkinHold &&
        !a.checkinArchive?.active &&
        !a.checkinAccountId &&
        this.hubCurrent(a, link)?.automaticExecutionEnabled === true
      )
        this.store.put("targetLink", { ...link, checkinHold: null });
    }
  }
  observeConfiguration(link, actual, observedAt) {
    if (Date.parse(observedAt) <= Date.parse(link.observedAt || 0)) return;
    const job = this.store
      .list("delivery")
      .filter(
        (j) =>
          j.target === link.target &&
          j.subject === link.subject &&
          j.state !== "superseded",
      )
      .at(-1);
    const changed = link.snapshot && digest(actual) !== digest(link.snapshot);
    const conflict = changed && job?.state === "applied";
    this.store.put("targetLink", {
      ...link,
      observedSnapshot: actual,
      observedAt,
      ...(conflict || link.state === "conflict"
        ? { state: "conflict", conflictSnapshot: actual }
        : {}),
    });
    if (conflict)
      this.store.put("delivery", {
        ...job,
        state: "conflict",
        reason: `${targetNames[link.target]} 配置已改变，请处理同步差异`,
      });
  }
  runtimeEnabled(c) {
    const link = this.store.get("targetLink", `newapi:${c.id}`);
    if (
      link?.observedSnapshot &&
      Date.parse(link.observedAt) >= Date.parse(link.appliedAt || 0)
    )
      return link.observedSnapshot.status === 1;
    if (link?.snapshot && link.appliedAt) return link.snapshot.status === 1;
    const observation = c.sourceObservation;
    if (
      observation?.gateway?.sourceId === c.gateway?.sourceId &&
      String(observation?.gateway?.channelId) ===
        String(c.gateway?.channelId) &&
      (this.store.setting("sources") || []).some(
        (s) => s.id === c.gateway?.sourceId && s.kind === "newapi",
      )
    )
      return observation.present !== false && observation.enabled === true;
    return null;
  }
  retry(id) {
    const j = this.store.require("delivery", id);
    if (j.state === "applied" || j.state === "superseded")
      throw new Problem(409, "该任务不需要重试");
    if (j.state === "conflict")
      throw new Problem(409, "请先选择采用目标或恢复中心配置");
    return this.store.put("delivery", {
      ...j,
      state: "pending",
      retryAt: null,
      reason: null,
      leaseUntil: null,
    });
  }
  async resolve(id, choice) {
    const j = this.store.require("delivery", id),
      linkId = `${j.target}:${j.subject}`,
      link = this.store.require("targetLink", linkId);
    const current = this.entries(j.target).find((e) => e.subject === j.subject);
    if (current && digest(current.payload) !== j.revision)
      throw new Problem(409, "中心配置已变化，请读取最新同步任务");
    if (j.state !== "conflict") throw new Problem(409, "此任务没有待处理冲突");
    if (choice === "target") {
      const remote =
        j.target === "newapi"
          ? owned(
              await this.sources.request(
                this.source(this.config(j.target)),
                `/api/channel/${link.remoteId}`,
              ),
            )
          : link.conflictSnapshot;
      if (!remote) throw new Problem(409, "请让目标重新回报当前配置");
      this.store.transaction(() => {
        // Center updates reconcile against this link, so it must read as adopted first.
        this.store.put("targetLink", {
          ...link,
          snapshot: remote,
          state: "adopted",
          conflictSnapshot: null,
        });
        if (j.target === "newapi") {
          const c = this.store.require("channel", j.subject);
          this.resources.update("channel", c.id, c.version, {
            name: remote.name,
            baseUrl: remote.base_url,
            models: remote.models.split(",").filter(Boolean),
            enabled: remote.status === 1,
          });
        } else if (j.target !== "all-api-hub")
          throw new Problem(400, "镜像不支持反向采用配置");
        this.store.put("targetLink", {
          ...link,
          snapshot: remote,
          state: "applied",
          conflictSnapshot: null,
          // The extension keeps its values; this decision is not pushed again.
          ...(j.target === "all-api-hub"
            ? { decidedRevision: j.revision }
            : {}),
        });
        this.store.put("delivery", { ...j, state: "superseded" });
        this.reconcile(j.target);
      });
    } else {
      this.store.put("targetLink", {
        ...link,
        snapshot: link.conflictSnapshot || link.snapshot,
        state: "adopted",
        conflictSnapshot: null,
      });
      this.store.put("delivery", {
        ...j,
        state: "pending",
        force: true,
        retryAt: null,
      });
    }
    return { resolved: true };
  }
  async tick() {
    if (this.running) return;
    if (this.lastTick && Date.now() - this.lastTick < 5000) return;
    this.lastTick = Date.now();
    this.running = true;
    try {
      this.reconcile();
      const j = this.store
        .list("delivery")
        .find(
          (j) =>
            ["pending", "failed", "waiting", "running"].includes(j.state) &&
            ["newapi", "notion"].includes(j.target) &&
            this.config(j.target).enabled &&
            (!j.retryAt || Date.parse(j.retryAt) <= Date.now()) &&
            (!j.leaseUntil || Date.parse(j.leaseUntil) <= Date.now()),
        );
      if (!j) return;
      this.store.put("delivery", {
        ...j,
        state: "running",
        leaseUntil: new Date(Date.now() + 120000).toISOString(),
        attempts: j.attempts + 1,
      });
      try {
        const result =
          j.target === "newapi"
            ? await this.applyNewApi(j)
            : await this.notion.apply(this.config("notion"), j);
        this.finish(j.id, result);
      } catch (e) {
        const state =
          e.code === "target_conflict"
            ? "conflict"
            : e.statusCode === 409
              ? "waiting"
              : "failed";
        this.store.put("delivery", {
          ...this.store.require("delivery", j.id),
          state,
          reason: errorMessage(e),
          retryAt: new Date(
            Date.now() +
              Math.min(3600, 60 * 2 ** Math.min(j.attempts, 6)) * 1000,
          ).toISOString(),
          leaseUntil: null,
        });
      }
    } finally {
      this.running = false;
    }
  }
  finish(id, result) {
    const j = this.store.require("delivery", id),
      linkId = `${j.target}:${j.subject}`,
      link = this.store.get("targetLink", linkId) || {
        id: linkId,
        target: j.target,
        subject: j.subject,
      };
    const state = result.state || "applied";
    if (j.target === "all-api-hub")
      return this.finishHub(j, link, state, result);
    if (j.target === "newapi" && state === "applied") {
      for (const o of this.store
        .list("offering")
        .filter(
          (o) =>
            o.channelId === j.subject && j.payload.models?.includes(o.modelId),
        ))
        if (["pending_sync", "distributed"].includes(o.apply?.state))
          this.store.put("offering", {
            ...o,
            apply: {
              state: "distributed",
              at: now(),
              remoteId: result.remoteId,
            },
          });
    }
    this.store.put("delivery", {
      ...j,
      state,
      reason: result.reason || null,
      appliedAt: state === "applied" ? now() : null,
      leaseUntil: null,
      receipt: result,
      retryAt:
        state === "waiting"
          ? new Date(Date.now() + 3600000).toISOString()
          : null,
    });
    this.store.put("targetLink", {
      ...link,
      state,
      remoteId: result.remoteId || link.remoteId,
      ...(state === "applied"
        ? {
            snapshot: result.snapshot,
            appliedRevision: j.revision,
            appliedAt: now(),
          }
        : state === "conflict"
          ? { conflictSnapshot: result.snapshot }
          : {}),
    });
    if (state === "applied") this.onApplied?.(j);
    return { acknowledged: true, id, state };
  }
  // The extension checks drift against its own last applied snapshot, so a
  // change it made to the fields it owns arrives as a conflict.
  finishHub(j, link, state, result) {
    const at = now(),
      snapshot = result.snapshot || null;
    const next =
      state !== "conflict"
        ? {
            state,
            reason: result.reason || null,
            appliedAt: state === "applied" ? at : null,
            retryAt: state === "waiting" ? later(60) : null,
          }
        : !snapshot
          ? {
              state: "waiting",
              reason: result.reason || "插件未回报当前账号资料",
              retryAt: later(60),
            }
          : snapshot.automaticExecutionEnabled ===
              j.payload.automaticExecutionEnabled
            ? { state: "superseded", supersededAt: at, reason: hubInPlace }
            : {
                state: "pending",
                force: true,
                reason: "插件资料与上次回执不同，按插件当前值重新下发",
                retryAt: j.force ? later(10) : null,
              };
    this.store.put("delivery", {
      ...j,
      ...next,
      leaseUntil: null,
      receipt: result,
    });
    this.store.put("targetLink", {
      ...link,
      remoteId: result.remoteId || link.remoteId,
      ...(snapshot ? { reported: { at, snapshot } } : {}),
      ...(state === "applied"
        ? {
            state,
            snapshot,
            appliedRevision: j.revision,
            appliedAt: at,
            checkinHold:
              j.payload.automaticExecutionEnabled === false
                ? { reason: j.payload.reason, at }
                : null,
          }
        : {}),
    });
    if (state === "applied") this.onApplied?.(j);
    return { acknowledged: true, id: j.id, state: next.state };
  }
  async applyNewApi(j) {
    this.gateway.writable();
    if (
      this.entries("newapi").find((e) => e.subject === j.subject) &&
      digest(
        this.entries("newapi").find((e) => e.subject === j.subject).payload,
      ) !== j.revision
    )
      return { state: "superseded", reason: "中心配置已更新" };
    const t = this.config("newapi"),
      source = this.source(t),
      p = j.payload,
      c = this.store.require("channel", j.subject),
      link = this.store.get("targetLink", `newapi:${c.id}`);
    const shouldEnable = p.enabled && p.routing?.available !== false;
    if (
      tagsOf(c).includes("client_restricted") &&
      !c.nativePassthrough &&
      shouldEnable
    )
      throw new Problem(409, "等待指定客户端验证 New API 透传");
    if (shouldEnable && (!p.credentialId || !p.models.length))
      throw new Problem(409, "等待补 key 或选定模型");
    const unverified = p.models.filter(
      (m) =>
        !(
          link?.approvedConnectionVersion === p.connectionVersion &&
          link.approvedModels?.includes(m)
        ) &&
        !this.store
          .list("offering")
          .some(
            (o) => o.channelId === c.id && o.modelId === m && verified(o, c),
          ),
    );
    if (shouldEnable && unverified.length)
      throw new Problem(409, `等待模型任务验证：${unverified.join("、")}`);
    let remote = link?.remoteId
      ? await this.sources.request(source, `/api/channel/${link.remoteId}`)
      : await findByTag(this.sources, source, `arc-managed-${c.id}`);
    if (!remote && !shouldEnable) {
      if (p.enabled)
        throw new Problem(409, p.routing?.reasons.join("、") || "权益尚不可用");
      return { remoteId: null, snapshot: null };
    }
    const desired = {
      name: p.name,
      base_url: p.baseUrl,
      models: p.models.join(","),
      status: shouldEnable ? 1 : 2,
      ...(p.routing?.priority != null
        ? { priority: p.routing.priority, weight: p.routing.weight }
        : {}),
      auto_ban: 0,
      header_override:
        c.headersManagedBy === "manual" ||
        c.credentialHeadersId ||
        p.headerValues.length
          ? headerOverride(p.headerValues)
          : remote?.header_override || "",
      type: channelType(p.protocol, remote),
    };
    const write = shouldEnable ? desired : { status: 2 };
    if (
      remote &&
      link?.snapshot &&
      !j.force &&
      digest(owned(remote)) !== digest(link.snapshot) &&
      digest(owned(remote)) !== digest(j.expectedSnapshot)
    ) {
      this.store.put("targetLink", {
        ...link,
        remoteId: remote.id,
        conflictSnapshot: owned(remote),
        state: "conflict",
      });
      throw new Problem(
        409,
        "New API 托管字段已被外部修改",
        undefined,
        "target_conflict",
      );
    }
    this.store.put("delivery", {
      ...this.store.require("delivery", j.id),
      expectedSnapshot: owned({ ...remote, ...write }),
    });
    if (remote) {
      if (
        Object.entries(write).some(
          ([key, value]) =>
            key !== "auto_ban" && String(remote[key] ?? "") !== String(value),
        )
      )
        await this.sources.configureChannel(source, {
          id: remote.id,
          ...write,
        });
      if (remote.status !== desired.status)
        await this.sources.request(
          source,
          `/api/channel/${remote.id}/status`,
          "POST",
          { status: desired.status },
        );
    } else {
      if (j.creationPending)
        throw new Problem(
          409,
          "上次创建尚未确认，按稳定标识继续回读，避免重复渠道",
        );
      this.store.put("delivery", {
        ...this.store.require("delivery", j.id),
        creationPending: true,
      });
      await this.sources.request(source, "/api/channel/", "POST", {
        mode: "single",
        channel: {
          priority: 0,
          weight: 100,
          ...desired,
          key: this.store.reveal(p.credentialId),
          group: "default",
          tag: `arc-managed-${c.id}`,
          ...passthroughSetting(c),
        },
      });
      remote = await findByTag(this.sources, source, `arc-managed-${c.id}`);
      if (!remote) throw new Problem(502, "创建后尚未回读到渠道");
    }
    if (
      p.enabled &&
      link?.credentialFingerprint !== p.credentialFingerprint &&
      p.credentialId
    )
      await this.sources.configureChannel(source, {
        id: remote.id,
        key: this.store.reveal(p.credentialId),
      });
    const after = await this.sources.request(
      source,
      `/api/channel/${remote.id}`,
    );
    if (
      Object.entries(write).some(
        ([k, v]) =>
          k !== "auto_ban" &&
          String(k === "models" ? v.split(",").sort().join(",") : v) !==
            String(owned(after)[k]),
      )
    )
      throw new Problem(502, "New API 写入后回读不一致");
    this.store.put("targetLink", {
      ...(link || {}),
      id: `newapi:${c.id}`,
      target: "newapi",
      subject: c.id,
      credentialFingerprint: p.credentialFingerprint,
    });
    this.store.put("channel", {
      ...this.store.require("channel", c.id),
      gateway: { sourceId: source.id, channelId: after.id },
      apply: "synced",
    });
    for (const o of this.store
      .list("offering")
      .filter(
        (o) =>
          o.channelId === c.id &&
          o.apply?.state === "pending_sync" &&
          p.models.includes(o.modelId),
      ))
      this.store.put("offering", {
        ...o,
        productionGateway: { sourceId: source.id, channelId: after.id },
        apply: { state: "distributed", at: now() },
      });
    return {
      remoteId: after.id,
      snapshot: owned(after),
      reason: !shouldEnable && p.enabled ? p.routing?.reasons.join("、") : null,
    };
  }
  claim(auth) {
    if (
      auth.role !== "connector" ||
      !["all-api-hub", "chrome-bookmarks"].includes(auth.scope.target)
    )
      throw new Problem(403, "需要绑定目标的独立执行凭据");
    const target = auth.scope.target,
      t = this.config(target);
    if (
      auth.scope.sourceId !==
      (t.sourceId || (target === "chrome-bookmarks" ? "all-api-hub" : target))
    )
      throw new Problem(403, "执行凭据与目标不匹配");
    if (!t.enabled) return { items: [] };
    this.reconcile(target);
    const jobs = this.store
      .list("delivery")
      .filter(
        (j) =>
          j.target === target &&
          ["pending", "failed", "waiting", "running"].includes(j.state) &&
          (!j.retryAt || Date.parse(j.retryAt) <= Date.now()) &&
          (!j.leaseUntil || Date.parse(j.leaseUntil) <= Date.now()) &&
          (!auth.scope.channelIds?.length ||
            auth.scope.channelIds.includes(j.subject)),
      )
      .slice(0, 20);
    return {
      items: jobs
        .map((j) => {
          const link = this.store.get("targetLink", `${target}:${j.subject}`);
          let payload = publicValue({ ...j.payload, headerValues: undefined }),
            expected = publicValue(link?.snapshot),
            echo;
          if (target === "all-api-hub") {
            const current = this.hubCurrent(
              this.store.get("account", j.subject),
              link,
            );
            if (
              !current ||
              current.automaticExecutionEnabled ===
                j.payload.automaticExecutionEnabled
            ) {
              this.store.put("delivery", {
                ...j,
                ...(current
                  ? {
                      state: "superseded",
                      supersededAt: now(),
                      reason: hubInPlace,
                    }
                  : {
                      state: "waiting",
                      retryAt: later(10),
                      reason: hubWaiting,
                    }),
                leaseUntil: null,
              });
              return null;
            }
            // The extension writes name and check-in entry unconditionally, so
            // they are sent exactly as it holds them now.
            echo = {
              name: current.name,
              checkinUrl: current.checkinUrl,
              disabled: current.disabled,
            };
            payload = { ...payload, ...echo };
            expected = current;
          }
          const lease = randomUUID();
          this.store.put("delivery", {
            ...j,
            state: "running",
            lease,
            leaseUntil: new Date(Date.now() + 120000).toISOString(),
            ...(echo ? { echo } : {}),
          });
          return {
            id: j.id,
            lease,
            subject: j.subject,
            revision: j.revision,
            payload,
            expected,
            force: !!j.force,
            rootId: t.rootId || null,
          };
        })
        .filter(Boolean),
    };
  }
  acknowledge(auth, input) {
    const j = this.store.require("delivery", input.id),
      t = this.config(j.target);
    if (
      auth.role !== "connector" ||
      auth.scope.target !== j.target ||
      auth.scope.sourceId !==
        (t.sourceId ||
          (j.target === "chrome-bookmarks" ? "all-api-hub" : j.target)) ||
      (auth.scope.channelIds?.length &&
        !auth.scope.channelIds.includes(j.subject))
    )
      throw new Problem(403, "无权回执该任务");
    if (
      [
        "applied",
        "waiting",
        "failed",
        "conflict",
        "pending",
        "superseded",
      ].includes(j.state) &&
      j.lease === input.lease
    )
      return { acknowledged: true, id: j.id, state: j.state };
    if (input.lease !== j.lease || j.state !== "running")
      throw new Problem(409, "任务租约已变化，请重新领取");
    if (input.reason) input.reason = errorMessage(input.reason);
    return this.finish(j.id, {
      ...input,
      snapshot: withoutSecrets(input.snapshot),
    });
  }
}
