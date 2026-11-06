import { useEffect, useState, type FormEvent } from "react";
import { api, allPages } from "../api";
import { Badge, Button, Overlay } from "../components";
import { useWorkspace } from "../workspace";

type Pool = {
  id: string; version: number; name: string; enabled: boolean;
  scope: "all_eligible" | "selected"; channelIds: string[];
  channelPriorities: Record<string, number>; modelPriorities: Record<string, number>;
  allowUnverified: boolean; cooldownMinutes: number; maxAttempts: number;
};
type Task = {
  id: string; externalId: string; source: string; name: string; enabled: boolean;
  supportsRunConfig: boolean; supportsResult: boolean; supportsScheduledRunConfig?: boolean;
  requiredCapabilities?: string[];
};
type Binding = { id: string; version: number; taskRef: {source: string; id: string}; validationOnly?: boolean };
type Candidate = { offeringId: string; channelName: string; modelId: string; priority: number; modelPriority: number; needsValidation: boolean };
const blank = (): Omit<Pool, "id" | "version"> => ({
  name: "", enabled: true, scope: "all_eligible", channelIds: [], channelPriorities: {}, modelPriorities: {},
  allowUnverified: true, cooldownMinutes: 30, maxAttempts: 6,
});

export default function ChannelPools({ close, saved }: { close: () => void; saved: () => Promise<void> }) {
  const { sites } = useWorkspace();
  const channels = sites.flatMap(s => s.channels).filter(c => c.usage === "general" && c.probeAllowed);
  const [pools, setPools] = useState<Pool[]>([]), [tasks, setTasks] = useState<Task[]>([]), [bindings, setBindings] = useState<Binding[]>([]);
  const [editing, setEditing] = useState(""), [form, setForm] = useState(blank), [models, setModels] = useState("");
  const [taskId, setTaskId] = useState(""), [poolId, setPoolId] = useState(""), [candidates, setCandidates] = useState<Candidate[]>([]);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const task = tasks.find(t => t.id === taskId);
  async function load() {
    const [p, t, b] = await Promise.all([allPages<Pool>("/cron/pools"), allPages<Task>("/cron/tasks"), allPages<Binding>("/cron/bindings")]);
    setPools(p); setTasks(t); setBindings(b);
  }
  useEffect(() => { void load().catch(e => setError(String(e))); }, []);
  useEffect(() => {
    let active = true;
    setCandidates([]);
    if (task && poolId) void api<{items: Candidate[]}>(`/cron/pools/${encodeURIComponent(poolId)}/candidates?source=${encodeURIComponent(task.source)}&taskId=${encodeURIComponent(task.externalId)}&limit=12`)
      .then(r => { if (active) setCandidates(r.items); }).catch(e => { if (active) setError(String(e)); });
    return () => { active = false; };
  }, [task, poolId, pools]);
  function edit(id: string) {
    const p = pools.find(x => x.id === id);
    setEditing(id); setForm(p ? { name: p.name, enabled: p.enabled, scope: p.scope, channelIds: p.channelIds,
      channelPriorities: p.channelPriorities, modelPriorities: p.modelPriorities, allowUnverified: p.allowUnverified,
      cooldownMinutes: p.cooldownMinutes, maxAttempts: p.maxAttempts } : blank());
    setModels(p ? Object.entries(p.modelPriorities).map(([m, n]) => `${m}=${n}`).join("\n") : "");
  }
  async function savePool(e: FormEvent) {
    e.preventDefault(); setBusy(true); setError("");
    try {
      const modelPriorities: Record<string, number> = {};
      for (const line of models.split("\n").filter(x => x.trim())) {
        const at = line.lastIndexOf("="), name = line.slice(0, at).trim(), value = Number(line.slice(at + 1).trim());
        if (at < 1 || !name || !Number.isInteger(value)) throw Error("模型优先级请填写：模型名=整数");
        modelPriorities[name] = value;
      }
      const data = { ...form, modelPriorities };
      const p = editing ? await api<Pool>(`/cron/pools/${editing}`, "PATCH", {version: pools.find(p => p.id === editing)?.version, changes: data})
        : await api<Pool>("/cron/pools", "POST", {data});
      await load(); await saved(); setEditing(p.id); setPoolId(p.id);
    } catch (e) { setError(e instanceof Error ? e.message : "保存失败"); }
    finally { setBusy(false); }
  }
  async function bind(e: FormEvent) {
    e.preventDefault(); if (!task || !poolId) return;
    setBusy(true); setError("");
    try {
      const existing = bindings.find(b => !b.validationOnly && b.taskRef.source === task.source && b.taskRef.id === task.externalId);
      const data = {taskRef: {source: task.source, id: task.externalId}, poolId, enabled: true, validationOnly: false};
      if (existing) await api(`/cron/bindings/${existing.id}`, "PATCH", {version: existing.version, changes: data});
      else await api("/cron/bindings", "POST", {data});
      await load(); await saved();
    } catch (e) { setError(e instanceof Error ? e.message : "绑定失败"); }
    finally { setBusy(false); }
  }
  return <Overlay title="渠道池与任务" subtitle="任务绑定渠道池，运行时按优先级选择符合要求的模型" onClose={close} drawer>
    <div className="overlay-body form-stack">
      {error && <p className="inline-error" role="alert">{error}</p>}
      <form className="form-stack" onSubmit={savePool}>
        <label>编辑渠道池<select value={editing} onChange={e => edit(e.target.value)}>
          <option value="">新建渠道池</option>{pools.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select></label>
        <label>名称<input value={form.name} onChange={e => setForm({...form, name:e.target.value})} required /></label>
        <label className="check-line"><input type="checkbox" checked={form.enabled} onChange={e => setForm({...form,enabled:e.target.checked})}/>启用渠道池</label>
        <label>范围<select value={form.scope} onChange={e => setForm({...form,scope:e.target.value as Pool["scope"]})}>
          <option value="all_eligible">全部可用渠道，自动纳入新增模型</option><option value="selected">指定渠道，纳入渠道内全部合适模型</option>
        </select></label>
        <p className="muted">优先级数值越大越先使用；未覆盖时沿用 New API 优先级。同级优先使用即将到期的额度，再轮换模型。</p>
        <details><summary>渠道范围与优先级</summary><div className="form-stack">
          {channels.map(c => <div className="check-line" key={c.id}>
            {form.scope === "selected" && <input type="checkbox" checked={form.channelIds.includes(c.id)}
              onChange={e => setForm({...form,channelIds:e.target.checked ? [...form.channelIds,c.id] : form.channelIds.filter(id => id!==c.id)})}/>}
            <span>{c.name}</span><input type="number" style={{width: 96}} aria-label={`${c.name} 优先级`} placeholder="沿用"
              value={form.channelPriorities[c.id] ?? ""} onChange={e => {
                const values={...form.channelPriorities};
                if (e.target.value === "") delete values[c.id]; else values[c.id]=Number(e.target.value);
                setForm({...form,channelPriorities:values});
              }}/>
          </div>)}
        </div></details>
        <label>模型优先级（可选，每行“模型名=优先级”）<textarea value={models} onChange={e => setModels(e.target.value)} rows={3}/></label>
        <label className="check-line"><input type="checkbox" checked={form.allowUnverified} onChange={e => setForm({...form,allowUnverified:e.target.checked})}/>允许能力未知的模型先通过只读校验</label>
        <label>单轮最多尝试的候选数<input type="number" min={1} max={24} value={form.maxAttempts} onChange={e => setForm({...form,maxAttempts:Number(e.target.value)})}/></label>
        <label>失败冷却（分钟）<input type="number" min={1} max={1440} value={form.cooldownMinutes} onChange={e => setForm({...form,cooldownMinutes:Number(e.target.value)})}/></label>
        <Button type="submit" disabled={busy} variant="primary">保存渠道池</Button>
      </form>
      <form className="form-stack" onSubmit={bind}>
        <strong>绑定正常定时任务</strong>
        <label>任务<select value={taskId} onChange={e => setTaskId(e.target.value)} required>
          <option value="">选择已有任务</option>{tasks.filter(t => t.enabled && t.supportsRunConfig && t.supportsResult && t.supportsScheduledRunConfig !== false)
            .map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select></label>
        <label>渠道池<select value={poolId} onChange={e => setPoolId(e.target.value)} required>
          <option value="">选择渠道池</option>{pools.filter(p => p.enabled).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select></label>
        {task?.requiredCapabilities?.length ? <p className="muted">能力要求：{task.requiredCapabilities.map(c => c === "vision" ? "截图识别" : "工具调用").join("、")}</p> : null}
        <Button type="submit" disabled={busy || !task || !poolId} variant="primary">保存任务绑定</Button>
        {task && poolId && <div className="maintenance-log">
          <strong>按当前优先级排列的候选</strong>
          {candidates.map(c => <div key={c.offeringId}><span><strong>{c.channelName} · {c.modelId}</strong>
            <small>渠道优先级 {c.priority} · 模型优先级 {c.modelPriority}</small></span>
            <Badge>{c.needsValidation ? "先校验能力" : "能力已验证"}</Badge></div>)}
          {!candidates.length && <p className="muted">暂无符合要求的候选；运行时会跳过。</p>}
        </div>}
      </form>
    </div>
  </Overlay>;
}
