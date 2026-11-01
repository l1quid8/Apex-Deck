import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { assistantIdentityKey, type AssistantRef } from "./assistantIdentity";
import { assistantCallCandidate, assistantFloatState, validFloatAction } from "./assistantFloat";
import { assistantComposerDraftFor, setAssistantComposerField } from "./assistantComposerDrafts";
import type { PersonalLane } from "./personalAssistant";
import type { AppearanceSettings, AppearanceValues } from "./themes";
import { voiceController } from "./voice/coordinator";

export type AssistantFloatHandle = { token: string; ref: AssistantRef };

/** Runs in the Deck window, which stays the only owner of the call and the draft:
 *  closing the float, or opening it twice, can't start a second mic or a second send. */
export function useAssistantFloat({ float, setFloat, lane, appearance, onDetails }: {
  float: AssistantFloatHandle | null;
  setFloat(next: AssistantFloatHandle | null): void;
  lane: PersonalLane | null;
  appearance: AppearanceValues | AppearanceSettings;
  onDetails(ref: AssistantRef): void;
}) {
  const bridge = window.apexDeck?.popout;
  const voice = useSyncExternalStore(voiceController.subscribe, voiceController.getState);
  const [error, setError] = useState("");
  const [alwaysOnTop, setAlwaysOnTop] = useState(false);
  const key = float ? (lane?.draftKey ?? assistantIdentityKey(float.ref)) : undefined;
  const draftOf = () => (assistantComposerDraftFor(key)?.fields.get("text") as string | undefined) ?? "";
  const [draft, setDraft] = useState("");
  useEffect(() => {
    const record = assistantComposerDraftFor(key);
    if (!record) return;
    const update = () => setDraft(draftOf());
    const listeners = record.listeners.get("text") ?? new Set();
    record.listeners.set("text", listeners); listeners.add(update); update();
    return () => { listeners.delete(update); };
  }, [key]);

  const state = float && lane ? assistantFloatState({ lane, ref: float.ref, draft, error, alwaysOnTop, voice }) : null;
  const sent = useRef("");
  useEffect(() => {
    if (!float || !state || !bridge) return;
    const patch = JSON.stringify({ float: state, appearance });
    if (patch === sent.current) return;
    sent.current = patch;
    void bridge.update(float.token, { float: state, appearance } as any).catch(() => {});
  });

  const live = useRef({ float, lane, onDetails, setFloat });
  live.current = { float, lane, onDetails, setFloat };
  useEffect(() => {
    if (!bridge) return;
    const offClosed = bridge.onClosed((token) => {
      if (token !== live.current.float?.token) return;
      sent.current = ""; setError(""); setAlwaysOnTop(false); live.current.setFloat(null);
    });
    const offAction = bridge.onAction((token, action: unknown) => {
      const { float, lane } = live.current;
      if (!float || token !== float.token || !lane || !validFloatAction(action)) return;
      const key = lane.draftKey ?? assistantIdentityKey(float.ref);
      const fail = (cause: unknown) => setError(String(cause instanceof Error ? cause.message : cause));
      setError("");
      switch (action.type) {
        case "assistant-draft": setAssistantComposerField(key, "text", action.text); break;
        case "assistant-send":
          if (!lane.sendRequest) { setError("This assistant can't take messages right now."); break; }
          setAssistantComposerField(key, "text", "");
          // The request id is fixed by the float, so a repeat can't reach the host as a new message.
          void lane.sendRequest(action.text, action.requestId).catch((cause) => { setAssistantComposerField(key, "text", action.text); fail(cause); });
          break;
        case "assistant-call": void voiceController.start(assistantCallCandidate(lane, float.ref)); break;
        case "assistant-mute": voiceController.mute(action.muted); break;
        case "assistant-end": void voiceController.end("ended by user"); break;
        case "assistant-new": void lane.newConversation?.().catch(fail); break;
        case "assistant-details": live.current.onDetails(float.ref); break;
        case "assistant-return": void bridge.close(float.token).catch(() => {}); break;
      }
    });
    return () => { offClosed(); offAction(); };
  }, [bridge]);

  const open = useCallback(async (ref: AssistantRef, name: string) => {
    if (!bridge) throw new Error("The floating window needs the Deck app.");
    const { token } = await bridge.open({ kind: "assistant", id: assistantIdentityKey(ref), title: name, hostId: ref.hostId, assistantId: ref.assistantId, appearance } as any);
    setFloat({ token, ref });
  }, [bridge, appearance, setFloat]);
  const pin = useCallback(async (on: boolean) => {
    if (!float || !bridge?.alwaysOnTop) return;
    setAlwaysOnTop(await bridge.alwaysOnTop(float.token, on));
  }, [bridge, float]);
  useEffect(() => { if (float && bridge?.alwaysOnTop) void bridge.alwaysOnTop(float.token).then(setAlwaysOnTop).catch(() => {}); }, [float?.token]);
  return { open, pin };
}
