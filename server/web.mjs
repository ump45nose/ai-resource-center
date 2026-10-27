import { existsSync, createReadStream } from "node:fs";
import { resolve, basename } from "node:path";

export function registerWeb(app) {
  const root = resolve(import.meta.dirname, "../dist");
  const file = (path, type, reply, immutable = false) => {
    if (!existsSync(path))
      return reply
        .code(404)
        .send({ message: "页面尚未构建，请先运行 npm run build" });
    return reply
      .type(type)
      .header(
        "Cache-Control",
        immutable ? "public, max-age=31536000, immutable" : "no-cache",
      )
      .send(createReadStream(path));
  };
  app.get("/", (_req, reply) =>
    file(resolve(root, "index.html"), "text/html; charset=utf-8", reply),
  );
  app.get("/favicon.svg", (_req, reply) =>
    file(resolve(root, "favicon.svg"), "image/svg+xml", reply),
  );
  app.get("/assets/:name", (req, reply) => {
    const name = req.params.name;
    if (basename(name) !== name) return reply.code(404).send();
    const type = name.endsWith(".js")
      ? "text/javascript; charset=utf-8"
      : name.endsWith(".css")
        ? "text/css; charset=utf-8"
        : "application/octet-stream";
    return file(resolve(root, "assets", name), type, reply, true);
  });
}
