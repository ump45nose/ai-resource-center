import { policies } from "./resources.mjs";
import { reviewManaged } from "./maintenance-policy.mjs";
import { reconcileCheckinArchives } from "./checkin-health.mjs";

export class Scheduler {
  constructor(store, operations, scans, gateway, maintenance) {
    Object.assign(this, { store, operations, scans, gateway, maintenance });
  }
  tick() {
    const minute = Math.floor(Date.now() / 60000);
    if (this.lastMinute === minute) return;
    this.lastMinute = minute;
    const p = policies(this.store);

    const now = Date.now(),
      slot = Math.floor(now / 60000);
    const due = (key, minutes) => {
      const last = this.store.setting(`schedule:${key}`) || 0;
      if (now - last < minutes * 60000) return false;
      this.store.setting(`schedule:${key}`, now);
      return true;
    };
    const active = this.store
      .list("operation")
      .filter((o) => ["queued", "running"].includes(o.state));
    for (const s of this.store.setting("sources") || []) {
      if (
        s.kind !== "newapi" ||
        s.enabled === false ||
        !s.syncEnabled ||
        active.some(
          (o) =>
            ["sync", "preview"].includes(o.kind) && o.input.sourceId === s.id,
        )
      )
        continue;
      if (due(`inventory:${s.id}`, s.inventoryMinutes || 10)) {
        due(`calls:${s.id}`, 0);
        this.operations.start("sync", {
          requestId: `auto-sync:${s.id}:${slot}`,
          sourceId: s.id,
          scope: "all",
        });
      } else if (due(`calls:${s.id}`, s.callsMinutes || 1))
        this.operations.start("sync", {
          requestId: `auto-calls:${s.id}:${slot}`,
          sourceId: s.id,
          scope: "calls",
        });
    }
    if (!p.enabled) return;
    reconcileCheckinArchives(this.store);
    const ids = [];
    for (const c of this.store.list("channel")) {
      if (!reviewManaged(this.store, c)) continue;
      const status = this.maintenance.status(c, { now });
      if (
        status.nextCheckAt &&
        Date.parse(status.nextCheckAt) <= now &&
        !active.some(
          (op) =>
            ["scan", "maintain"].includes(op.kind) &&
            (!op.input.channelIds?.length ||
              op.input.channelIds.includes(c.id)),
        )
      )
        ids.push(c.id);
    }
    if (ids.length)
      this.operations.start("maintain", {
        requestId: `auto-maintain:${slot}`,
        channelIds: ids,
      });
    // Fresh scans can also have been requested manually. They share the same budget and task queue.
    const fresh = this.store
      .list("channel")
      .filter(
        (c) =>
          c.lastScanAt &&
          now - Date.parse(c.lastScanAt) < p.maintenanceHours * 3600000,
      )
      .map((c) => c.id);
    this.maintenance.queue(fresh, `scheduled:${slot}`);
    if (p.autoApply && this.gateway.allowWrites && due("grades", 60))
      this.gateway.refreshGrades();
  }
}
