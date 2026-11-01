import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { assistantIdentityKey, assistantAppearance, type AssistantRef } from "./assistantIdentity";
import { assistantCallCandidate, assistantFloatState, validFloatAction, type AssistantFloatContext, type AssistantFloatPresentation } from "./assistantFloat";
import { assistantComposerDraftFor, setAssistantComposerField } from "./assistantComposerDrafts";
import type { Backend } from "./backend";
import { createAssistantAvatarApi } from "./assistantAvatar";
import type { PersonalLane } from "./personalAssistant";
import type { AppearanceSettings, AppearanceValues } from "./themes";
import { voiceController } from "./voice/coordinator";

export type AssistantFloatHandle = { token: string; ref: AssistantRef };

/** Runs in the Deck window, which stays the only owner of the call and the draft:
 *  closing the float, or opening it twice, can't start a second mic or a second send. */
export function useAssistantFloat({ float, setFloat, lane, appearance, onDetails, threadContext, onFollowThreads, onActiveThread, onNewThread, backend }: {
  float: AssistantFloatHandle | null;
  setFloat(next: AssistantFloatHandle | null): void;
  lane: PersonalLane | null;
  appearance: AppearanceValues | AppearanceSettings;
  onDetails(ref: AssistantRef): void;
  threadContext?: AssistantFloatContext;
  onFollowThreads?(ids: string[]): void;
  onActiveThread?(id: string | null): void;
  onNewThread?(): Promise<unknown>;
  backend?: Backend;
}) {
  const bridge = window.apexDeck?.popout;
  const voice = useSyncExternalStore(voiceController.subscribe, voiceController.getState);
  const [error, setError] = useState("");
  const [alwaysOnTop, setAlwaysOnTop] = useState(false);
  const [visible,setVisible]=useState(true);
  const [presentation,setPresentation]=useState<AssistantFloatPresentation>('pill');
  const [creatingThread,setCreatingThread]=useState(false);
  const [avatarImageUrl,setAvatarImageUrl]=useState<string>();
  useEffect(()=>{
    let cancelled=false;setAvatarImageUrl(undefined);
    const image=lane?.assistant?.look?.image,api=backend&&createAssistantAvatarApi(backend);
    if(image&&api&&float&&assistantAppearance(float.ref,lane?.assistant?.look).kind==='image')void api.asset({assistantId:float.ref.assistantId,assetId:image.assetId,sha256:image.sha256}).then(blob=>new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result));reader.onerror=reject;reader.readAsDataURL(blob);})).then(url=>{if(!cancelled)setAvatarImageUrl(url)}).catch(()=>{});
    return()=>{cancelled=true};
  },[backend,float?.ref.hostId,float?.ref.assistantId,lane?.assistant?.look?.image?.sha256,lane?.assistant?.look?.kind]);
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

  const state = float && lane ? {...assistantFloatState({ lane, ref: float.ref, draft, error, alwaysOnTop, voice }),presentation,context:threadContext,avatarImageUrl,creatingThread} : null;
  const sent = useRef("");
  useEffect(() => {
    if (!float || !state || !bridge) return;
    const patch = JSON.stringify({ float: state, appearance });
    if (patch === sent.current) return;
    sent.current = patch;
    void bridge.update(float.token, { float: state, appearance } as any).catch(() => {});
  });

  const live = useRef({ float, lane, onDetails, setFloat, threadContext,onFollowThreads,onActiveThread,onNewThread });
  live.current = { float, lane, onDetails, setFloat,threadContext,onFollowThreads,onActiveThread,onNewThread };
  useEffect(() => {
    if (!bridge) return;
    const offClosed = bridge.onClosed((token) => {
      if (token !== live.current.float?.token) return;
      sent.current = ""; setError(""); setAlwaysOnTop(false);setVisible(false); live.current.setFloat(null);
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
        case "assistant-new":
          if(!live.current.threadContext?.canCreateThread||!live.current.onNewThread){setError("Choose an available project before creating a thread.");break;}
          setCreatingThread(true);void live.current.onNewThread().catch(fail).finally(()=>setCreatingThread(false));break;
        case "assistant-follow": {
          const eligible=new Set(live.current.threadContext?.threads.map(t=>t.id));
          if(action.threadIds.every(id=>eligible.has(id)))live.current.onFollowThreads?.(action.threadIds);
          else setError("That thread is no longer available to this assistant.");break;
        }
        case "assistant-active-thread":
          if(action.threadId===null||live.current.threadContext?.threads.some(t=>t.id===action.threadId))live.current.onActiveThread?.(action.threadId);
          else setError("That thread is no longer available to this assistant.");break;
        case "assistant-present":
          setPresentation(action.presentation);
          void bridge.assistantLayout?.(token,action.presentation);break;
        case "assistant-pin":
          if(bridge.alwaysOnTop)void bridge.alwaysOnTop(token,action.on).then(on=>{if(live.current.float?.token===token)setAlwaysOnTop(on)}).catch(fail);break;
        case "assistant-hide":setVisible(false);void bridge.assistantVisibility?.(token,false);break;
        case "assistant-details": live.current.onDetails(float.ref); break;
        case "assistant-return": void bridge.close(float.token).catch(() => {}); break;
      }
    });
    return () => { offClosed(); offAction(); };
  }, [bridge]);

  const open = useCallback(async (ref: AssistantRef, name: string) => {
    if (!bridge) throw new Error("The floating window needs the Deck app.");
    const nextPresentation:AssistantFloatPresentation='pill';
    const { token } = await bridge.open({ kind: "assistant", id: assistantIdentityKey(ref), title: name, hostId: ref.hostId, assistantId: ref.assistantId, appearance, float:{presentation:nextPresentation} } as any);
    sent.current='';setPresentation(nextPresentation);setVisible(true);setFloat({ token, ref });
    await bridge.assistantLayout?.(token,nextPresentation);await bridge.assistantVisibility?.(token,true);
  }, [bridge, appearance, setFloat]);
  const pin = useCallback(async (on: boolean) => {
    if (!float || !bridge?.alwaysOnTop) return;
    const token=float.token,result=await bridge.alwaysOnTop(token,on);
    if(live.current.float?.token===token)setAlwaysOnTop(result);
  }, [bridge, float]);
  useEffect(() => {
    let cancelled=false;
    if(float&&bridge?.alwaysOnTop)void bridge.alwaysOnTop(float.token).then(on=>{if(!cancelled)setAlwaysOnTop(on)}).catch(()=>{});
    return()=>{cancelled=true};
  }, [bridge,float?.token]);
  return { open, pin, visible:!!float&&visible, presentation };
}
