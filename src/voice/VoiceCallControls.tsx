import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Avatar } from "../Avatar";
import { popoverTop } from "../floating.ts";
import { CALL_LOOKS, callClock, callLine, pickNote, pickRows, readCallLook, voiceLabel, type CallLook, type WaveMode } from "./callView.ts";
import { voiceController, voiceRegistration, warmVoice } from "./coordinator.ts";
import { chatVoice, preferenceFor, voiceFor, withChatPreference } from "./settings.ts";
import type { VoiceCandidate, VoiceSettings } from "./types.ts";
import "./voice.css";

/** A bot's avatar colours and kind, for the call's name and the Call who? menu. */
export type VoiceWho = (participantId: string) => { seed: string; color: string; kind?: string };
type Props = { candidates: VoiceCandidate[]; settings?: VoiceSettings; who?: VoiceWho };

// What the call's controls show beyond the call itself, shared by the mic, the bar and the capsule:
// `tucked` hides the bar (A) while the call keeps going; `open` shows the call settings.
let ui = { tucked: false, open: false };
const uiListeners = new Set<() => void>();
const setUi = (patch: Partial<typeof ui>) => {
  ui = { ...ui, ...patch };
  uiListeners.forEach((fn) => fn());
};
const subscribeUi = (fn: () => void) => {
  uiListeners.add(fn);
  return () => void uiListeners.delete(fn);
};
voiceController.subscribe(() => {
  const status = voiceController.getState().status;
  if (status === "off" && (ui.tucked || ui.open)) setUi({ tucked: false, open: false });
  // A question or a problem always brings the bar back.
  if (status === "needs-attention" && ui.tucked) setUi({ tucked: false });
});

function useCall({ candidates, settings }: Props) {
  const state = useSyncExternalStore(voiceController.subscribe, voiceController.getState);
  const shown = useSyncExternalStore(subscribeUi, () => ui);
  const scope = state.scope;
  const here = !!scope && candidates.some((c) => c.hostId === scope.hostId && c.roomId === scope.roomId);
  const candidate = scope
    ? candidates.find((c) => c.participantId === scope.participantId && c.hostId === scope.hostId && c.roomId === scope.roomId)
    : undefined;
  const live = here && !["off", "error", "setup"].includes(state.status);
  const name = candidate?.name ?? "Agent";
  return { state, ui: shown, scope, here, candidate, live, name, look: readCallLook(settings?.look), line: callLine(state, name) };
}

/** The chat box's grey hint during a call, for the looks that leave the status there. */
export function useVoiceHint(props: Props): string | undefined {
  const call = useCall(props);
  if (!call.live) return undefined;
  if (call.look === "pill") return call.line.hint;
  if (call.look === "bar") return "Type while you talk…";
  return undefined;
}

/** Whether a call is running in these candidates' thread, and its look: the composer's round button follows it. */
export function useVoiceSlot(props: Props): { live: boolean; look: CallLook } {
  const call = useCall(props);
  return { live: call.live, look: call.look };
}

const Icon = {
  mic: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 10v2a7 7 0 0014 0v-2M12 19v3M8 22h8" />
    </svg>
  ),
  micOff: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 10v2a7 7 0 0014 0v-2M12 19v3M8 22h8M3 3l18 18" />
    </svg>
  ),
  tune: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      <path d="M4 7h9M17 7h3M4 17h3M11 17h9" />
      <circle cx="15" cy="7" r="2" />
      <circle cx="9" cy="17" r="2" />
    </svg>
  ),
  hang: (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
      <path fill="currentColor" d="M12 9c-3.3 0-6.4 1-8.9 2.8-.6.4-.8 1.2-.5 1.9l1 2.1c.3.7 1.1 1 1.8.8l2.6-.9c.6-.2 1-.8 1-1.4v-1.9c1.9-.5 4.1-.5 6 0v1.9c0 .6.4 1.2 1 1.4l2.6.9c.7.2 1.5-.1 1.8-.8l1-2.1c.3-.7.1-1.5-.5-1.9C18.4 10 15.3 9 12 9z" />
    </svg>
  ),
  play: (
    <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
      <path fill="currentColor" d="M8 5.5v13l11-6.5z" />
    </svg>
  ),
};

