import { createPortal } from "react-dom";
import { useEffect, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import { Avatar } from "../Avatar";
import type { PhoneVoice } from "./phoneVoice.ts";
import type { ServerVoiceLink, ServerVoiceStatus, VoiceCandidate } from "../voice/types.ts";
import { CALL_LOOKS, callClock, callLine, voiceLabel, type CallLook, type WaveMode } from "../voice/callView.ts";
import { DEFAULT_VOICE, preferenceFor, voicePreferenceKey } from "../voice/settings.ts";
import { voiceCallView } from "./voiceCallView.ts";
import "./voice-call.css";

/** A bot's avatar seed and colour, for the call's name, the strip and Call who?. */
export type PhoneVoiceWho = (participantId: string) => { seed: string; color: string } | undefined;
type SheetProps = { title: string; onClose(): void; children: ReactNode };
type Base = { voice: PhoneVoice; hostId: string; roomId: string; who?: PhoneVoiceWho };

// One sheet for the whole call, shared by the mic, the pill, the strip (look A) and the capsule (look C).
type Open = "settings" | "pick" | "setup" | null;
let open: Open = null;
const openListeners = new Set<() => void>();
const setOpen = (value: Open) => {
  open = value;
  openListeners.forEach((fn) => fn());
};
const subscribeOpen = (fn: () => void) => {
  openListeners.add(fn);
  return () => void openListeners.delete(fn);
};

const LIVE_OFF = ["off", "error", "setup"];
function usePhoneCall({ voice, hostId, roomId }: Base) {
  const [, redraw] = useState(0);
  useEffect(() => voice.subscribe(() => redraw((n) => n + 1)), [voice]);
  const state = voice.controller.getState();
  const scope = state.scope;
  const here = !!scope && scope.hostId === hostId && scope.roomId === roomId;
  const live = here && !LIVE_OFF.includes(state.status);
  const candidates = voice.candidates(hostId, roomId);
  const candidate = here ? candidates.find((c) => c.participantId === scope!.participantId) : undefined;
  const name = candidate?.name ?? "Agent";
  const settings = voice.settingsFor(hostId);
  let line = callLine(state, name);
  if (voice.view().weak && !state.muted && ["listening", "hearing"].includes(state.status))
    line = { ...line, status: "Weak connection", hint: "Weak connection · some words may be lost", tone: "warn" };
  return { state, here, live, candidates, candidate, name, settings, look: settings.look, line };
}
type Call = ReturnType<typeof usePhoneCall>;

const Ico = {
  mic: (
    <svg className="ph-call-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 10v2a7 7 0 0014 0v-2M12 19v3M8 22h8" />
    </svg>
  ),
  micOff: (
    <svg className="ph-call-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 10v2a7 7 0 0014 0v-2M12 19v3M8 22h8M3 3l18 18" />
    </svg>
  ),
  hang: (
    <svg className="ph-call-ico" viewBox="0 0 24 24" aria-hidden="true">
      <path fill="currentColor" d="M12 9c-3.3 0-6.4 1-8.9 2.8-.6.4-.8 1.2-.5 1.9l1 2.1c.3.7 1.1 1 1.8.8l2.6-.9c.6-.2 1-.8 1-1.4v-1.9c1.9-.5 4.1-.5 6 0v1.9c0 .6.4 1.2 1 1.4l2.6.9c.7.2 1.5-.1 1.8-.8l1-2.1c.3-.7.1-1.5-.5-1.9C18.4 10 15.3 9 12 9z" />
    </svg>
  ),
  play: (
    <svg className="ph-call-ico" viewBox="0 0 24 24" aria-hidden="true">
      <path fill="currentColor" d="M8 5.5v13l11-6.5z" />
    </svg>
  ),
};

function Wave({ mode }: { mode: WaveMode }) {
  return (
    <span className="ph-call-wave" data-mode={mode} aria-hidden="true">
      <i /><i /><i /><i /><i />
    </span>
  );
}
function Clock({ since }: { since?: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return <span className="ph-call-timer">{callClock(since ? now - since : 0)}</span>;
}
function Mute({ call, voice, small }: { call: Call; voice: PhoneVoice; small?: boolean }) {
  const m = call.state.muted;
  return (
    <button type="button" className={`ph-call-round${small ? " small" : ""}`} aria-pressed={m} aria-label={m ? "Unmute" : "Mute"}
      onClick={() => voice.controller.mute(!m)}>
      {m ? Ico.micOff : Ico.mic}
    </button>
  );
}
function End({ voice, small }: { voice: PhoneVoice; small?: boolean }) {
  return (
    <button type="button" className={`ph-call-round hang${small ? " small" : ""}`} aria-label="End call" onClick={() => void voice.controller.end()}>
      {Ico.hang}
    </button>
  );
}
const tone = (call: Call) => (call.line.tone === "warn" ? " warn" : call.state.muted ? " muted" : "");
const agentStyle = (who: PhoneVoiceWho | undefined, id?: string) =>
  ({ "--agent": (id && who?.(id)?.color) || "var(--mint)" }) as CSSProperties;
function Face({ who, id }: { who?: PhoneVoiceWho; id?: string }) {
  const look = id ? who?.(id) : undefined;
  return look ? <Avatar seed={look.seed} color={look.color} size="sm" /> : null;
}

/** Look A: a slim strip above the compose row. Tap it for the call settings. */
export function PhoneCallStrip(props: Base) {
  const call = usePhoneCall(props);
  if (!call.live || call.look !== "bar") return null;
  const id = call.state.scope?.participantId;
  return (
    <div className={`ph-call-strip${tone(call)}`} role="region" aria-label="Voice call" style={agentStyle(props.who, id)}>
      <button type="button" className="ph-call-strip-tap" aria-label={`${call.name} · ${call.line.status}. Call settings`} onClick={() => setOpen("settings")}>
        {call.line.tone === "warn" && <i className="ph-call-live" />}
        <Face who={props.who} id={id} />
        <span className="ph-call-who">{call.name}</span>
        <span className="ph-call-status" role="status">{call.line.status}</span>
      </button>
      <Wave mode={call.line.wave} />
      <Clock since={call.state.startedAt} />
      <Mute call={call} voice={props.voice} />
      <End voice={props.voice} />
    </div>
  );
}

/** Look C: a capsule under the thread title, in place of the project line. */
export function PhoneCallCapsule(props: Base) {
  const call = usePhoneCall(props);
  if (!call.live || call.look !== "capsule") return null;
  return (
    <span className={`ph-call-capsule${tone(call)}`} role="region" aria-label="Voice call" style={agentStyle(props.who, call.state.scope?.participantId)}>
      <span className="ph-call-capsule-tap" role="button" tabIndex={0} aria-label={`${call.name} · ${call.line.status}. Call settings`}
        onClick={(e) => { e.stopPropagation(); setOpen("settings"); }}
        onKeyDown={(e) => { if (e.key === "Enter") { e.stopPropagation(); setOpen("settings"); } }}>
        <i className="ph-call-live" />
        <Wave mode={call.line.wave} />
        <span className="ph-call-who">{call.name}</span>
        <span className="ph-call-status" role="status">{call.line.status}</span>
        <Clock since={call.state.startedAt} />
      </span>
      <span onClick={(e) => e.stopPropagation()}><End voice={props.voice} small /></span>
    </span>
  );
}

/** Whether a call is running in this thread, and its look: the composer's round button follows it. */
export function usePhoneCallSlot(props: Base): { live: boolean; look: CallLook; hint: string } {
  const call = usePhoneCall(props);
  return { live: call.live, look: call.look, hint: call.line.hint };
}

/**
 * The mic beside Send, which in look B grows into the call pill, plus the call's one sheet.
 * `button: false` keeps only the sheet, while the composer shows Send in the mic's place.
 */
export function VoiceCall(props: Base & {
  machine: string;
  link: ServerVoiceLink;
  canSetUp: boolean;
  disabled: boolean;
  addressed?: string[] | null;
  button?: boolean;
  Sheet: React.ComponentType<SheetProps>;
}) {
  const { voice, hostId, roomId, link, machine, canSetUp, Sheet, who } = props;
  const call = usePhoneCall(props);
  const shown = useSyncExternalStore(subscribeOpen, () => open);
  const [setup, setSetup] = useState<ServerVoiceStatus>();
  const [problem, setProblem] = useState("");
  const { state, live, candidates } = call;
  const addressed = props.addressed?.length === 1 ? candidates.find((c) => c.participantId === props.addressed![0]) : undefined;
  const pick = call.candidate ?? addressed ?? (candidates.length === 1 ? candidates[0] : undefined);
  const view = voiceCallView({ state, agent: pick?.name ?? "", machine, ...voice.view(), setup: live ? undefined : setup, canSetUp });
  const refresh = () => link.status().then(setSetup).catch((e) => setProblem(String(e)));
  useEffect(() => {
    if (shown !== "setup" || !setup?.installing) return;
    const timer = setInterval(() => void refresh(), 1000);
    return () => clearInterval(timer);
  }, [shown, !!setup?.installing, link]);
  useEffect(() => {
    setSetup(undefined);
    setProblem("");
    if (open !== null) setOpen(null);
  }, [hostId, roomId]);
  useEffect(() => {
    if (call.here && state.status === "setup") void refresh().then(() => setOpen("setup"));
  }, [call.here, state.status]);
  // A call already running in another thread on this machine moves here, as saying "call Jigga" would.
  const elsewhere = !call.here && !!state.scope && !LIVE_OFF.includes(state.status);
  const start = async (c: VoiceCandidate) => {
    setProblem("");
    setOpen(null);
    if (elsewhere && state.scope!.hostId === c.hostId) await voice.controller.switchAgent(c);
    else await voice.controller.start(c);
  };
  const tap = async () => {
    if (live) return setOpen("settings");
    const status = await link.status();
    setSetup(status);
    if (!status.installed) return setOpen("setup");
    if (pick && (addressed || candidates.length === 1)) return start(pick);
    setOpen("pick");
  };
  const save = (patch: Partial<ReturnType<PhoneVoice["settingsFor"]>>) => voice.save({ ...voice.settingsFor(hostId), ...patch }, hostId);
  const pref = (c: VoiceCandidate) => preferenceFor(voice.settingsFor(hostId), c.hostId, c.profileId, c.roomId, c.participantId);
  const savePref = (c: VoiceCandidate, patch: { voice?: string; aliases?: string[] }) => {
    const s = voice.settingsFor(hostId);
    const key = voicePreferenceKey(c.hostId, c.profileId, c.roomId, c.participantId);
    save({ preferences: { ...s.preferences, [key]: { ...pref(c), ...patch } } });
  };
  const close = () => setOpen(null);

  const button =
    props.button === false ? null : live && call.look === "pill" ? (
      <span className={`ph-call-pill${tone(call)}`} role="group" aria-label={`Voice call with ${call.name}`} style={agentStyle(who, state.scope?.participantId)}>
        <Mute call={call} voice={voice} small />
        <button type="button" className="ph-call-pill-mid" aria-label={`${call.line.status}. Call settings`} onClick={() => setOpen("settings")}>
          <Wave mode={call.line.wave} />
          <Clock since={state.startedAt} />
        </button>
        <End voice={voice} small />
      </span>
    ) : (
      <button type="button" className={`ph-call-mic${live || shown === "pick" ? " active" : ""}`} aria-label={view.mic.label} disabled={props.disabled}
        onClick={() => void Promise.resolve(tap()).catch((e) => { setProblem(String(e)); setOpen("setup"); })}>
        <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
          <rect x="9" y="2" width="6" height="13" rx="3" />
          <path d="M5 10v2a7 7 0 0014 0v-2M12 19v3m-4 0h8" />
        </svg>
      </button>
    );

  let sheet: ReactNode = null;
  if (shown === "settings" && live && call.candidate) {
    const c = call.candidate;
    const voices = state.voices.length ? state.voices : [DEFAULT_VOICE];
    sheet = (
      <Sheet title={`Call with ${c.name}`} onClose={close}>
        <div className="ph-voice-sheet">
          {problem && <p role="alert">{problem}</p>}
          <p className={`ph-call-sheet-status${tone(call)}`} role="status">{call.line.hint}</p>
          <div className="ph-call-actions">
            <button type="button" aria-pressed={state.muted} onClick={() => voice.controller.mute(!state.muted)}>
              {state.muted ? Ico.micOff : Ico.mic}{state.muted ? "Unmute" : "Mute"}
            </button>
            <button type="button" className="hang" onClick={() => { close(); void voice.controller.end(); }}>{Ico.hang}End call</button>
          </div>
          {(state.candidates?.length ? state.candidates : candidates).length > 1 && (
            <div className="ph-call-set">
              <span>Talking to</span>
              <span className="ph-call-seg">
                {(state.candidates?.length ? state.candidates : candidates).map((x) => (
                  <button type="button" key={JSON.stringify([x.hostId, x.roomId, x.participantId])} aria-pressed={x.participantId === c.participantId && x.hostId === c.hostId}
                    onClick={() => void voice.controller.switchAgent(x).catch((e) => setProblem(String(e)))}>
                    <i className="ph-call-swatch" style={{ "--c": who?.(x.participantId)?.color ?? "var(--muted)" } as CSSProperties} />{x.name}
                  </button>
                ))}
              </span>
            </div>
          )}
          <label className="ph-call-set">
            <span>{c.name}'s voice</span>
            <span className="ph-call-voice">
              <select value={pref(c).voice} onChange={(e) => savePref(c, { voice: e.target.value })}>
                {voices.map((v) => <option key={v} value={v}>{voiceLabel(v)}</option>)}
              </select>
              <button type="button" className="ph-call-round small" aria-label="Preview voice" onClick={() => voice.controller.preview(pref(c).voice)}>{Ico.play}</button>
            </span>
          </label>
          <label className="ph-call-set col">
            <span>Pause before reply · <b>{call.settings.silenceMs} ms</b></span>
            <input type="range" min="100" max="2000" step="1" value={call.settings.silenceMs} onChange={(e) => save({ silenceMs: Number(e.target.value) })} />
          </label>
          <label className="ph-call-set">
            <span>Nicknames</span>
            <input type="text" placeholder="e.g. Nul, Knoll" defaultValue={pref(c).aliases.join(", ")}
              onBlur={(e) => savePref(c, { aliases: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) })} />
          </label>
          <div className="ph-call-set">
            <span>Call controls</span>
            <span className="ph-call-seg">
              {CALL_LOOKS.map((l) => (
                <button type="button" key={l.id} aria-pressed={l.id === call.look} onClick={() => save({ look: l.id })}>{l.label}</button>
              ))}
            </span>
          </div>
          <p className="ph-call-note">Settings follow your Mac · the pause applies to the next call</p>
        </div>
      </Sheet>
    );
  } else if (shown === "pick" && !live) {
    sheet = (
      <Sheet title="Call who?" onClose={close}>
        <div className="ph-voice-sheet">
          {problem && <p role="alert">{problem}</p>}
          {candidates.map((c) => (
            <button type="button" className="ph-plain ph-call-pick" key={c.participantId} style={agentStyle(who, c.participantId)} onClick={() => void start(c)}>
              <Face who={who} id={c.participantId} />
              <b>{c.name}</b>
            </button>
          ))}
          <p className="ph-call-note">During a call, say “call {candidates[1]?.name ?? candidates[0]?.name ?? "Null"}” to switch.</p>
        </div>
      </Sheet>
    );
  } else if (shown === "setup" || (shown !== null && !live && (state.status === "error" || problem))) {
    sheet = (
      <Sheet title={view.setup?.title ?? (state.status === "error" ? "Call ended" : "Voice call")} onClose={close}>
        <div className="ph-voice-sheet">
          {problem && <p role="alert">{problem}</p>}
          {view.setup ? (
            <>
              <p>{view.setup.body}</p>
              {view.setup.progress && <p role="status">{view.setup.progress}</p>}
              {view.setup.note && <p>{view.setup.note}</p>}
              {view.setup.button && (
                <button type="button" className="ph-call-wide" onClick={() => void link.install().then(refresh).catch((e) => setProblem(String(e)))}>{view.setup.button}</button>
              )}
              {setup?.installing && canSetUp && (
                <button type="button" className="ph-call-wide" onClick={() => void link.cancelInstall().then(refresh)}>Cancel setup</button>
              )}
              {setup && !setup.installing && !setup.installed && (
                <button type="button" className="ph-plain ph-call-wide" onClick={() => void refresh()}>Check again</button>
              )}
            </>
          ) : state.status === "error" && call.here ? (
            <>
              <p role="status">{state.error ?? "The call stopped."}</p>
              {pick && <button type="button" className="ph-call-wide" onClick={() => void start(pick)}>Call again</button>}
            </>
          ) : setup?.installed && pick ? (
            <button type="button" className="ph-call-wide" onClick={() => void start(pick)}>Call {pick.name}</button>
          ) : null}
        </div>
      </Sheet>
    );
  }

  return (
    <>
      {button}
      {sheet && createPortal(sheet, document.querySelector(".ph-app") ?? document.body)}
    </>
  );
}

/** A call running in another thread: tap to go back to it. */
export function PhoneCallBar({ voice, onOpen, hidden = false }: { voice: PhoneVoice; hidden?: boolean; onOpen(hostId: string, roomId: string): void }) {
  const [, redraw] = useState(0);
  useEffect(() => voice.subscribe(() => redraw((n) => n + 1)), [voice]);
  const state = voice.controller.getState(),
    s = state.scope;
  if (hidden || !s || LIVE_OFF.includes(state.status)) return null;
  const agent = voice.candidates(s.hostId, s.roomId).find((c) => c.participantId === s.participantId)?.name ?? s.participantId;
  return (
    <button type="button" className="ph-call-bar" onClick={() => onOpen(s.hostId, s.roomId)}>
      On call with {agent}
      {voice.view().attention ? " · needs you" : ""}
    </button>
  );
}
