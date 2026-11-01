// The floating assistant window, as data. Deck's main window owns the call, the
// draft and every send; the float shows this state and asks for changes.

import { assistantAppearance, type AssistantRef } from "./assistantIdentity.ts";
import type { PersonalLane } from "./personalAssistant.ts";

const SHOWN_MESSAGES = 60;
const LIVE_CALL = new Set(["warming", "listening", "hearing", "waiting", "thinking", "speaking"]);

export type AssistantFloatPresentation = 'pill' | 'threads' | 'chat' | 'minimized';
export type AssistantFloatThread = { id: string; title: string; hostId?: string; projectId?: string; projectName?: string; closed?: boolean; status?: string };
export type AssistantFloatContext = { threads: AssistantFloatThread[]; followedThreadIds: string[]; activeThreadId: string | null; canCreateThread: boolean };

/** A native drag can finish without a DOM click. Suppression is one-shot,
 * bounded, reset by the next pointer gesture, and never consumes keyboard input. */
export function createAssistantFloatDragGuard(now = () => performance.now()) {
  let until = 0;
  return {
    pointerDown() { until = 0; },
    dragged() { until = now() + 400; },
    consumeClick(detail = 1) { const discard = detail !== 0 && until > now(); until = 0; return discard; },
  };
}

export type AssistantFloatLine = { id: string; role: string; text: string; approval: boolean };
export type AssistantFloatState = {
  name: string;
  ref: AssistantRef;
  look?: { seed: string; color: string };
  offline: boolean;
  paused: boolean;
  lines: AssistantFloatLine[];
  draft: string;
  error: string;
  call: { muted: boolean; startedAt?: number } | null;
  alwaysOnTop: boolean;
  currentThread?: {id:string;title:string};
  presentation?: AssistantFloatPresentation;
  context?: AssistantFloatContext;
  avatarImageUrl?: string;
  creatingThread?: boolean;
};
export type AssistantFloatAction =
  | { type: "assistant-draft"; text: string }
  | { type: "assistant-send"; text: string; requestId: string }
  | { type: "assistant-call" }
  | { type: "assistant-mute"; muted: boolean }
  | { type: "assistant-end" }
  | { type: "assistant-new" }
  | { type: "assistant-details" }
  | { type: "assistant-return" }
  | { type: "assistant-present"; presentation: AssistantFloatPresentation }
  | { type: "assistant-follow"; threadIds: string[] }
  | { type: "assistant-active-thread"; threadId: string | null }
  | { type: "assistant-hide" }
  | { type: "assistant-pin"; on: boolean };

export const assistantCallRoom = (ref: AssistantRef) => `assistant:${ref.assistantId}`;

/** The call this assistant's Deck window would place: one scope, whichever button asked. */
export function assistantCallCandidate(lane: PersonalLane, ref: AssistantRef) {
  const roomId = assistantCallRoom(ref);
  return { hostId: ref.hostId, roomId, participantId: ref.assistantId, profileId: roomId, name: lane.name, roomTitle: lane.name, agentVoice: lane.assistant?.profile?.voice, aliases: [] };
}

export function assistantFloatLines(lane: PersonalLane): AssistantFloatLine[] {
  const assistant = lane.assistant;
  const from = assistant?.conversationFrom ?? 0;
  return (assistant?.messages ?? [])
    .filter((message) => message.at > from && message.kind !== "notice")
    .slice(-SHOWN_MESSAGES)
    .map(({ id, role, text, kind }) => ({ id, role, text, approval: kind === "approval" }));
}

export function assistantFloatState(input: { lane: PersonalLane; ref: AssistantRef; draft: string; error: string; alwaysOnTop: boolean; voice: { status: string; muted: boolean; startedAt?: number; scope?: { hostId: string; roomId: string } } }): AssistantFloatState {
  const { lane, ref, draft, error, alwaysOnTop, voice } = input;
  const ours = voice.scope?.hostId === ref.hostId && voice.scope?.roomId === assistantCallRoom(ref) && LIVE_CALL.has(voice.status);
  const look=assistantAppearance(ref,lane.assistant?.look);
  return {
    name: lane.name, ref, look: {seed:look.seed,color:look.color},
    offline: lane.offline, paused: !!lane.assistant?.paused, lines: assistantFloatLines(lane), draft, error, alwaysOnTop,
    call: ours ? { muted: voice.muted, startedAt: voice.startedAt } : null,
    ...(lane.currentThread?{currentThread:{id:lane.currentThread.id,title:lane.currentThread.title}}:{}),
  };
}

/** Only this window's own assistant, with the text it was typed with. A float
 *  can't name another assistant, a room or a command. */
export function validFloatAction(action: unknown): action is AssistantFloatAction {
  const a = action as AssistantFloatAction | null;
  if (!a || typeof a !== "object") return false;
  switch (a.type) {
    case "assistant-draft": return typeof a.text === "string" && a.text.length <= 100_000;
    case "assistant-send": return typeof a.text === "string" && !!a.text.trim() && a.text.length <= 100_000 && /^[A-Za-z0-9_:-]{1,128}$/.test(a.requestId);
    case "assistant-mute": return typeof a.muted === "boolean";
    case "assistant-pin": return typeof a.on === "boolean";
    case "assistant-present": return ['pill', 'threads', 'chat', 'minimized'].includes(a.presentation);
    case "assistant-follow": return Array.isArray(a.threadIds) && a.threadIds.length <= 500 && a.threadIds.every(id => typeof id === 'string' && id.length > 0 && id.length <= 1024) && new Set(a.threadIds).size === a.threadIds.length;
    case "assistant-active-thread": return a.threadId === null || (typeof a.threadId === 'string' && a.threadId.length > 0 && a.threadId.length <= 1024);
    case "assistant-hide": return true;
    case "assistant-call": case "assistant-end": case "assistant-new": case "assistant-details": case "assistant-return": return true;
    default: return false;
  }
}
