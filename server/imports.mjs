import ExcelJS from "exceljs";
import { z } from "zod";
export const rowSchema = z
  .object({
    sourceId: z.string().optional(),
    accountSourceId: z.string().optional(),
    accountName: z.string().optional(),
    site: z.object({
      name: z.string(),
      url: z.url(),
      checkinUrl: z.url().optional(),
    }),
    name: z.string(),
    baseUrl: z.url(),
    category: z.enum(["general", "media", "rp", "client"]).optional(),
    protocol: z
      .enum(["OpenAI", "OpenAI Responses", "Anthropic", "Gemini"])
      .optional(),
    models: z.array(z.string()),
    key: z.string().optional(),
    client: z.string().optional(),
    bindings: z.array(z.string()).optional(),
    note: z.string().optional(),
    observedAt: z.string().optional(),
    availability: z.string().optional(),
    gateway: z
      .object({
        sourceId: z.string(),
        channelId: z.number().optional(),
        provider: z.string().optional(),
      })
      .optional(),
    group: z.string().optional(),
    priority: z.number().optional(),
    weight: z.number().optional(),
    nativeCredentialRef: z
      .object({ profileId: z.string(), device: z.string() })
      .optional(),
    applied: z.record(z.string(), z.unknown()).optional(),
    enabled: z.boolean().optional(),
  })
  .strict();
const categories = { 通用: "general", 生图: "media", RP: "rp", Code: "client" };
const value = (v) =>
  v && typeof v === "object"
    ? v.hyperlink ||
      v.text ||
      (v.richText ? v.richText.map((x) => x.text).join("") : "")
    : String(v ?? "");
export async function parseFile(file) {
  if (file.name.endsWith(".json")) {
    const input = JSON.parse(
      Buffer.from(file.content, "base64").toString("utf8"),
    );
    return z.array(rowSchema).parse(input.rows || input);
  }
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(Buffer.from(file.content, "base64"));
  const rows = [];
  for (const sheet of book.worksheets) {
    let columns;
    sheet.eachRow((row, index) => {
      const cells = row.values.map(value);
      if (!columns) {
        if (
          cells.some((v) => /站点|网站|地址/.test(v)) &&
          cells.some((v) => /模型|API|调用/i.test(v))
        ) {
          columns = cells;
          return;
        }
        return;
      }
      const get = (regex, fallback) => {
        const i = columns.findIndex((v) => regex.test(v));
        return value(row.getCell(i > 0 ? i : fallback).value);
      };
      const url = get(/^(站点|网站|站点地址|网站地址)$/, 1);
      if (!/^https?:\/\//.test(url)) return;
      const baseUrl = get(/API.*地址|API.*入口|访问地址/i, 2) || url,
        models = get(/模型/, 3)
          .split(/[,，\n]/)
          .map((x) => x.trim())
          .filter(Boolean);
      rows.push({
        sourceId: `${sheet.name}:${index}`,
        site: {
          name: new URL(url).host,
          url,
          ...(get(/签到.*(地址|入口)/, 5).startsWith("http")
            ? { checkinUrl: get(/签到.*(地址|入口)/, 5) }
            : {}),
        },
        name: new URL(url).host,
        baseUrl,
        models,
        category: categories[sheet.name] || "general",
        ...(get(/^(补充\s*key|key|API.?key|密钥)$/i, 7)
          ? { key: get(/^(补充\s*key|key|API.?key|密钥)$/i, 7) }
          : {}),
        note: [get(/(限制|规则|说明)/, 6), get(/(状态|结果)/, 4)]
          .filter(Boolean)
          .join("\n"),
        enabled: !!categories[sheet.name],
        ...(categories[sheet.name] ? {} : { availability: sheet.name }),
        ...(sheet.name === "Code"
          ? { client: "Claude Code", protocol: "Anthropic" }
          : { protocol: "OpenAI" }),
      });
    });
  }
  return z.array(rowSchema).parse(rows);
}
