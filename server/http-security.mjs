import { authenticate } from "./auth.mjs";
import { Problem } from "./errors.mjs";

const webOrigin = (value) => {
  try {
    const url = new URL(value);
    return url.origin === "null" ? null : url;
  } catch {
    return null;
  }
};
const sameHost = (origin, host) => !!host && webOrigin(origin)?.host === host;

export function registerHttpSecurity(app, store) {
  app.addHook("onRequest", async (req, reply) => {
    const origin = req.headers.origin;
    if (
      origin &&
      (origin.startsWith("chrome-extension://") ||
        origin.startsWith("moz-extension://") ||
        (store.setting("sources") || []).some(
          (s) =>
            s.kind === "sillytavern" && webOrigin(s.url)?.origin === origin,
        ))
    )
      reply
        .header("Access-Control-Allow-Origin", origin)
        .header("Vary", "Origin")
        .header(
          "Access-Control-Allow-Headers",
          "Authorization,Content-Type,MCP-Protocol-Version",
        )
        .header(
          "Access-Control-Allow-Methods",
          "GET,POST,PATCH,PUT,DELETE,OPTIONS",
        );
    if (req.method === "OPTIONS") return reply.code(204).send();
  });
  app.addHook("preHandler", async (req) => {
    const route = req.routeOptions.url ?? req.url.split("?")[0];
    if (
      route === "/api/health" ||
      (["/api/v1/session", "/api/v2/session"].includes(route) &&
        req.method === "POST")
    )
      return;
    if (!route.startsWith("/api/") && !route.startsWith("/mcp")) return;
    const bearer = req.headers.authorization?.replace(/^Bearer /, "");
    req.auth = authenticate(store, bearer || req.cookies.arc_session);
    const foreign =
      req.headers.origin && !sameHost(req.headers.origin, req.headers.host);
    if (foreign && !bearer && !["GET", "HEAD"].includes(req.method))
      throw new Problem(403, "管理会话来源不一致");
    if (foreign && route === "/mcp")
      throw new Problem(403, "MCP 请求来源不一致");
  });
}
