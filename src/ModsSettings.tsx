import { useState } from "react";

import type { Backend } from "./backend";
import { GRANTS, modHost, optionsOf, type Grant, type ModEntry } from "./mods/host";
import { useMods } from "./ModView";

// Settings → Mods: add a mod folder, review what it may do, turn it on.

export function ModsSettings({ backend }: { backend: Backend }) {
  const mods = useMods();
  const [problem, setProblem] = useState("");
  const add = async () => {
    setProblem("");
    const dir = await backend.pickFolder();
    if (!dir) return;
    try {
      await modHost.add(dir);
    } catch (error) {
      setProblem(String(error instanceof Error ? error.message : error));
    }
  };
  return (
    <div className="mod-list">
      <div><button type="button" onClick={add}>Add mod folder…</button></div>
      {problem && <p className="error">{problem}</p>}
      {mods.mods.length === 0 && <p className="muted">No mods yet. A mod is a Claude Code plugin folder whose hooks/hooks.json names <code>modules</code>.</p>}
      {mods.mods.map((mod) => <ModCard key={mod.name} mod={mod} />)}
    </div>
  );
}

function ModCard({ mod }: { mod: ModEntry }) {
  const mods = useMods();
  const run = mods.runs[mod.name];
  const [grants, setGrants] = useState<Grant[]>(mod.enabled ? mod.grants : GRANTS.map((g) => g.id));
  const [showOptions, setShowOptions] = useState(false);
  const options = optionsOf(mod);
  const setOption = (key: string, value: unknown) => modHost.setOptions(mod.name, { ...mod.options, [key]: value });
  const state = !mod.enabled ? "Off" : run?.state === "ready" ? "On" : run?.state === "failed" ? "Failed" : "Starting…";
  return (
    <section className="mod-card">
      <div className="mod-card-head">
        <strong>{mod.name}</strong>
        <span className="muted">{state}</span>
        {mod.enabled && <button type="button" className="ghost small" onClick={() => void modHost.reload(mod.name)}>Reload</button>}
        <button type="button" className="ghost small" onClick={() => modHost.remove(mod.name)}>Remove</button>
      </div>
      {mod.description && <span className="muted">{mod.description}</span>}
      <span className="muted">{mod.dir}</span>
      {run?.state === "failed" && <span className="error">{run.error}</span>}
      {run?.commands.length ? <span className="muted">Commands: {run.commands.map((c) => `/${c.name}`).join(", ")}</span> : null}
      <div className="mod-grants">
        <span className="muted">It may:</span>
        {GRANTS.map((g) => (
          <label key={g.id}>
            <input type="checkbox" disabled={mod.enabled} checked={(mod.enabled ? mod.grants : grants).includes(g.id)}
              onChange={(e) => setGrants((list) => (e.target.checked ? [...list, g.id] : list.filter((x) => x !== g.id)))} />
            {g.label}
          </label>
        ))}
      </div>
      <div>
        {mod.enabled
          ? <button type="button" onClick={() => modHost.setEnabled(mod.name, false)}>Turn off</button>
          : <button type="button" className="primary" onClick={() => modHost.setEnabled(mod.name, true, grants)}>Turn on with these permissions</button>}
        {Object.keys(mod.userConfig).length > 0 && <button type="button" className="ghost small" onClick={() => setShowOptions((s) => !s)}>{showOptions ? "Hide options" : "Options"}</button>}
      </div>
      {showOptions && (
        <div className="mod-options">
          {Object.entries(mod.userConfig).map(([key, field]) => (
            <label key={key} title={field.description}>
              <span style={{ minWidth: 180 }}>{field.title ?? key}</span>
              {field.type === "boolean"
                ? <input type="checkbox" checked={options[key] === true} onChange={(e) => setOption(key, e.target.checked)} />
                : field.options
                  ? <select value={String(options[key] ?? "")} onChange={(e) => setOption(key, e.target.value)}>{field.options.map((o) => <option key={o}>{o}</option>)}</select>
                  : <input type={field.type === "number" ? "number" : "text"} value={String(options[key] ?? "")}
                      onChange={(e) => setOption(key, field.type === "number" ? Number(e.target.value) : e.target.value)} />}
            </label>
          ))}
          <span className="muted">Options apply when the mod next starts{mod.enabled ? "; press Reload" : ""}.</span>
        </div>
      )}
    </section>
  );
}
