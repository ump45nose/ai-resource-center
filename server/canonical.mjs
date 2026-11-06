import { hash } from "./store.mjs";

// Stored digests and request scopes compare these exact strings; keep the output byte-stable.
export const canonical = (value) =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item).sort(([a], [b]) => a.localeCompare(b)),
        )
      : item,
  );
export const digest = (value) => hash(canonical(value));
export const same = (a, b) => canonical(a) === canonical(b);
