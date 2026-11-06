import { z } from "zod";
import { outputs, transportRoutes } from "./transport-schemas.mjs";

const jsonSchema = (s) =>
  z.toJSONSchema(s, { io: "input", unrepresentable: "any" });
export function openapi(caps) {
  const paths = {};
  for (const c of caps) {
    const path = `/api/v2${c.path.replace(/:([^/]+)/g, "{$1}")}`;
    const params = [...c.path.matchAll(/:([^/]+)/g)].map((m) => m[1]);
    const bodyShape = Object.fromEntries(
      Object.entries(c.schema.shape).filter(([key]) => !params.includes(key)),
    );
    const parameters = params.map((name) => ({
      name,
      in: "path",
      required: true,
      schema: jsonSchema(c.schema.shape[name]),
    }));
    if (c.method === "GET")
      for (const [name, schema] of Object.entries(bodyShape))
        parameters.push({
          name,
          in: "query",
          required: !schema.isOptional(),
          schema: jsonSchema(schema),
        });
    const outputSchema =
      outputs[c.name] || (c.accepted ? outputs.resource_get_operation : null);
    const output = {
      description: c.description,
      content: {
        "application/json": {
          schema: outputSchema
            ? jsonSchema(outputSchema)
            : { type: "object", additionalProperties: true },
        },
      },
    };
    paths[path] ||= {};
    paths[path][c.method.toLowerCase()] = {
      operationId: c.name,
      summary: c.description,
      security: [{ bearerAuth: [] }, { session: [] }],
      parameters,
      ...(c.method !== "GET"
        ? {
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: jsonSchema(z.object(bodyShape).strict()),
                },
              },
            },
          }
        : {}),
      responses: {
        [c.accepted ? "202" : "200"]: output,
        400: { description: "参数错误" },
        401: { description: "未登录" },
        403: { description: "权限不足" },
        409: { description: "版本或操作范围冲突" },
      },
    };
  }
  for (const [method, path, schema, description, options] of transportRoutes) {
    paths[path] ||= {};
    paths[path][method.toLowerCase()] = {
      operationId:
        options?.operationId ||
        path.replace(/[^a-z0-9]/gi, "_").replace(/^_/, ""),
      summary: description,
      ...(["GET", "DELETE"].includes(method)
        ? {}
        : {
            requestBody: {
              required: true,
              content: { "application/json": { schema: jsonSchema(schema) } },
            },
          }),
      security: options?.security || [{ bearerAuth: [] }],
      responses: {
        200: {
          description: "操作结果",
          content: {
            "application/json": {
              schema: { type: "object", additionalProperties: true },
            },
          },
        },
        401: { description: "未授权" },
        403: { description: "来源不匹配" },
      },
    };
  }
  return {
    openapi: "3.1.1",
    info: { title: "公益资源管理 API", version: "2.0.0" },
    paths,
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer" },
        session: { type: "apiKey", in: "cookie", name: "arc_session" },
      },
    },
  };
}