function Wave({ mode }: { mode: WaveMode }) {
  return (
    <span className="voice-wave" data-mode={mode} aria-hidden="true">
      <i />
      <i />
      <i />
      <i />
      <i />
    </span>
  );
}

function Clock({ since }: { since?: number }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return <span className="voice-timer">{callClock(since === undefined ? 0 : now - since)}</span>;
}

function Mute({ muted }: { muted: boolean }) {
  return (
    <button type="button" className="voice-callbtn" aria-pressed={muted} aria-label={muted ? "Unmute microphone" : "Mute microphone"}
      title={muted ? "Unmute" : "Mute · the bot keeps talking"} onClick={() => voiceController.mute(!muted)}>
      {muted ? Icon.micOff : Icon.mic}
    </button>
  );
}

function End({ round = false }: { round?: boolean }) {
  return (
    <button type="button" className={`voice-end${round ? " round" : ""}`} aria-label="End call" title="End call" onClick={() => void voiceController.end()}>
      {Icon.hang}
      {!round && "End"}
    </button>
  );
}

function Who({ who, id }: { who?: VoiceWho; id?: string }) {
  const look = id && who?.(id);
  return look ? <Avatar seed={look.seed} color={look.color} size="sm" /> : null;
}

/** A small panel on `document.body`, beside `anchor`: below when there is room, else above. */
function Popover({ anchor, onClose, align = "end", className, label, role = "dialog", children }: {
  anchor: RefObject<HTMLElement | null>;
  onClose(): void;
  align?: "end" | "center";
  className: string;
  label: string;
  role?: "dialog" | "menu";
  children: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useLayoutEffect(() => {
    const place = () => {
      const target = anchor.current, pop = box.current;
      if (!target || !pop) return;
      const a = target.getBoundingClientRect(), b = pop.getBoundingClientRect();
      const left = align === "center" ? a.left + a.width / 2 - b.width / 2 : a.right - b.width;
      pop.style.left = `${Math.max(8, Math.min(left, window.innerWidth - b.width - 8))}px`;
      pop.style.top = `${popoverTop(a, b.height, window.innerHeight)}px`;
    };
    place();
    const resize = new ResizeObserver(place);
    if (box.current) resize.observe(box.current);
    if (anchor.current) resize.observe(anchor.current);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      resize.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [anchor, align]);
  useEffect(() => {
    // Clicks on the anchor are left to its own toggle.
    const down = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!box.current?.contains(t) && !anchor.current?.contains(t)) close.current();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      close.current();
      anchor.current?.querySelector<HTMLElement>("button")?.focus();
    };
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", down, true);
      document.removeEventListener("keydown", key);
    };
  }, [anchor]);
  return createPortal(
    <div ref={box} className={`voice-pop voice-call-ui ${className}`} role={role} aria-label={label}>
      {children}
    </div>,
    document.body,
  );
}

const choose = (c: VoiceCandidate, active: boolean) => {
  const r = voiceRegistration(c);
  r.save({ ...r.settings, enabled: true });
  void (active ? voiceController.switchAgent(c) : voiceController.start(c));
};

function PickMenu({ list, who, active, onDone, threadQuery }: { list: VoiceCandidate[]; who?: VoiceWho; active: boolean; onDone(): void; threadQuery?: string }) {
  const choosingThread = threadQuery !== undefined;
  return (
    <>
      <div className="voice-pop-head">{choosingThread ? "Which thread?" : "Call who?"}</div>
      {choosingThread && <p className="voice-pop-note">Heard “{threadQuery}”.</p>}
      {pickRows(list, (c) => who?.(c.participantId).kind ?? "", choosingThread).map(({ candidate: c, detail }) => (
        <button type="button" role="menuitem" className="voice-pick-row" key={JSON.stringify(c)} title={detail || undefined}
          onClick={() => { onDone(); choose(c, active); }}>
          <Who who={who} id={c.participantId} />
          <b>{c.name}</b>
          <span>{detail}</span>
        </button>
      ))}
      <p className="voice-pop-note">{pickNote(list, choosingThread)}</p>
    </>
  );
}

