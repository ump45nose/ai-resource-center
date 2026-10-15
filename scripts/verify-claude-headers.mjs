import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clientConfig } from "../server/exports.mjs";
const recorded = [];
const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = chunks.length
    ? JSON.parse(Buffer.concat(chunks).toString())
    : {};
  if (req.url.includes("count_tokens")) {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ input_tokens: 10 }));
    return;
  }
  if (!req.url.includes("/messages")) {
    res.writeHead(404);
    res.end("{}");
    return;
  }
  recorded.push({
    client: req.headers["x-resource-center"],
    hasAuthentication: !!(
      req.headers.authorization || req.headers["x-api-key"]
    ),
    model: body.model,
  });
  if (body.stream) {
    res.writeHead(200, { "content-type": "text/event-stream" });
    const events = [
      [
        "message_start",
        {
          type: "message_start",
          message: {
            id: "msg_audit",
            type: "message",
            role: "assistant",
            model: body.model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 10, output_tokens: 0 },
          },
        },
      ],
      [
        "content_block_start",
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        },
      ],
      [
        "content_block_delta",
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "ok" },
        },
      ],
      ["content_block_stop", { type: "content_block_stop", index: 0 }],
      [
        "message_delta",
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: 1 },
        },
      ],
      ["message_stop", { type: "message_stop" }],
    ];
    for (const [name, data] of events)
      res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
    res.end();
  } else {
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        id: "msg_audit",
        type: "message",
        role: "assistant",
        model: body.model,
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 1 },
      }),
    );
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const dir = mkdtempSync(join(tmpdir(), "arc-claude-")),
  port = server.address().port;
const config = JSON.parse(
  clientConfig(
    {
      name: "CLI 验证",
      protocol: "Anthropic",
      baseUrl: `http://127.0.0.1:${port}`,
      models: ["claude-sonnet-4-6"],
      headers: [{ name: "x-resource-center", value: "header-verification" }],
    },
    "Claude Code",
    "sk-arc-FAKE-LOCAL-ONLY",
  ),
);
const path = join(dir, "settings.json");
writeFileSync(path, JSON.stringify(config), { mode: 0o600 });
const env = {
  ...process.env,
  ...config.env,
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  NO_PROXY: "127.0.0.1,localhost",
  no_proxy: "127.0.0.1,localhost",
};
delete env.ANTHROPIC_API_KEY;
const child = spawn(
  "claude",
  [
    "-p",
    "Reply exactly ok.",
    "--settings",
    path,
    "--setting-sources",
    "",
    "--strict-mcp-config",
    "--mcp-config",
    '{"mcpServers":{}}',
    "--disable-slash-commands",
    "--no-session-persistence",
    "--tools",
    "",
    "--system-prompt",
    "Reply exactly ok.",
    "--model",
    "claude-sonnet-4-6",
    "--max-turns",
    "1",
  ],
  { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"] },
);
let stdout = "",
  stderr = "";
child.stdout.on("data", (x) => (stdout += x));
child.stderr.on("data", (x) => (stderr += x));
const timer = setTimeout(() => child.kill("SIGTERM"), 45000);
const code = await new Promise((resolve) => child.on("close", resolve));
clearTimeout(timer);
server.close();
rmSync(dir, { recursive: true, force: true });
console.log(
  JSON.stringify({
    code,
    output: stdout.trim().slice(0, 100),
    requests: recorded,
    stderr: stderr.slice(0, 160),
  }),
);
if (
  code !== 0 ||
  stdout.trim() !== "ok" ||
  !recorded.length ||
  recorded.some(
    (x) => x.client !== "header-verification" || !x.hasAuthentication,
  )
)
  process.exitCode = 1;
