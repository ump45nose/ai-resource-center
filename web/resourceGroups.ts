import type { Channel, Site } from "./data";

export const exceptionGroups = [
  { id: "unreachable", label: "网站打不开" },
  { id: "exhausted", label: "无余额无签到" },
  { id: "invalid", label: "网站或 key 失效" },
  { id: "unstable", label: "调用不稳定" },
  { id: "callFailed", label: "调用失败" },
  { id: "maintenance", label: "暂停维护" },
] as const;

export function resourceGroup(channel: Channel, site: Site) {
  if (channel.listGroup === "removed") return "removed";
  return site.siteDown ? "unreachable" : channel.listGroup;
}

export function exceptionSites(
  sites: Site[],
  channels: Channel[],
  group: string,
) {
  const rows = new Map<string, { sites: Site[]; channels: Channel[] }>();
  const siteById = new Map(sites.map((s) => [s.id, s]));
  for (const channel of channels) {
    const site = siteById.get(channel.siteId)!;
    if (resourceGroup(channel, site) !== group) continue;
    const host = new URL(site.url).host.toLowerCase();
    const row = rows.get(host) || { sites: [], channels: [] };
    if (!row.sites.some((s) => s.id === site.id)) row.sites.push(site);
    row.channels.push(channel);
    rows.set(host, row);
  }
  return [...rows.values()];
}