/** One settings panel for all three looks: who you're talking to, their voice, the pause, nicknames, and the look itself. */
function CallSettings({ call, candidates }: { call: ReturnType<typeof useCall>; candidates: VoiceCandidate[] }) {
  const { scope, candidate, state, name } = call;
  if (!scope) return null;
  const r = voiceRegistration(scope);
  const settings = r.settings;
  const profile = candidate?.profileId ?? scope.participantId;
  const preference = preferenceFor(settings, scope.hostId, profile, scope.roomId, scope.participantId);
  // A voice picked here is for this chat only; "Default" follows the agent's form, then Settings.
  const picked = chatVoice(settings, scope.hostId, profile, scope.roomId, scope.participantId);
  const fallback = voiceFor(settings, scope.hostId, profile, undefined, undefined, candidate?.agentVoice);
  const speaking = picked || fallback;
  const savePreference = (patch: Partial<typeof preference>) =>
    r.save(withChatPreference(r.settings, scope.hostId, profile, scope.roomId, scope.participantId, patch));
  const look = readCallLook(settings.look);
  const here = candidates.filter((c) => c.hostId === scope.hostId && c.roomId === scope.roomId);
  return (
    <>
      <div className="voice-pop-head">Call settings</div>
      {here.length > 1 && (
        <div className="voice-set-row">
          <span>Talking to</span>
          <span className="voice-seg" role="group" aria-label="Talking to">
            {here.map((c) => (
              <button type="button" key={c.participantId} aria-pressed={c.participantId === scope.participantId}
                onClick={() => c.participantId !== scope.participantId && choose(c, true)}>
                {c.name}
              </button>
            ))}
          </span>
        </div>
      )}
      <label className="voice-set-row">
        <span>{name}'s voice</span>
        <span className="voice-voice">
          <select value={picked} disabled={!state.voices.length} onChange={(e) => savePreference({ voice: e.target.value })}>
            <option value="">Default · {voiceLabel(fallback)}</option>
            {[...new Set([...(picked ? [picked] : []), ...state.voices])].map((v) => (
              <option key={v} value={v}>{voiceLabel(v)}</option>
            ))}
          </select>
          <button type="button" className="voice-callbtn boxed" aria-label="Preview voice" title="Preview voice"
            disabled={!state.voices.includes(speaking)} onClick={() => voiceController.preview(speaking)}>
            {Icon.play}
          </button>
        </span>
      </label>
      <label className="voice-set-row col">
        <span>Pause before reply <b>{settings.silenceMs} ms</b></span>
        <input type="range" min="100" max="2000" step="50" value={settings.silenceMs}
          onChange={(e) => r.save({ ...r.settings, silenceMs: e.target.valueAsNumber })} />
      </label>
      <label className="voice-set-row">
        <span>Nicknames</span>
        <input type="text" value={preference.aliases.join(", ")} placeholder={`e.g. ${name.slice(0, -1) || name}, ${name}s`}
          onChange={(e) => savePreference({ aliases: e.target.value.split(",").slice(0, 16).map((x) => x.trim().slice(0, 64)) })} />
      </label>
      <div className="voice-set-row">
        <span>Call controls</span>
        <span className="voice-seg" role="group" aria-label="Call controls">
          {CALL_LOOKS.map((l) => (
            <button type="button" key={l.id} aria-pressed={l.id === look} onClick={() => r.save({ ...r.settings, look: l.id as CallLook })}>
              {l.label}
            </button>
          ))}
        </span>
      </div>
      <p className="voice-pop-note">{state.semantic ? "Smart Turn is on" : "Silence only"} · pause applies next call</p>
    </>
  );
}

const agentStyle = (who: VoiceWho | undefined, id: string | undefined) =>
  (id && who ? { "--agent": who(id).color } : undefined) as CSSProperties | undefined;
const toneClass = (tone: string) => (tone === "ok" ? "" : ` tone-${tone}`);

