// Settings: app-wide defaults, opened from the gear in the title bar or ⌘,.
// It takes the place of the deck until closed. Per-thread and per-bot
// controls stay in thread details and the Agents tab.

import { ChipStylePicker } from "./ChipStylePicker";
import { artifactAutoOpen, setArtifactAutoOpen } from "./artifacts";
import { AppearanceSettings } from "./AppearanceSettings";
import { defaultAppearanceSettings } from "./themes";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Backend, KeyState } from "./backend";
import { forgetModels, rememberedModels } from "./modelMemory";
import { isWindows, showInFileManagerLabel } from "./paths";
import { providerEnabled } from "./providers";
import { CALL_VOICES, DEFAULT_REALTIME_MODEL, DEFAULT_REALTIME_VOICE, REALTIME_MODELS, REALTIME_VOICES, defaultVoiceOf, readVoiceSettings, realtimeVoiceLabel } from "./voice/settings";
import { VoiceSampleButton } from "./voice/VoiceSampleButton";
import { CALL_LOOKS, voiceLabel } from "./voice/callView";
import { DEFAULT_LANDING_TEXTURE, FONT_SIZES, MAX_ROUNDS, SCROLLBACK_CHOICES, keyNamesIn, type AppSettings } from "./settings";
import { HostsSettings } from "./HostsSettings";
import { LegacyImportPanel } from "./LegacyImportScreen";
import { ModelGatewaySettings } from "./ModelGatewaySettings";
import { gatewayOwner } from "./modelGateway";
import { ModsSettings } from "./ModsSettings";
import { PhonesSettings } from "./PhonesSettings";
import { shortcutList } from "./shortcuts";
import { updateActions, updateNote, type UpdateStatus } from "./updates.ts";
import type { Access, AgentInfo, ParticipantConfig, TurnPolicy } from "./types";

export type SettingsSection = "general" | "appearance" | "hosts" | "phones" | "providers" | "gateway" | "calls" | "threads" | "terminal" | "mods" | "shortcuts";

const ALL_SECTIONS: { id: SettingsSection; label: string }[] = [
  { id: "general", label: "General" },
  { id: "appearance", label: "Appearance" },
  { id: "hosts", label: "Hosts" },
  { id: "phones", label: "Phones" },
  { id: "providers", label: "Providers" },
  { id: "gateway", label: "Model gateway" },
  { id: "calls", label: "Calls" },
  { id: "threads", label: "New threads" },
  { id: "terminal", label: "Terminal" },
  { id: "mods", label: "Mods" },
  { id: "shortcuts", label: "Shortcuts" },
];

const EXTRAS = [
  { key: "deepseek", label: "DeepSeek", detail: "DeepSeek API models" },
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
  /** Null where Deck can't update itself: the phone, the browser preview, older desktops. */
  updates?: UpdateStatus | null;
  onRestartToUpdate?: () => void;
  onClose: () => void;
}

export function SettingsPage({ section, onSection, settings, onChange, agents, profiles, backend, updates = null, onRestartToUpdate, onClose }: Props) {
  const appearance = settings.appearance ?? defaultAppearanceSettings();
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

  // Hosts and phones only exist in the Electron app.
  const SECTIONS = ALL_SECTIONS.filter(s => s.id !== "gateway" || gatewayOwner(backend)).filter((s) => (s.id !== "hosts" && s.id !== "phones") || backend.hosts);
  const index = Math.max(0, SECTIONS.findIndex((s) => s.id === section));
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
        {section === "general" && <General backend={backend} themeName={appearance.current.name} onAppearance={() => onSection("appearance")} settings={settings} onChange={onChange} updates={updates} onRestartToUpdate={onRestartToUpdate} />}
        {section === "appearance" && <AppearanceSettings value={appearance} onChange={(appearance) => onChange({ ...settings, appearance })} landingTexture={settings.landingTexture ?? DEFAULT_LANDING_TEXTURE} onLandingTexture={(landingTexture) => onChange({ ...settings, landingTexture })} />}
        {section === "hosts" && backend.hosts && <HostsSettings backend={backend} hosts={backend.hosts} />}
        {section === "phones" && backend.hosts && <PhonesSettings backend={backend} />}
        {section === "gateway" && <ModelGatewaySettings backend={backend} />}
        {section === "providers" && <Providers settings={settings} onChange={onChange} agents={agents} profiles={profiles} backend={backend} />}
        {section === "calls" && <CallsSettings settings={settings} onChange={onChange} backend={backend} />}
        {section === "threads" && <Threads settings={settings} onChange={onChange} />}
        {section === "terminal" && <TerminalSettings settings={settings} onChange={onChange} />}
        {section === "mods" && <ModsSettings backend={backend} />}
        {section === "shortcuts" && <Shortcuts />}
      </div>
    </main>
  </div>;
}

