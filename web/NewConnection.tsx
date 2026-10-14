import { useState } from "react";
import { useStore } from "./store";
import { Drawer, Field, Btn, inputCls } from "./ui";
import type { Category } from "./data";
export function NewConnection({
  open,
  onClose,
  category = "general",
}: {
  open: boolean;
  onClose: () => void;
  category?: Category;
}) {
  const { act } = useStore();
  const [name, setName] = useState(""),
    [url, setUrl] = useState(""),
    [base, setBase] = useState(""),
    [models, setModels] = useState(""),
    [key, setKey] = useState(""),
    [protocol, setProtocol] = useState("OpenAI"),
    [client, setClient] = useState("Claude Code");
  return (
    <Drawer
      open={open}
      title="添加连接"
      sub={
        category === "rp"
          ? "酒馆直连，保存不访问上游"
          : "只保存配置，验证结果来自真实任务"
      }
      onClose={onClose}
      footer={
        <>
          <Btn onClick={onClose}>取消</Btn>
          <Btn
            kind="primary"
            disabled={!name || !url || !base}
            onClick={async () => {
              const r = await act("/channels", {
                site: { name, url },
                name,
                baseUrl: base,
                models: models
                  .split(",")
                  .map((x) => x.trim())
                  .filter(Boolean),
                key,
                category,
                protocol,
                client: category === "client" ? client : undefined,
                enabled: !!key,
              });
              if (r) onClose();
            }}
          >
            保存
          </Btn>
        </>
      }
    >
      <div className="grid gap-4">
        <Field label="站点名称">
          <input
            className={inputCls}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field label="网站地址">
          <input
            className={inputCls}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
        </Field>
        <Field label="API 地址">
          <input
            className={inputCls}
            value={base}
            onChange={(e) => setBase(e.target.value)}
          />
        </Field>
        <Field label="协议">
          <select
            className={inputCls}
            value={protocol}
            onChange={(e) => setProtocol(e.target.value)}
          >
            {["OpenAI", "OpenAI Responses", "Anthropic", "Gemini"].map((p) => (
              <option key={p}>{p}</option>
            ))}
          </select>
        </Field>
        <Field label="选定模型（逗号分隔）">
          <input
            className={inputCls}
            value={models}
            onChange={(e) => setModels(e.target.value)}
          />
        </Field>
        <Field label="推理 key">
          <input
            className={inputCls}
            type="password"
            value={key}
            onChange={(e) => setKey(e.target.value)}
          />
        </Field>
        {category === "client" && (
          <Field label="限制客户端">
            <input
              className={inputCls}
              value={client}
              onChange={(e) => setClient(e.target.value)}
            />
          </Field>
        )}
      </div>
    </Drawer>
  );
}
