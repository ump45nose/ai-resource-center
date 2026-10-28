import { useEffect, useState } from "react";
import { api } from "./api";
import { Button } from "./components";
type Connection = {
  id: string;
  version: number;
  channelVersion: number;
  nativeConnectionId: string;
  name: string;
  selectedModel: string;
  enabled: boolean;
  order: number;
  note: string;
  state: string;
  acceptance: string;
  instanceId: string;
  userId: string;
  conflict: unknown;
};
export default function RpConnections({ channelId }: { channelId: string }) {
  const [items, setItems] = useState<Connection[]>([]),
    [error, setError] = useState("");
  const read = () =>
    api<{ items: Connection[] }>(
      `/rp/connections?channelId=${encodeURIComponent(channelId)}`,
    ).then((r) => setItems(r.items));
  useEffect(() => {
    void read().catch((e) => setError(e.message));
  }, [channelId]);
  const save = async (c: Connection, resolve?: string) => {
    try {
      await api(`/rp/connections/${c.id}`, "PATCH", {
        version: c.version,
        channelVersion: c.channelVersion,
        binding: {
          name: c.name,
          selectedModel: c.selectedModel,
          enabled: c.enabled,
          order: c.order,
          note: c.note,
        },
        channel: {},
        ...(resolve ? { resolve } : {}),
      });
      await read();
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存失败");
    }
  };
  return items.length ? (
    <section>
      <h3>酒馆连接</h3>
      {items.map((c) => (
        <form
          key={c.id}
          onSubmit={(e) => {
            e.preventDefault();
            void save(c);
          }}
        >
          <small>
            {c.instanceId} / {c.userId} ·{" "}
            {c.state === "applied"
              ? "已同步"
              : c.state === "conflict"
                ? "配置冲突"
                : "待酒馆应用"}{" "}
            · {c.acceptance}
          </small>
          {(["name", "selectedModel", "note"] as const).map((key) => (
            <label key={key}>
              {
                {
                  name: "连接名称",
                  selectedModel: "酒馆选定模型",
                  note: "备注",
                }[key]
              }
              <input
                value={c[key]}
                onChange={(e) =>
                  setItems((rows) =>
                    rows.map((r) =>
                      r.id === c.id ? { ...r, [key]: e.target.value } : r,
                    ),
                  )
                }
              />
            </label>
          ))}
          <label>
            排序
            <input
              type="number"
              min="0"
              value={c.order}
              onChange={(e) =>
                setItems((rows) =>
                  rows.map((r) =>
                    r.id === c.id
                      ? { ...r, order: Math.max(0, Number(e.target.value)) }
                      : r,
                  ),
                )
              }
            />
          </label>
          <label>
            <input
              type="checkbox"
              checked={c.enabled}
              onChange={(e) =>
                setItems((rows) =>
                  rows.map((r) =>
                    r.id === c.id ? { ...r, enabled: e.target.checked } : r,
                  ),
                )
              }
            />
            启用此酒馆绑定
          </label>
          <Button type="submit">保存酒馆连接</Button>
          {!!c.conflict && (
            <>
              <Button type="button" onClick={() => void save(c, "center")}>
                采用中心
              </Button>
              <Button type="button" onClick={() => void save(c, "local")}>
                采用酒馆
              </Button>
            </>
          )}
        </form>
      ))}
      {error && <p role="alert">{error}</p>}
    </section>
  ) : error ? (
    <p role="alert">{error}</p>
  ) : null;
}