const LEADS: Partial<Record<SettingsSection, string>> = {
  appearance: "Choose a skin, tune its surfaces, or bring one you made with AI. Changes apply to the whole deck.",
  hosts: "The machine this window runs its threads and terminals on: this Mac, or another one over SSH.",
  phones: "Phones you pair with this Mac, whether they can connect, and what each may do.",
  gateway: "Share your model stack through an endpoint you control.",
  providers: "Choose which tools appear when adding terminals and bots.",
  calls: "Voice calls: which engine handles your mic and speaking.",
  mods: "Claude Code mods that Deck runs itself and draws in its own window, for every bot.",
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

function General({ backend, themeName, onAppearance, settings, onChange, updates, onRestartToUpdate }: { backend: Backend; themeName: string; onAppearance: () => void; settings: AppSettings; onChange: (s: AppSettings) => void; updates: UpdateStatus | null; onRestartToUpdate?: () => void }) {
  const [folder, setFolder] = useState("");
  const [remembered, setRemembered] = useState(() => Object.values(rememberedModels()).filter((list) => Array.isArray(list) && list.length > 0).length);
  const [autoOpen, setAutoOpen] = useState(artifactAutoOpen);
  const [importing, setImporting] = useState(false);
  useEffect(() => { backend.dataFolder().then(setFolder, () => setFolder("")); }, [backend]);
  const voice = readVoiceSettings(settings.voice);
  return <div className="settings-card">
    <Row label="Theme" note={themeName}><button onClick={onAppearance}>Appearance…</button></Row>
    <Row label="Saved in" note={<span className="mono">{folder || "…"}</span>}>
      {!backend.demo && <button disabled={!folder} onClick={() => backend.openTarget(folder, null, false).catch(() => {})}>{showInFileManagerLabel()}</button>}
    </Row>
    <Row label="Run buttons on code blocks" note={backend.demo
      ? "Shell blocks in a bot's reply get a Run button. Running needs the desktop app, so nothing runs in this browser preview."
      : "Shell blocks in a bot's reply get a Run button. Clicking it runs the block in the thread's folder on the thread's host."}>
      <input type="checkbox" aria-label="Run buttons on code blocks" checked={settings.codeRunButtons} onChange={(e) => onChange({ ...settings, codeRunButtons: e.target.checked })} />
    </Row>
    <Row label="New artifacts" note="When a bot writes a file the artifacts pane can show.">
      <select aria-label="New artifacts" value={autoOpen ? "open" : "notify"} onChange={(e) => { const on = e.target.value === "open"; setArtifactAutoOpen(on); setAutoOpen(on); }}>
        <option value="open">Open the pane</option>
        <option value="notify">Just notify</option>
      </select>
    </Row>
    {!isWindows && <Row label="Voice for calls" note="For agents with no voice of their own. Set one agent's voice in its form.">
      <span className="voice-pick">
        <select aria-label="Voice for calls" value={defaultVoiceOf(voice)} onChange={(e) => onChange({ ...settings, voice: { ...voice, defaultVoice: e.target.value } })}>
          {[...new Set([defaultVoiceOf(voice), ...CALL_VOICES])].map((v) => <option key={v} value={v}>{voiceLabel(v)}</option>)}
        </select>
        <VoiceSampleButton voice={defaultVoiceOf(voice)} />
      </span>
    </Row>}
    <Row label="Remembered models" note={remembered === 0 ? "None yet. Model names you type in the bot form are offered again next time." : `Model names from ${remembered} ${remembered === 1 ? "provider" : "providers"}, offered again in the bot form.`}>
      <button disabled={remembered === 0} onClick={() => { forgetModels(); setRemembered(0); }}>Clear</button>
    </Row>
    <Row label="Older records" note="Tasks, conversations, group chats and assistants saved before this machine kept them safely. Nothing changes until you import, and the originals stay put.">
      <button onClick={() => setImporting(true)}>Review…</button>
    </Row>
    {importing && <LegacyImportPanel backend={backend} startOpen onClose={() => setImporting(false)} />}
    {updates ? <VersionRow updates={updates} onRestart={onRestartToUpdate} /> : <Row label="Version" note={`Apex Deck ${__APP_VERSION__}`} />}
  </div>;
}

/** The version, how updating stands, and the one button that fits it. */
function VersionRow({ updates, onRestart }: { updates: UpdateStatus; onRestart?: () => void }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  const working = ["checking", "downloading", "verifying", "installing"].includes(updates.state);
  return <Row label="Version" note={<span role="status">{updateNote(updates, now)}</span>}>
    {updates.state === "ready" && onRestart
      ? <button className="primary" onClick={onRestart}>Restart to update</button>
      : updates.state !== "disabled" && <button disabled={working} onClick={() => void updateActions.check()}>{updates.state === "checking" ? "Checking…" : "Check now"}</button>}
  </Row>;
}

/** Picture providers read their keys from these names; each one's /image name is shown beside it. */
const IMAGE_KEYS = [{ name: "OPENAI_API_KEY", image: "chatgpt" }, { name: "XAI_API_KEY", image: "grok" }, { name: "VENICE_API_KEY", image: "venice" }];
const KEY_STATE_LABEL: Record<KeyState, string> = { saved: "Saved", environment: "From environment", missing: "Missing" };

function usageNote(agents: number, image?: string) {
  const parts = [];
  if (agents > 0) parts.push(`Used by ${agents} saved ${agents === 1 ? "agent" : "agents"}`);
  if (image) parts.push(`Used by /image ${image}`);
  return parts.length > 0 ? `${parts.join(". ")}.` : "Not used by a saved agent yet.";
}

function KeyRow({ name, note, state, backend, onChanged }: { name: string; note: string; state?: KeyState; backend: Backend; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const fail = (e: unknown) => setError(e instanceof Error ? e.message : String(e));
  const save = async () => {
    const value = draft.trim();
    if (!value || busy) return;
    setDraft("");
    setBusy(true); setError("");
    try { await backend.apiKeySave(name, value); setEditing(false); onChanged(); }
    catch (e) { fail(e); }
    finally { setBusy(false); }
  };
  const remove = async () => {
    setBusy(true); setError("");
    try { await backend.apiKeyRemove(name); onChanged(); }
    catch (e) { fail(e); }
    finally { setBusy(false); }
  };
  return <>
    <Row label={name} note={error || note}>
      {!backend.demo && state && <span className={state === "missing" ? "key-state missing" : "key-state found"}><span className="dot" aria-hidden="true" />{KEY_STATE_LABEL[state]}</span>}
      {!editing && <button className="ghost" disabled={busy} onClick={() => { setError(""); setEditing(true); }}>{state === "saved" || state === "environment" ? "Replace" : "Add key"}</button>}
      {state === "saved" && !editing && <button className="ghost" disabled={busy} onClick={remove}>Remove</button>}
    </Row>
    {editing && <Row label="New key" note="Enter saves. Deck never shows it again.">
      <input type="password" aria-label={`${name} value`} autoComplete="off" spellCheck={false} disabled={busy} value={draft} autoFocus onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); save(); } else if (e.key === "Escape") { setDraft(""); setEditing(false); } }} />
      <button disabled={!draft.trim() || busy} onClick={save}>{busy ? "Saving…" : "Save"}</button>
      <button className="ghost" disabled={busy} onClick={() => { setDraft(""); setEditing(false); }}>Cancel</button>
    </Row>}
  </>;
}

