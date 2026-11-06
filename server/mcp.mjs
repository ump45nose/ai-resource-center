import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { authorize } from "./auth.mjs";
import { publicValue, errorMessage } from "./errors.mjs";
import { outputs } from "./transport-schemas.mjs";

const transportHeaders = ["content-type", "accept", "mcp-protocol-version"];

export async function mcpRequest(capabilities, auth, req) {
  authorize(auth);
  const server = new McpServer({
    name: "ai-resource-center",
    version: "2.0.0",
  });
  for (const cap of capabilities.filter(
    (c) =>
      c.mcp !== false && (!c.write || ["admin", "manage"].includes(auth.role)),
  )) {
    server.registerTool(
      cap.name,
      {
        description: cap.description,
        inputSchema: cap.schema.shape,
        outputSchema: { result: outputs[cap.name] || z.unknown() },
        annotations: {
          readOnlyHint: !cap.write,
          destructiveHint: cap.write,
          openWorldHint: cap.accepted || false,
        },
      },
      async (input) => {
        try {
          authorize(auth, cap.write);
          const result = publicValue(
            await cap.handler(cap.schema.parse(input), auth),
          );
          return {
            content: [{ type: "text", text: JSON.stringify(result) }],
            structuredContent: { result },
          };
        } catch (error) {
          return {
            isError: true,
            content: [{ type: "text", text: errorMessage(error) }],
            structuredContent: {
              result: {
                code: error.code || "operation_failed",
                message: errorMessage(error),
                details: publicValue(error.details),
              },
            },
          };
        }
      },
    );
  }
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    return await transport.handleRequest(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: Object.fromEntries(
          transportHeaders
            .filter((name) => req.headers[name])
            .map((name) => [name, req.headers[name]]),
        ),
        body: JSON.stringify(req.body),
      }),
    );
  } finally {
    await transport.close();
    await server.close();
  }
}
