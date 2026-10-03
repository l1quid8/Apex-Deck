import type { AgentInfo } from "./types";
import { providerEnabled } from "./providers";

export function ProviderSettings({ agents, disabled, onChange, onClose }: {
  agents: AgentInfo[]; disabled: string[]; onChange: (disabled: string[]) => void; onClose: () => void;
}) {
  const extras = [
    { key: "ollama", label: "Ollama", detail: "Local models" },
    { key: "api", label: "Other API", detail: "OpenAI-compatible servers" },
    { key: "command", label: "Custom command", detail: "Your own command-line bot" },
    { key: "scripted", label: "Scripted", detail: "Offline testing" },
  ];
  const rows = [...agents.map((a) => ({ key: a.key, label: a.label, detail: a.found ? a.program : "Not installed" })), ...extras];
  return <div className="provider-settings" role="dialog" aria-modal="false" aria-labelledby="provider-settings-title">
    <div className="provider-settings-head"><div><h2 id="provider-settings-title">Providers</h2><p>Choose which tools appear when adding terminals and bots.</p></div><button onClick={onClose}>Done</button></div>
    <div className="provider-switches">{rows.map((row) => <label key={row.key}>
      <input type="checkbox" checked={providerEnabled(row.key, disabled)} onChange={(e) => onChange(e.target.checked ? disabled.filter((id) => id !== row.key) : [...disabled, row.key])} />
      <span><strong>{row.label}</strong><small>{row.detail}</small></span>
    </label>)}</div>
    <div className="provider-settings-footer"><button className="ghost" onClick={() => onChange([])}>Enable all</button><button className="ghost" onClick={() => onChange([...new Set([...disabled, ...agents.filter((a) => !a.found).map((a) => a.key)])])}>Hide uninstalled tools</button><p>Saved automatically. Existing chats and terminals keep working.</p></div>
  </div>;
}
