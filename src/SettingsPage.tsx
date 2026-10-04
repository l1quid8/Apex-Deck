// Settings: app-wide defaults, opened from the gear in the title bar or ⌘,.
// It takes the place of the deck until closed. Per-thread and per-bot
// controls stay in thread details and the Agents tab.

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Backend } from "./backend";
import { forgetModels, rememberedModels } from "./modelMemory";
import { providerEnabled } from "./providers";
import { FONT_SIZES, MAX_ROUNDS, SCROLLBACK_CHOICES, keyNamesIn, type AppSettings } from "./settings";
import { shortcutList } from "./shortcuts";
import type { Access, AgentInfo, ParticipantConfig, TurnPolicy } from "./types";

export type SettingsSection = "general" | "providers" | "threads" | "terminal" | "shortcuts";

const SECTIONS: { id: SettingsSection; label: string }[] = [
  { id: "general", label: "General" },
  { id: "providers", label: "Providers" },
  { id: "threads", label: "New threads" },
  { id: "terminal", label: "Terminal" },
  { id: "shortcuts", label: "Shortcuts" },
];

const EXTRAS = [
  { key: "ollama", label: "Ollama", detail: "Local models" },
  { key: "api", label: "Other API", detail: "OpenAI-compatible servers" },
  { key: "command", label: "Custom command", detail: "Your own command-line bot" },
  { key: "scripted", label: "Scripted", detail: "Offline testing" },
];

interface Props {
  section: SettingsSection;
  onSection: (section: SettingsSection) => void;
  settings: AppSettings;
  onChange: (settings: AppSettings) => void;
  agents: AgentInfo[];
  profiles: ParticipantConfig[];
  backend: Backend;
  onClose: () => void;
}

export function SettingsPage({ section, onSection, settings, onChange, agents, profiles, backend, onClose }: Props) {
  // Take focus from the deck, so typing never reaches a terminal underneath.
  const nav = useRef<HTMLElement>(null);
  useEffect(() => { nav.current?.querySelector<HTMLButtonElement>("button.active")?.focus(); }, []);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) onClose();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);

  const index = SECTIONS.findIndex((s) => s.id === section);
  return <div className="settings">
    <aside className="settings-nav">
      <div className="settings-nav-head">
        <h1>Settings</h1>
        <button className="icon" onClick={onClose} aria-label="Close settings" title="Close settings (Esc)">×</button>
      </div>
      <nav ref={nav} aria-label="Settings sections">
        {SECTIONS.map((s) => <button key={s.id} className={s.id === section ? "active" : undefined} aria-current={s.id === section ? "page" : undefined} onClick={() => onSection(s.id)}>{s.label}</button>)}
      </nav>
      <div className="settings-nav-foot"><span><kbd>⌘,</kbd> opens · <kbd>Esc</kbd> closes</span><span>Changes save as you make them.</span></div>
    </aside>
    <main className="settings-main">
      <div className="settings-column">
        <header className="settings-head">
          <span className="mono">{String(index + 1).padStart(2, "0")} / {SECTIONS[index].label}</span>
          <h2>{section === "threads" ? "Defaults for new threads" : SECTIONS[index].label}</h2>
          {LEADS[section] && <p>{LEADS[section]}</p>}
        </header>
        {section === "general" && <General backend={backend} />}
        {section === "providers" && <Providers settings={settings} onChange={onChange} agents={agents} profiles={profiles} backend={backend} />}
        {section === "threads" && <Threads settings={settings} onChange={onChange} />}
        {section === "terminal" && <TerminalSettings settings={settings} onChange={onChange} />}
        {section === "shortcuts" && <Shortcuts />}
      </div>
    </main>
  </div>;
}

const LEADS: Partial<Record<SettingsSection, string>> = {
  providers: "Choose which tools appear when adding terminals and bots.",
  threads: "Used when you create a thread. Threads you already have keep their own settings.",
  terminal: "Open terminals update straight away.",
  shortcuts: "Fixed for now.",
};

function Row({ label, note, children }: { label: string; note?: ReactNode; children?: ReactNode }) {
  return <div className="settings-row">
    <div className="settings-label"><strong>{label}</strong>{note && <small>{note}</small>}</div>
    {children}
  </div>;
}

function Stepper({ value, min, max, unit, label, onChange }: { value: number; min: number; max: number; unit?: string; label: string; onChange: (value: number) => void }) {
  return <span className="stepper">
    <button type="button" aria-label={`Less ${label}`} disabled={value <= min} onClick={() => onChange(value - 1)}>−</button>
    <output aria-label={label}>{value}{unit ? ` ${unit}` : ""}</output>
    <button type="button" aria-label={`More ${label}`} disabled={value >= max} onClick={() => onChange(value + 1)}>+</button>
  </span>;
}

function General({ backend }: { backend: Backend }) {
  const [folder, setFolder] = useState("");
  const [remembered, setRemembered] = useState(() => Object.values(rememberedModels()).filter((list) => Array.isArray(list) && list.length > 0).length);
  useEffect(() => { backend.dataFolder().then(setFolder, () => setFolder("")); }, [backend]);
  return <div className="settings-card">
    <Row label="Theme" note="Dark is the only theme for now."><select disabled value="dark" aria-label="Theme"><option value="dark">Dark</option></select></Row>
    <Row label="Saved in" note={<span className="mono">{folder || "…"}</span>}>
      {!backend.demo && <button disabled={!folder} onClick={() => backend.openTarget(folder, null, false).catch(() => {})}>Show in Finder</button>}
    </Row>
    <Row label="Remembered models" note={remembered === 0 ? "None yet. Model names you type in the bot form are offered again next time." : `Model names from ${remembered} ${remembered === 1 ? "provider" : "providers"}, offered again in the bot form.`}>
      <button disabled={remembered === 0} onClick={() => { forgetModels(); setRemembered(0); }}>Clear</button>
    </Row>
    <Row label="Version" note={`Apex Deck ${__APP_VERSION__}`} />
  </div>;
}

