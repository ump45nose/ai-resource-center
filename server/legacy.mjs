import { isRemoved, channelHeaders, rpChannels } from "./channel-rules.mjs";
import { z } from "zod";
import { Problem } from "./errors.mjs";
import { authorize } from "./auth.mjs";
import { dayKey } from "./domain.mjs";
import { ingestRpCalls } from "./rp-calls.mjs";
import { recordCall } from "./ingest.mjs";
import { callReport } from "./calls.mjs";

export function registerLegacy(app, { store, resources }) {
  const channel = (auth, id) => {
    const c = rpChannels(store, auth).find((c) => c.id === id);
    if (!c) throw new Problem(403, "RP 连接未授权");
    return c;
  };
  const callAdapter = {
    call(source, id, c, model, time, result, f) {
      recordCall(store, source, id, c?.id, model, time, result, {
        ...f,
        latencyMs: f.latency,
        ttftMs: f.ttft,
      });
    },
  };
  app.get("/api/v1/calls", (req) => {
    authorize(req.auth);
    return callReport(store, req.query);
  });
  app.get("/api/v1/rp/connections", (req) => {
    const channels = rpChannels(store, req.auth).filter((c) => !isRemoved(c));
    const data = resources.snapshot();
    return channels.map((c) => resources.publicChannel(c, data));
  });
  app.get("/api/v1/rp/:id/config", (req, reply) => {
    reply.header("Cache-Control", "no-store");
    const c = channel(req.auth, req.params.id);
    return {
      ...resources.publicChannel(c),
      key: c.credentialId ? store.reveal(c.credentialId) : null,
      headers: channelHeaders(store, c),
    };
  });
  app.post("/api/v1/rp/calls", (req) =>
    ingestRpCalls({ store, recompute() {} }, callAdapter, req.auth, req.body),
  );
  app.post("/api/v1/rp/:id/saved", (req) => {
    const old = channel(req.auth, req.params.id);
    const p = z
      .object({
        eventId: z.string().min(1),
        expectedVersion: z.number().int(),
        credential: z.string().min(1).optional(),
        patch: z
          .object({
            name: z.string().optional(),
            order: z.number().int().nonnegative().optional(),
            enabled: z.boolean().optional(),
            baseUrl: z.url(),
            protocol: z.enum([
              "OpenAI",
              "OpenAI Responses",
              "Anthropic",
              "Gemini",
            ]),
            models: z.array(z.string()),
          })
          .strict(),
        profileId: z.string(),
        device: z.string(),
        current: z.boolean().optional(),
      })
      .strict()
      .parse(req.body);
    const eventId = `sillytavern:${p.eventId}`;
    const delivered = store.db
      .prepare("SELECT data FROM events WHERE id=?")
      .get(eventId);
    if (delivered) return JSON.parse(delivered.data);
    if (old.version !== p.expectedVersion) {
      store.put("channel", {
        ...old,
        apply: "conflict",
        external: p.patch,
        applyMsg: "酒馆已保存的连接与中心版本冲突",
      });
      throw new Problem(409, "酒馆已保存内容保留，请选择两侧配置", {
        current: resources.publicChannel(old),
        external: p.patch,
      });
    }
    return store.transaction(() => {
      resources.update("channel", old.id, p.expectedVersion, p.patch);
      if (p.credential)
        resources.saveCredential(
          old.id,
          store.require("channel", old.id).version,
          p.credential,
        );
      const saved = store.require("channel", old.id);
      store.put("channel", {
        ...saved,
        apply: "synced",
        tavern: {
          profileId: p.profileId,
          device: p.device,
          current: p.current,
          lastSavedAt: new Date().toISOString(),
        },
      });
      store.setting("received:sillytavern", new Date().toISOString());
      const result = {
        acceptedVersion: saved.version,
        current: resources.publicChannel(store.require("channel", old.id)),
      };
      store.db
        .prepare("INSERT INTO events VALUES(?,?,?,?,?)")
        .run(
          eventId,
          old.accountId,
          new Date().toISOString(),
          dayKey(new Date()),
          JSON.stringify(result),
        );
      return result;
    });
  });
}
