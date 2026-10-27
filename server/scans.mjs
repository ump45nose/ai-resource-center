import { probeBlock, channelHeaders, archiveOf } from "./channel-rules.mjs";
import { eligible, policies } from "./resources.mjs";
import { scanSite, assessment } from "./model-scan.mjs";
import { modelPreference, verified } from "./maintenance-policy.mjs";
import { observeScanHealth } from "./channel-health.mjs";
import { Problem } from "./errors.mjs";

export class Scans {
  constructor(store, fetcher = fetch) {
    this.store = store;
    this.fetch = fetcher;
  }
  async run(input, progress) {
    const ids = input.channelIds || [];
    const policy = policies(this.store);
    const sites = this.store.list("site");
    const channels = this.store
      .list("channel")
      .filter(
        (c) =>
          (!ids.length || ids.includes(c.id)) &&
          (!input.siteIds?.length || input.siteIds.includes(c.siteId)),
      );
    for (const c of channels.filter((c) =>
      eligible(this.store, c, { media: true }),
    ))
      this.store.put("channel", {
        ...c,
        maintenance: {
          ...c.maintenance,
          lastScanAttemptAt: new Date().toISOString(),
        },
      });
    const excluded = channels
      .filter((c) => !eligible(this.store, c, { media: true }))
      .map((c) => ({
        channelId: c.id,
        reason: probeBlock(this.store, c) || "此渠道不参加主动验证",
      }));
    const targets = new Map();
    for (const c of channels.filter((c) =>
      eligible(this.store, c, { media: true }),
    )) {
      const site = sites.find((s) => s.id === c.siteId),
        url = new URL(site?.url || c.baseUrl).origin;
      if (!targets.has(url))
        targets.set(url, {
          url,
          name: site?.name || c.name,
          siteIds: new Set(),
          channels: [],
        });
      targets.get(url).siteIds.add(c.siteId);
      targets.get(url).channels.push({
        ...c,
        authType: c.authType || "bearer",
        headers: channelHeaders(this.store, c),
      });
    }
    const queue = [...targets.values()],
      results = [];
    progress({
      stage: "读取模型目录与站方指标",
      result: { completed: 0, total: queue.length, excluded },
    });
    await Promise.all(
      Array.from(
        { length: Math.min(policy.scanConcurrency || 5, queue.length) },
        async () => {
          while (queue.length) {
            const target = queue.shift();
            target.channels = target.channels.filter((c) =>
              eligible(this.store, this.store.require("channel", c.id), {
                media: true,
              }),
            );
            if (!target.channels.length) continue;
            let website;
            try {
              const r = await this.fetch(target.url, {
                method: "GET",
                redirect: "follow",
                signal: AbortSignal.timeout(15000),
              });
              await r.body?.cancel();
              website = {
                observedAt: new Date().toISOString(),
                status: r.ok ? "reachable" : "http_error",
                httpStatus: r.status,
              };
            } catch {
              website = {
                observedAt: new Date().toISOString(),
                status: "unreachable",
              };
            }
            const result = await scanSite(target, {
              store: this.store,
              fetcher: this.fetch,
              detailLimit: policy.maxCandidates,
            });
            result.website = website;
            this.persist(result, target.siteIds);
            results.push(result);
            progress({
              result: {
                completed: results.length,
                total: targets.size,
                excluded,
                sites: results,
              },
            });
          }
        },
      ),
    );
    return { sites: results, excluded };
  }
  persist(result, siteIds) {
    this.store.transaction(() => {
      this.store.put("modelScan", { ...result, id: result.url });
      for (const id of siteIds) {
        const site = this.store.require("site", id);
        this.store.put("site", {
          ...site,
          websiteObservation: result.website,
          version: site.version,
        });
      }
      for (const catalog of result.channelCatalogs) {
        const c = this.store.require("channel", catalog.channelId);
        if (
          !eligible(this.store, c, { media: true }) ||
          (catalog.connectionVersion || 1) !== (c.connectionVersion || 1)
        )
          continue;
        this.store.put("channel", {
          ...c,
          lastScanAt: result.scannedAt,
          catalogObservation: {
            status: catalog.status,
            at: result.scannedAt,
            connectionVersion: c.connectionVersion || 1,
          },
          retryAt:
            catalog.status === "rate_limited" ? catalog.retryAt || null : null,
          credentialState:
            catalog.status === "ok"
              ? "present"
              : catalog.status === "login_required"
                ? "authentication_failed"
                : catalog.status,
          version: c.version,
        });
        if (catalog.status !== "ok") continue;
        const listed = new Set(catalog.models);
        for (const o of this.store
          .list("offering")
          .filter((o) => o.channelId === c.id && !listed.has(o.modelId)))
          this.store.put("offering", {
            ...o,
            catalog: { present: false, observedAt: result.scannedAt },
            version: o.version + 1,
          });
        for (const modelId of listed) {
          const id = `${c.id}:${modelId}`,
            old = this.store.get("offering", id);
          const metrics = result.metrics?.find((m) => m.name === modelId);
          const groups = result.groups.filter((g) => g.model === modelId);
          this.store.put("offering", {
            ...old,
            id,
            channelId: c.id,
            modelId,
            capabilityClass: old?.capabilityClass || "unclassified",
            catalog: {
              present: true,
              observedAt: result.scannedAt,
              connectionVersion: c.connectionVersion || 1,
            },
            proposedClass:
              modelPreference(modelId, policies(this.store))?.proposedClass ||
              "unclassified",
            stationMetrics: metrics || null,
            stationGroups: groups,
            candidate: metrics ? assessment(metrics) : "无统计数据",
            version: old ? old.version + 1 : 1,
          });
        }
      }
    });
    observeScanHealth(this.store, result);
    this.onChange?.();
  }
  candidates(channelId) {
    const c = this.store.require("channel", channelId);
    if (!eligible(this.store, c))
      throw new Problem(400, "该资源不参加主动文字验证");
    const p = policies(this.store),
      now = Date.now();
    return this.store
      .list("offering")
      .filter(
        (o) =>
          o.channelId === channelId &&
          o.catalog?.present &&
          (o.catalog.connectionVersion || 1) === (c.connectionVersion || 1) &&
          modelPreference(o.modelId, p) &&
          !(
            o.stationMetrics?.successRate === 0 ||
            ["最近失败", "近期连续失败"].includes(o.candidate)
          ) &&
          (!verified(o, c) ||
            (o.grade?.samples >= p.samples && o.grade?.successRate < p.warn) ||
            now - Date.parse(o.verification.at) >=
              p.newModelsHours * 3600000) &&
          (!o.verification?.at ||
            (o.verification.connectionVersion || 1) !==
              (c.connectionVersion || 1) ||
            now - Date.parse(o.verification.at) >=
              (o.verification.result === "success" &&
              !archiveOf(c).includes("unstable") &&
              !(o.grade?.samples >= p.samples && o.grade?.successRate < p.warn)
                ? p.newModelsHours
                : p.maintenanceHours) *
                3600000),
      )
      .sort(
        (a, b) =>
          (b.stationMetrics?.successRate ?? -1) -
            (a.stationMetrics?.successRate ?? -1) ||
          modelPreference(a.modelId, p).rank -
            modelPreference(b.modelId, p).rank ||
          Number((c.models || []).includes(b.modelId)) -
            Number((c.models || []).includes(a.modelId)) ||
          b.modelId.localeCompare(a.modelId, undefined, { numeric: true }),
      )
      .slice(0, p.maxCandidates);
  }
}