/** Look A: a slim bar over the chat box for the whole call. */
export function VoiceCallBar(props: Props) {
  const call = useCall(props);
  const tune = useRef<HTMLButtonElement>(null);
  if (!window.apexDeck?.voice || !call.live || call.look !== "bar" || call.ui.tucked) return null;
  return (
    <div className={`voice-callbar voice-call-ui${toneClass(call.line.tone)}`} role="region" aria-label="Voice call" style={agentStyle(props.who, call.scope?.participantId)}>
      <span className="voice-live-dot" aria-hidden="true" />
      <Who who={props.who} id={call.scope?.participantId} />
      <span className="voice-who">{call.name}</span>
      <span className="voice-status" role="status">{call.line.status}</span>
      <Wave mode={call.line.wave} />
      <span className="voice-spacer" />
      <Clock since={call.state.startedAt} />
      <Mute muted={call.state.muted} />
      <button ref={tune} type="button" className="voice-callbtn" aria-expanded={call.ui.open} aria-label="Call settings" title="Call settings"
        onClick={() => setUi({ open: !ui.open })}>
        {Icon.tune}
      </button>
      <End />
      {call.ui.open && (
        <Popover anchor={tune} onClose={() => setUi({ open: false })} className="voice-settings" label="Call settings">
          <CallSettings call={call} candidates={props.candidates} />
        </Popover>
      )}
    </div>
  );
}

/** Look C: a capsule in the thread's top bar. Tap it for the call settings. */
export function VoiceCallCapsule(props: Props) {
  const call = useCall(props);
  const capsule = useRef<HTMLDivElement>(null);
  if (!window.apexDeck?.voice || !call.live || call.look !== "capsule") return null;
  return (
    <div ref={capsule} className={`voice-capsule voice-call-ui${toneClass(call.line.tone)}${call.ui.open ? " open" : ""}`} role="region" aria-label="Voice call"
      style={agentStyle(props.who, call.scope?.participantId)} onPointerDown={(e) => e.stopPropagation()}>
      <button type="button" className="voice-capsule-body" aria-expanded={call.ui.open} title="Call settings" onClick={() => setUi({ open: !ui.open })}>
        <Who who={props.who} id={call.scope?.participantId} />
        <span className="voice-who">{call.name}</span>
        <span className="voice-status" role="status">{call.line.status}</span>
        <Wave mode={call.line.wave} />
      </button>
      <Clock since={call.state.startedAt} />
      <Mute muted={call.state.muted} />
      <End round />
      {call.ui.open && (
        <Popover anchor={capsule} align="center" onClose={() => setUi({ open: false })} className="voice-settings" label="Call settings">
          <CallSettings call={call} candidates={props.candidates} />
        </Popover>
      )}
    </div>
  );
}

