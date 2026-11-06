import { Problem } from "./errors.mjs";
import { authorize } from "./auth.mjs";
import { callReport } from "./calls.mjs";

export const rpGone = () =>
  new Problem(
    410,
    "酒馆（SillyTavern）同步已从资源中心移除：RP 渠道只在酒馆和 Chrome 书签中管理，请停用旧版酒馆插件的中心同步",
    undefined,
    "gone",
  );

export function registerLegacy(app, { store }) {
  app.get("/api/v1/calls", (req) => {
    authorize(req.auth);
    return callReport(store, req.query);
  });
  app.all("/api/v1/rp/*", () => {
    throw rpGone();
  });
}
