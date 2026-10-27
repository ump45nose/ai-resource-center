import { createApp } from "./app.mjs";

const app = await createApp({
  dir: process.env.DATA_DIR || "./data",
  allowGatewayWrites: process.env.GATEWAY_WRITES === "true",
  worker: process.env.WORKER !== "false",
});
await app.listen({
  host: process.env.HOST || "127.0.0.1",
  port: Number(process.env.PORT || 18323),
});
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => app.close());
