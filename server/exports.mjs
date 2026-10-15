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
          ANTHROPIC_BASE_URL: c.baseUrl
            .replace(/\/v1\/?$/, "")
            .replace(/\/$/, ""),
          ...(c.authType === "api_key"
            ? { ANTHROPIC_API_KEY: key }
            : { ANTHROPIC_AUTH_TOKEN: key }),
          ANTHROPIC_MODEL: c.context1m ? model + "[1m]" : model,
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
  if (client === "Magpie" && c.protocol === "Gemini")
    throw new Problem(400, "Magpie 当前配置没有已确认的 Gemini 原生入口");
  if (client === "Magpie")
    return JSON.stringify(
      {
        id: c.id,
        name: c.name,
        baseAPI:
          c.protocol === "Anthropic"
            ? "anthropic"
            : c.protocol === "OpenAI Responses"
              ? "responses"
              : "chat",
        key,
        ...(c.protocol === "Anthropic"
          ? { authHeader: c.authType === "api_key" ? "x-api-key" : "bearer" }
          : {}),
        anthropic:
          c.protocol === "Anthropic"
            ? c.baseUrl.replace(/\/v1\/?$/, "").replace(/\/$/, "")
            : "",
        responses: c.protocol === "OpenAI Responses" ? c.baseUrl : "",
        chat: c.protocol === "OpenAI" ? c.baseUrl : "",
        headers: h,
        models: c.models,
        ...(c.category === "client" ? { passUserAgent: true } : {}),
        ...(c.context1m
          ? { contexts: Object.fromEntries(c.models.map((m) => [m, 1000000])) }
          : {}),
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
            options: {
              baseURL:
                c.protocol === "Anthropic"
                  ? c.baseUrl.replace(/\/v1\/?$/, "").replace(/\/$/, "") + "/v1"
                  : c.baseUrl,
              ...(c.protocol === "Anthropic" && c.authType !== "api_key"
                ? { authToken: key }
                : { apiKey: key }),
              headers: h,
            },
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
  if (["Hermes Chat", "Hermes Cron"].includes(client)) {
    if (c.protocol === "Gemini")
      throw new Problem(400, "Hermes 自定义端点没有已确认的 Gemini 原生配置");
    const name =
      client === "Hermes Cron"
        ? "resource-center-cron"
        : "resource-center-chat";
    return JSON.stringify(
      {
        model: { default: model, provider: name },
        providers: {
          [name]: {
            name: c.name,
            api: c.baseUrl,
            api_key: key,
            transport:
              c.protocol === "Anthropic"
                ? "anthropic_messages"
                : c.protocol === "OpenAI Responses"
                  ? "codex_responses"
                  : "chat_completions",
            default_model: model,
            discover_models: false,
            extra_headers: h,
          },
        },
      },
      null,
      2,
    );
  }
  throw new Problem(400, "客户端尚无已确认的配置格式");
}
