import { randomInt } from "node:crypto";
import { tagsOf } from "./channel-rules.mjs";

export const smokeSupported = (c) =>
  !tagsOf(c).includes("client_restricted") && c.protocol === "OpenAI";

export function verificationTask(channel) {
  const a = randomInt(4, 20),
    b = randomInt(21, 40);
  const code = !(channel.tags || []).includes("no_code");
  return {
    id: code ? "array-review-v1" : "inventory-reasoning-v1",
    purpose: code ? "code" : "chat",
    prompt: code
      ? `检查这段 JavaScript：const values = [${b}, ${a}, ${b}]; const unique = values.sort((a,b)=>a-b);。它本想得到升序去重数组。只返回 JSON：original 为实际 unique 数组，fixed 为正确去重结果，bug 为一句话解释错误。不写 Markdown。`
      : `库存有 ${a} 箱，每箱 3 件；又收到 ${b} 件，随后发出 ${a} 件。只返回 JSON：received 为收货前件数，remaining 为最后件数，explanation 为一句话计算依据。不写 Markdown。`,
    accept(content) {
      let data;
      try {
        data = JSON.parse(
          content.trim().replace(/^```(?:json)?\s*|\s*```$/g, ""),
        );
      } catch {
        return false;
      }
      return code
        ? JSON.stringify(data.original) === JSON.stringify([a, b, b]) &&
            JSON.stringify(data.fixed) === JSON.stringify([a, b]) &&
            typeof data.bug === "string" &&
            data.bug.length > 0
        : data.received === a * 3 &&
            data.remaining === a * 2 + b &&
            typeof data.explanation === "string" &&
            data.explanation.length > 0;
    },
  };
}