function Providers({ settings, onChange, agents, profiles, backend }: { settings: AppSettings; onChange: (s: AppSettings) => void; agents: AgentInfo[]; profiles: ParticipantConfig[]; backend: Backend }) {
  const disabled = settings.disabledProviders;
  const setDisabled = (next: string[]) => onChange({ ...settings, disabledProviders: next });
  const rows = [...agents.map((a) => ({ key: a.key, label: a.label, detail: a.found ? a.program : "Not installed" })), ...EXTRAS];
  const uses = useMemo(() => {
    const map = new Map<string, { agents: number; image?: string }>();
    for (const k of keyNamesIn(profiles)) map.set(k.name, { agents: k.uses });
    for (const { name, image } of IMAGE_KEYS) map.set(name, { agents: map.get(name)?.agents ?? 0, image });
    return map;
  }, [profiles]);
  const names = useMemo(() => [...uses.keys()].sort((a, b) => a.localeCompare(b)), [uses]);
  const [states, setStates] = useState<Record<string, KeyState>>({});
  const refresh = useCallback(() => {
    if (names.length === 0) { setStates({}); return; }
    backend.apiKeyStatus(names).then((list) => setStates(Object.fromEntries(names.map((n, i) => [n, list[i]]))), () => setStates({}));
  }, [backend, names]);
  useEffect(() => { refresh(); }, [refresh]);
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
      <p>Keys your bots and /image use. Saved in this Mac's Keychain, or a private file on Linux servers. Deck never shows a saved key again.</p>
    </div>
    <div className="settings-card">
      {names.map((name) => <KeyRow key={name} name={name} note={usageNote(uses.get(name)?.agents ?? 0, uses.get(name)?.image)} state={states[name]} backend={backend} onChanged={refresh} />)}
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
    <Row label="Model-to-model rounds" note="How many times bots may answer each other after one of your messages. Step past 10 for unlimited (∞), which runs until you press Stop.">
      <span className="stepper">
        <button type="button" aria-label="Less rounds" disabled={thread.max_bot_hops !== null && thread.max_bot_hops <= 0} onClick={() => onChange({ ...settings, newThread: { ...thread, max_bot_hops: thread.max_bot_hops === null ? MAX_ROUNDS : thread.max_bot_hops - 1 } })}>−</button>
        <output aria-label="rounds">{thread.max_bot_hops ?? "∞"}</output>
        <button type="button" aria-label="More rounds" disabled={thread.max_bot_hops === null} onClick={() => onChange({ ...settings, newThread: { ...thread, max_bot_hops: thread.max_bot_hops !== null && thread.max_bot_hops >= MAX_ROUNDS ? null : (thread.max_bot_hops ?? 0) + 1 } })}>+</button>
      </span>
    </Row>
    <Row label="Access for new bots" note="Ask first only works with tools that can enforce it. Others start at Read only.">
      <select aria-label="Access for new bots" value={settings.newBotAccess} onChange={(e) => onChange({ ...settings, newBotAccess: e.target.value as Access })}>
        <option value="read">Read only</option>
        <option value="ask">Ask first</option>
        <option value="edits">Can edit files</option>
        <option value="full">Full access</option>
      </select>
    </Row>
    <Row label="Confirm before steering" note="Steering stops a bot mid-turn. Threads can override this in Thread details.">
      <input type="checkbox" aria-label="Confirm before steering" checked={settings.confirmSteer} onChange={(e) => onChange({ ...settings, confirmSteer: e.target.checked })} />
    </Row>
    <div className="settings-subhead"><h3>Bot chips</h3><p>What each bot's chip under the message box shows. Compact styles keep details in the hover card and bot settings.</p></div>
    <div className="settings-row chip-style-row">
      <div className="settings-label"><strong>Chip style</strong><small>Applies to all chats, including popped-out windows. Hover a name to preview it; click to use it.</small></div>
      <ChipStylePicker value={settings.botChips.style ?? "classic"} onChange={(style) => onChange({ ...settings, botChips: { ...settings.botChips, style } })} />
    </div>
    <Row label="Show effort" note="How hard the bot thinks, such as high.">
      <input type="checkbox" aria-label="Show effort" checked={settings.botChips.effort} onChange={(e) => onChange({ ...settings, botChips: { ...settings.botChips, effort: e.target.checked } })} />
    </Row>
    <Row label="Show usage" note="Context and plan left. A bot running low still shows its warning.">
      <input type="checkbox" aria-label="Show usage" checked={settings.botChips.usage} onChange={(e) => onChange({ ...settings, botChips: { ...settings.botChips, usage: e.target.checked } })} />
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

function CallsSettings({ settings, onChange, backend }: { settings: AppSettings; onChange: (s: AppSettings) => void; backend: Backend }) {
  const voice = readVoiceSettings(settings.voice);
  const [keyState, setKeyState] = useState<KeyState | null>(null);
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const refreshKey = useCallback(() => {
    backend.apiKeyStatus(["OPENAI_API_KEY"]).then(list => setKeyState(list[0]), () => setKeyState(null));
  }, [backend]);
  useEffect(() => { refreshKey(); }, [refreshKey]);

  const canRealtime = keyState === "saved" || keyState === "environment";
  const setEngine = (engine: "local" | "realtime") => {
    onChange({ ...settings, voice: { ...voice, engine } });
  };
  const setRealtimeVoice = (v: string) => {
    onChange({ ...settings, voice: { ...voice, realtimeVoice: v } });
  };
  const saveKey = async () => {
    const v = draft.trim(); if (!v || busy) return;
    setBusy(true); setErr("");
    try { await backend.apiKeySave("OPENAI_API_KEY", v); setDraft(""); setEditing(false); refreshKey(); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  const removeKey = async () => {
    setBusy(true); setErr("");
    try { await backend.apiKeyRemove("OPENAI_API_KEY"); refreshKey(); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  return <div className="settings-card">
    <Row label="Call engine" note={canRealtime ? "Local uses Whisper+Kokoro on this Mac. GPT-Live uses OpenAI Realtime with delegation to Deck agents in the active thread." : "Add an OpenAI API key to enable GPT-Live."}>
      <span className="voice-seg" role="group" aria-label="Call engine">
        <button type="button" aria-pressed={voice.engine !== "realtime"} onClick={() => setEngine("local")}>Local</button>
        <button type="button" aria-pressed={voice.engine === "realtime"} disabled={!canRealtime} title={!canRealtime ? "Add an OpenAI key first" : undefined} onClick={() => setEngine("realtime")}>GPT-Live</button>
      </span>
    </Row>
    {voice.engine === "realtime" && <Row label="GPT-Live voice" note="Voice GPT-Live speaks with (OpenAI realtime voices).">
      <select aria-label="GPT-Live voice" value={voice.realtimeVoice ?? DEFAULT_REALTIME_VOICE} onChange={e => setRealtimeVoice(e.target.value)}>
        {REALTIME_VOICES.map(v => <option key={v} value={v}>{realtimeVoiceLabel(v)}</option>)}
      </select>
    </Row>}
    {voice.engine === "realtime" && <Row label="GPT-Live model" note="OpenAI realtime model. Applies next call.">
      <select aria-label="GPT-Live model" value={voice.realtimeModel ?? DEFAULT_REALTIME_MODEL} onChange={e => onChange({ ...settings, voice: { ...voice, realtimeModel: e.target.value } })}>
        {REALTIME_MODELS.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
      </select>
    </Row>}
    <Row label="OpenAI API key" note={err || (keyState ? KEY_STATE_LABEL[keyState] + (keyState === "environment" ? " – remove from shell to replace here." : "") + (keyState !== "missing" ? " Key never shown; only a short-lived token reaches the call." : " Needed for GPT-Live. Realtime requires API key auth; ChatGPT login alone is not enough.") : "Checking…")}>
      {!editing && <>
        <button className="ghost" disabled={busy} onClick={() => { setErr(""); setEditing(true); }}>{keyState === "saved" || keyState === "environment" ? "Replace" : "Add key"}</button>
        {keyState === "saved" && <button className="ghost" disabled={busy} onClick={removeKey}>Remove</button>}
      </>}
    </Row>
    {editing && <Row label="New key" note="Enter saves. Deck never shows it again.">
      <input type="password" aria-label="OPENAI_API_KEY value" autoComplete="off" spellCheck={false} disabled={busy} value={draft} autoFocus onChange={e => setDraft(e.target.value)} onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); saveKey(); } else if (e.key === "Escape") { setDraft(""); setEditing(false); } }} />
      <button disabled={!draft.trim() || busy} onClick={saveKey}>{busy ? "Saving…" : "Save"}</button>
      <button className="ghost" disabled={busy} onClick={() => { setDraft(""); setEditing(false); }}>Cancel</button>
    </Row>}

    <Row label="Local voice" note="For agents with no voice of their own. Set one agent's voice in its form.">
      <span className="voice-pick">
        <select aria-label="Voice for calls" value={defaultVoiceOf(voice)} onChange={(e) => onChange({ ...settings, voice: { ...voice, defaultVoice: e.target.value } })}>
          {[...new Set([defaultVoiceOf(voice), ...CALL_VOICES])].map((v) => <option key={v} value={v}>{voiceLabel(v)}</option>)}
        </select>
        <VoiceSampleButton voice={defaultVoiceOf(voice)} />
      </span>
    </Row>
    <Row label="Pause before reply" note="Silence before agent replies (local calls).">
      <input type="range" min="100" max="2000" step="50" value={voice.silenceMs} onChange={e => onChange({ ...settings, voice: { ...voice, silenceMs: e.target.valueAsNumber } })} />
      <span>{voice.silenceMs} ms</span>
    </Row>
    <Row label="Call controls" note="How a running call shows. Applies to all chats, including pop-outs.">
      <span className="voice-seg" role="group" aria-label="Call controls">
        {CALL_LOOKS.map(l => <button type="button" key={l.id} aria-pressed={l.id === voice.look} onClick={() => onChange({ ...settings, voice: { ...voice, look: l.id as any } })}>{l.label}</button>)}
      </span>
    </Row>
    {!canRealtime && <p className="settings-note">Get a key at platform.openai.com with Realtime access. The long-lived key stays in the daemon (Keychain); the renderer only ever gets an ephemeral client_secret.</p>}
  </div>;
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
