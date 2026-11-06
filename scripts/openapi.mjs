import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app.mjs";
import { openapi } from "../server/openapi.mjs";

const dir = mkdtempSync(join(tmpdir(), "arc-openapi-"));
try {
  const app = await createApp({ dir });
  writeFileSync(
    process.argv[2] || "docs/openapi.json",
    JSON.stringify(openapi(app.capabilities), null, 2) + "\n",
  );
  await app.close();
} finally {
  rmSync(dir, { recursive: true, force: true });
}