/** The mic beside Send. In look B it becomes the call pill; in A and C it shows or hides that look's controls. */
export function VoiceCallControls({ disabled = false, ...props }: Props & { disabled?: boolean }) {
  const call = useCall(props);
  const { candidates, who } = props;
  const { state, scope, here, live, look } = call;
  const [picking, setPicking] = useState(false);
  const [progress, setProgress] = useState("");
  const [installing, setInstalling] = useState(false);
  const [download, setDownload] = useState(0);
  const wrap = useRef<HTMLDivElement>(null);
  const mid = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const r = window.apexDeck?.voice;
    if (!r) return;
    void r.status().then((s) => setDownload(s.downloadBytes));
    return r.onProgress((p) =>
      setProgress(`${p.stage}${p.total ? " · " + Math.min(100, Math.round((p.downloaded / p.total) * 100)) + "%" : ""}`),
    );
  }, []);
  if (!window.apexDeck?.voice) return null;
  const active = !["off", "error"].includes(state.status);
  const start = () => {
    if (candidates.length === 1) choose(candidates[0], false);
    else setPicking(!picking);
  };
  const install = async () => {
    setInstalling(true);
    try {
      await window.apexDeck!.voice!.install();
      setProgress("Setup complete. Tap Start call.");
    } catch (e) {
      setProgress(String(e));
    } finally {
      setInstalling(false);
    }
  };
  const asking = here && state.candidates?.length ? state.candidates : undefined;
  const menu = asking ?? (picking ? candidates : undefined);
  const mic = (
    <button type="button" className={`voice-mic${live ? " live" : ""}`} disabled={disabled || !candidates.length}
      aria-label={!live ? "Call an agent" : look === "bar" ? (call.ui.tucked ? "Show the call bar" : "Hide the call bar") : "Call settings"}
      aria-expanded={live ? (look === "bar" ? !call.ui.tucked : call.ui.open) : !!menu}
      title={!live ? "Call an agent" : look === "bar" ? (call.ui.tucked ? "Show the call bar · call active" : "Hide the call bar · call stays active") : "Call settings · call active"}
      onClick={() => (!live ? start() : look === "bar" ? setUi({ tucked: !ui.tucked, open: false }) : setUi({ open: !ui.open }))}
      onPointerEnter={() => { if (!active) warmVoice(); }}
      onFocus={() => { if (!active) warmVoice(); }}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
        <rect x="9" y="2" width="6" height="12" rx="3" />
        <path d="M5 10v2a7 7 0 0014 0v-2M12 19v3M8 22h8" />
      </svg>
    </button>
  );
  return (
    <div ref={wrap} className="voice-call-controls">
      {live && look === "pill" ? (
        <div className={`voice-pill voice-call-ui${toneClass(call.line.tone)}`} role="group" aria-label={`Voice call with ${call.name}`}
          style={agentStyle(who, scope?.participantId)}>
          <Mute muted={state.muted} />
          <button ref={mid} type="button" className="voice-pill-mid" aria-expanded={call.ui.open} aria-label={`${call.line.status}. Call settings`}
            title={`${call.name} · ${call.line.status} · call settings`} onClick={() => setUi({ open: !ui.open })}>
            <Wave mode={call.line.wave} />
            <Clock since={state.startedAt} />
          </button>
          <End round />
        </div>
      ) : mic}
      {live && look === "pill" && call.ui.open && (
        <Popover anchor={mid} onClose={() => setUi({ open: false })} className="voice-settings" label="Call settings">
          <CallSettings call={call} candidates={candidates} />
        </Popover>
      )}
      {menu && (
        <Popover anchor={wrap} role="menu" className="voice-pick" label={asking && state.threadQuery !== undefined ? "Which thread?" : "Call who?"} onClose={() => setPicking(false)}>
          <PickMenu list={menu} who={who} active={active && here} onDone={() => setPicking(false)} threadQuery={asking ? state.threadQuery : undefined} />
        </Popover>
      )}
      {here && state.status === "setup" && (
        <Popover anchor={wrap} className="voice-setup" label="Set up local voice" onClose={() => { if (!installing) void voiceController.end("setup closed"); }}>
          <div className="voice-pop-head">Set up local voice</div>
          <p>
            Download local speech ({(download / 1e9).toFixed(2)} GB). Whisper listens and Kokoro speaks on this Mac; messages use your
            agent’s existing provider. Allow about {((download * 3) / 1e9).toFixed(1)} GB of free disk space.
          </p>
          <div className="voice-pop-actions">
            {installing ? (
              <button type="button" onClick={() => void window.apexDeck?.voice?.cancelInstall()}>Cancel download</button>
            ) : progress.startsWith("Setup complete") && scope ? (
              <button type="button" className="primary" onClick={() => void voiceController.start(scope)}>Start call</button>
            ) : (
              <button type="button" className="primary" onClick={() => void install()}>Download local voice</button>
            )}
          </div>
          {progress && <span role="status" className="voice-pop-note">{progress}</span>}
        </Popover>
      )}
      {here && state.status === "error" && (
        <Popover anchor={wrap} className="voice-setup" label="Call ended" onClose={() => void voiceController.end("error dismissed")}>
          <div className="voice-pop-head">Call ended</div>
          <p role="status">{state.error ?? "The call stopped."}</p>
          <div className="voice-pop-actions">
            <button type="button" onClick={() => void voiceController.end("error dismissed")}>Close</button>
            {call.candidate && <button type="button" className="primary" onClick={() => choose(call.candidate!, false)}>Call again</button>}
          </div>
        </Popover>
      )}
    </div>
  );
}
