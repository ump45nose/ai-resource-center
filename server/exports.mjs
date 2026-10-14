import { Problem } from "./center.mjs";
export function clientConfig(c, client, key, model = c.models[0]) {
  const h = Object.fromEntries(c.headers.map((x) => [x.name, x.value]));
  if (!model || !c.models.includes(model))
    throw new Problem(400, "请选择已保存的模型");
  if (client === "Claude Code") {
    if (c.protocol !== "Anthropic")
      throw new Problem(400, "Claude Code 需要已确认的 Anthropic 协议连接");
    return JSON.stringify(
      {
        env: {
          ANTHROPIC_BASE_URL: c.baseUrl,
          ANTHROPIC_AUTH_TOKEN: key,
          ANTHROPIC_MODEL: model,
          ANTHROPIC_CUSTOM_HEADERS: Object.entries(h)
            .map(([k, v]) => `${k}: ${v}`)
            .join("\n"),
        },
      },
      null,
      2,
    );
  }
  if (client === "Codex") {
    if (c.protocol !== "OpenAI Responses")
      throw new Problem(400, "Codex 配置需要 Responses 协议");
    const literal = JSON.stringify;
    return `model = ${literal(model)}\nmodel_provider = "resource-center"\n\n[model_providers.resource-center]\nname = ${literal(c.name)}\nbase_url = ${literal(c.baseUrl)}\nwire_api = "responses"\nenv_key = "AI_RESOURCE_API_KEY"\nhttp_headers = { ${Object.entries(
      h,
    )
      .map(([k, v]) => `${literal(k)} = ${literal(v)}`)
      .join(", ")} }\n\n# AI_RESOURCE_API_KEY=${key}\n`;
  }
  if (client === "Magpie")
    return JSON.stringify(
      {
        id: c.id,
        name: c.name,
        baseAPI: c.baseUrl,
        key,
        anthropic: c.protocol === "Anthropic",
        responses: c.protocol === "OpenAI Responses",
        chat: c.protocol === "OpenAI",
        headers: h,
        models: c.models.map((id) => ({ id, name: id })),
      },
      null,
      2,
    );
  if (client === "OpenCode")
    return JSON.stringify(
      {
        provider: {
          [c.id]: {
            name: c.name,
            npm:
              c.protocol === "Anthropic"
                ? "@ai-sdk/anthropic"
                : "@ai-sdk/openai-compatible",
            options: { baseURL: c.baseUrl, apiKey: key, headers: h },
            models: Object.fromEntries(c.models.map((m) => [m, { name: m }])),
          },
        },
      },
      null,
      2,
    );
  if (client === "SillyTavern")
    return JSON.stringify(
      {
        name: c.name,
        baseUrl: c.baseUrl,
        protocol: c.protocol,
        models: c.models,
        headers: h,
        key,
      },
      null,
      2,
    );
  if (["Hermes Chat", "Hermes Cron"].includes(client))
    return JSON.stringify(
      {
        base_url: c.baseUrl,
        api_key: key,
        model,
        protocol: c.protocol,
        headers: h,
        application: client,
      },
      null,
      2,
    );
  throw new Problem(400, "客户端尚无已确认的配置格式");
}
