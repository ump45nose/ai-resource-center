import { createApp } from "./app.mjs";
const { app, gateways } = await createApp({
  dir: process.env.DATA_DIR || "data",
});
await app.listen({
  port: Number(process.env.PORT || 18321),
  host: process.env.HOST || "0.0.0.0",
});
const timer = setInterval(
  () =>
    void gateways
      .scheduled()
      .catch((error) => process.stderr.write(`${error.message}\n`)),
  60000,
);
timer.unref();
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, async () => {
    clearInterval(timer);
    await app.close();
    process.exit(0);
  });
process.stdout.write("AI resource center ready\n");
