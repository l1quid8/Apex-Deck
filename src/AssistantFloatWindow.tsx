// The optional always-on-top assistant window: a compact view of the same
// conversation. It holds no call and no draft of its own; see useAssistantFloat.

import { useEffect, useRef, useState } from "react";

import type { AssistantFloatAction, AssistantFloatState } from "./assistantFloat";
import { Avatar } from "./Avatar";
import { DEFAULT_APPEARANCE, type AppearanceSettings, type AppearanceValues } from "./themes";
import { useAppearance } from "./useAppearance";
import "./assistant-float.css";

export function AssistantFloat({ token }: { token: string }) {
  const bridge = window.apexDeck?.popout;
  const [state, setState] = useState<AssistantFloatState | null>(null);
  const [appearance, setAppearance] = useState<AppearanceValues | AppearanceSettings>(DEFAULT_APPEARANCE);
  const [draft, setDraft] = useState("");
  const box = useRef<HTMLTextAreaElement>(null);
  const log = useRef<HTMLDivElement>(null);
  useAppearance(appearance as any);
  useEffect(() => {
    if (!bridge) return;
    const apply = (patch: { float?: AssistantFloatState; appearance?: AppearanceValues | AppearanceSettings }) => {
      if (patch.appearance) setAppearance(patch.appearance);
      if (!patch.float) return;
      const next = patch.float;
      setState(next);
      // The person's typing wins over an echo; a send clears it.
      if (document.activeElement !== box.current || !next.draft) setDraft(next.draft);
    };
    const off = bridge.onUpdate(apply as any);
    void bridge.snapshot(token).then((snapshot) => apply(snapshot as any)).catch(() => {});
    return off;
  }, [bridge, token]);
  const lineCount = state?.lines.length ?? 0;
  useEffect(() => { log.current?.scrollTo({ top: log.current.scrollHeight }); }, [lineCount]);
  const act = (action: AssistantFloatAction) => { void bridge?.sendAction(token, action as any); };
  const send = () => {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    act({ type: "assistant-send", text, requestId: crypto.randomUUID() });
  };
  if (!state) return <div className="assistant-float" aria-busy="true"><div className="assistant-float-bar"/></div>;
  const look = state.look ?? { seed: state.ref.assistantId, color: "#71e6b5" };
  return <div className="assistant-float">
    <header className="assistant-float-bar">
      <button type="button" className="assistant-float-id" aria-label={`${state.name} details`} title={`${state.name} details`} onClick={() => act({ type: "assistant-details" })}>
        <Avatar seed={look.seed} color={look.color} size="sm"/>
        <span>{state.name}</span>
      </button>
      <span className="assistant-float-grow"/>
      <button type="button" aria-label="New conversation" title="New conversation" onClick={() => act({ type: "assistant-new" })}>＋</button>
      <button type="button" aria-pressed={state.alwaysOnTop} aria-label="Keep on top" title="Keep on top" onClick={() => { void bridge?.alwaysOnTop?.(token, !state.alwaysOnTop).then((on) => setState((s) => s && { ...s, alwaysOnTop: on })); }}>⌃</button>
      <button type="button" aria-label="Return to Deck" title="Return to Deck" onClick={() => act({ type: "assistant-return" })}>⤶</button>
    </header>
    <div className="assistant-float-log" ref={log} role="log" aria-live="polite">
      {state.lines.length === 0 && <p className="assistant-float-empty">Say something to {state.name}.</p>}
      {state.lines.map((line) => <p key={line.id} data-role={line.role}>{line.approval ? "Waiting for your approval in Deck." : line.text}</p>)}
    </div>
    {(state.error || state.offline) && <p className="assistant-float-problem" role="alert">{state.error || `${state.name}'s machine is offline.`}</p>}
    {state.call && <div className="assistant-float-call">
      <span role="status">{state.call.muted ? "Muted" : "Listening"}</span>
      <span className="assistant-float-grow"/>
      <button type="button" aria-pressed={state.call.muted} onClick={() => act({ type: "assistant-mute", muted: !state.call!.muted })}>{state.call.muted ? "Unmute" : "Mute"}</button>
      <button type="button" className="danger" onClick={() => act({ type: "assistant-end" })}>End</button>
    </div>}
    <div className="assistant-float-composer">
      <textarea ref={box} rows={2} aria-label={`Message ${state.name}`} value={draft} placeholder={`Message ${state.name}`}
        onChange={(event) => { setDraft(event.target.value); act({ type: "assistant-draft", text: event.target.value }); }}
        onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); send(); } }}/>
      {!state.call && <button type="button" aria-label={`Call ${state.name}`} title={`Call ${state.name}`} disabled={state.offline} onClick={() => act({ type: "assistant-call" })}>☎</button>}
    </div>
  </div>;
}