function Providers({ settings, onChange, agents, profiles, backend }: { settings: AppSettings; onChange: (s: AppSettings) => void; agents: AgentInfo[]; profiles: ParticipantConfig[]; backend: Backend }) {
  const disabled = settings.disabledProviders;
  const setDisabled = (next: string[]) => onChange({ ...settings, disabledProviders: next });
  const rows = [...agents.map((a) => ({ key: a.key, label: a.label, detail: a.found ? a.program : "Not installed" })), ...EXTRAS];
  const keys = useMemo(() => keyNamesIn(profiles), [profiles]);
  const [present, setPresent] = useState<boolean[] | null>(null);
  useEffect(() => {
    setPresent(null);
    if (keys.length > 0) backend.envPresent(keys.map((k) => k.name)).then(setPresent, () => setPresent(null));
  }, [backend, keys]);
  return <>
    <div className="settings-card provider-grid">
      {rows.map((row) => <label key={row.key}>
        <input type="checkbox" checked={providerEnabled(row.key, disabled)} onChange={(e) => setDisabled(e.target.checked ? disabled.filter((id) => id !== row.key) : [...disabled, row.key])} />
        <span><strong>{row.label}</strong><small>{row.detail}</small></span>
      </label>)}
    </div>
    <div className="settings-actions">
      <button className="ghost" onClick={() => setDisabled([])}>Enable all</button>
      <button className="ghost" onClick={() => setDisabled([...new Set([...disabled, ...agents.filter((a) => !a.found).map((a) => a.key)])])}>Hide uninstalled tools</button>
      <span>Existing chats and terminals keep working.</span>
    </div>
    <div className="settings-subhead">
      <h3>API keys</h3>
      <p>The environment variables your saved agents read their keys from. The keys themselves are never stored.</p>
    </div>
    <div className="settings-card">
      {keys.length === 0 && <Row label="No keys yet" note="Saved agents that use an API name their key's variable in the bot form." />}
      {keys.map((k, i) => {
        const found = present?.[i];
        return <Row key={k.name} label={k.name} note={<>Used by {k.uses} saved {k.uses === 1 ? "agent" : "agents"}{found === false && !backend.demo ? ". Apps opened from the Dock don't see variables set in ~/.zshrc. Set it with launchctl setenv, or start Apex Deck from a terminal." : ""}</>}>
          {found !== undefined && !backend.demo && <span className={found ? "key-state found" : "key-state missing"}><span className="dot" aria-hidden="true" />{found ? "Found" : "Not found"}</span>}
        </Row>;
      })}
    </div>
  </>;
}

function Threads({ settings, onChange }: { settings: AppSettings; onChange: (s: AppSettings) => void }) {
  const thread = settings.newThread;
  return <div className="settings-card">
    <Row label="Who answers" note="Who replies to your message.">
      <select aria-label="Who answers" value={thread.policy} onChange={(e) => onChange({ ...settings, newThread: { ...thread, policy: e.target.value as TurnPolicy } })}>
        <option value="mention">Whoever I addressed last</option>
        <option value="everyone">Everyone at once</option>
        <option value="round_robin">Everyone in turn</option>
      </select>
    </Row>
    <Row label="Model-to-model rounds" note="How many times bots may answer each other after one of your messages.">
      <Stepper label="rounds" value={thread.max_bot_hops} min={0} max={MAX_ROUNDS} onChange={(n) => onChange({ ...settings, newThread: { ...thread, max_bot_hops: n } })} />
    </Row>
    <Row label="Access for new bots" note="Ask first only works with tools that can enforce it. Others start at Read only.">
      <select aria-label="Access for new bots" value={settings.newBotAccess} onChange={(e) => onChange({ ...settings, newBotAccess: e.target.value as Access })}>
        <option value="read">Read only</option>
        <option value="ask">Ask first</option>
        <option value="edits">Can edit files</option>
        <option value="full">Full access</option>
      </select>
    </Row>
  </div>;
}

function TerminalSettings({ settings, onChange }: { settings: AppSettings; onChange: (s: AppSettings) => void }) {
  const terminal = settings.terminal;
  const set = (next: Partial<AppSettings["terminal"]>) => onChange({ ...settings, terminal: { ...terminal, ...next } });
  return <>
    <div className="settings-card">
      <Row label="Font size">
        <Stepper label="font size" unit="px" value={terminal.fontSize} min={FONT_SIZES.min} max={FONT_SIZES.max} onChange={(n) => set({ fontSize: n })} />
      </Row>
      <Row label="Scrollback" note="Lines each terminal keeps above the screen.">
        <select aria-label="Scrollback" value={terminal.scrollback} onChange={(e) => set({ scrollback: Number(e.target.value) })}>
          {SCROLLBACK_CHOICES.map((n) => <option key={n} value={n}>{n.toLocaleString("en-US")} lines</option>)}
        </select>
      </Row>
    </div>
    <div className="terminal-sample" style={{ fontSize: terminal.fontSize }} aria-hidden="true">
      <div className="muted">~/apex-deck</div>
      <div><span className="prompt">❯</span> npm test</div>
      <div className="muted">Tests  256 passed (256)</div>
    </div>
  </>;
}

function Shortcuts() {
  const mac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  return <>
    <div className="settings-card">
      {shortcutList(mac).map((s) => <div key={s.label} className="settings-row compact"><span>{s.label}</span><kbd>{s.keys}</kbd></div>)}
    </div>
    {!mac && <p className="settings-note">On macOS these use ⌘.</p>}
  </>;
}
