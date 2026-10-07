// What waits on the person above the composer, kept once for the whole app.
//
// Two kinds: a question a bot asked mid-task (its turn is paused until the
// person answers or skips it) and the next steps suggested after a reply.
// Questions come first, oldest first. Every chat's events feed this store
// (see hub.ts), like the approval cards in approvals.ts.

import type { Signal } from "./attention";
import type { NextStep, Question, RoomEvent, RoomState } from "./types";

export interface OpenQuestion { id: string; request: string; questions: Question[]; at?: number }
export interface Offer { by: string; steps: NextStep[]; pending: boolean }
export interface ThreadAsks { questions: OpenQuestion[]; offer: Offer | null }
export type QuestionState = Readonly<Record<string, ThreadAsks>>;

export type FormView =
  | { kind: "none" }
  | { kind: "pending"; by: string }
  | { kind: "steps"; offer: Offer }
  | { kind: "question"; ask: OpenQuestion; position: number; of: number };

const EMPTY: ThreadAsks = { questions: [], offer: null };

function put(state: QuestionState, room: string, asks: ThreadAsks): QuestionState {
  const { [room]: _old, ...rest } = state;
  return asks.questions.length || asks.offer ? { ...rest, [room]: asks } : rest;
}

/** The store after one room event. Others change nothing. */
export function applyQuestionEvent(state: QuestionState, room: string, event: RoomEvent, now: number): QuestionState {
  const asks = state[room] ?? EMPTY;
  switch (event.type) {
    case "question_requested":
      if (asks.questions.some((q) => q.request === event.request)) return state;
      return put(state, room, { questions: [...asks.questions, { id: event.id, request: event.request, questions: event.questions, at: now }], offer: null });
    case "question_resolved":
      return asks.questions.some((q) => q.request === event.request) ? put(state, room, { ...asks, questions: asks.questions.filter((q) => q.request !== event.request) }) : state;
    case "next_steps":
      return put(state, room, { ...asks, offer: event.pending || event.steps.length ? { by: event.id, steps: event.steps, pending: event.pending } : null });
    case "turn_started":
      return asks.offer ? put(state, room, { ...asks, offer: null }) : state;
    case "message_added":
      return event.message.speaker.kind === "human" && asks.offer ? put(state, room, { ...asks, offer: null }) : state;
    case "participant_idle":
      return asks.questions.some((q) => q.id === event.id) ? put(state, room, { ...asks, questions: asks.questions.filter((q) => q.id !== event.id) }) : state;
    case "stopped":
      return state[room] ? put(state, room, EMPTY) : state;
    default:
      return state;
  }
}

/** Replace a thread's entry from `room_state`, as on open or reconnect. */
export function restoreQuestions(state: QuestionState, room: string, live: Pick<RoomState, "questions" | "next_steps">, now: number): QuestionState {
  const offer = live.next_steps ? { by: live.next_steps.id, steps: live.next_steps.steps, pending: live.next_steps.pending } : null;
  return put(state, room, { questions: (live.questions ?? []).map((q) => ({ ...q, at: now })), offer });
}

/** What the form above the composer shows. */
export function formView(asks: ThreadAsks | undefined): FormView {
  if (!asks) return { kind: "none" };
  const [first] = asks.questions;
  if (first) return { kind: "question", ask: first, position: 1, of: asks.questions.length };
  if (asks.offer?.pending) return { kind: "pending", by: asks.offer.by };
  if (asks.offer?.steps.length) return { kind: "steps", offer: asks.offer };
  return { kind: "none" };
}

export type FormAct =
  | { act: "none" } | { act: "pick"; index: number } | { act: "move"; index: number }
  | { act: "dismiss" } | { act: "collapse" } | { act: "fill"; index: number };

function count(view: FormView): number {
  if (view.kind === "steps") return view.offer.steps.length;
  if (view.kind === "question") return view.ask.questions[0]?.options.length ?? 0;
  return 0;
}

/** What a key in the composer does to the form. Picking keys only work while the composer is empty. */
export function formKey(key: string, composerEmpty: boolean, view: FormView, highlighted: number): FormAct {
  if (view.kind === "none" || view.kind === "pending") return { act: "none" };
  if (key === "Escape") return view.kind === "question" ? { act: "collapse" } : { act: "dismiss" };
  if (!composerEmpty) return { act: "none" };
  const n = count(view);
  if (/^[1-9]$/.test(key)) { const index = Number(key) - 1; return index < n ? { act: "pick", index } : { act: "none" }; }
  if (key === "ArrowDown" && n) return { act: "move", index: Math.min(highlighted + 1, n - 1) };
  if (key === "ArrowUp" && highlighted > 0) return { act: "move", index: highlighted - 1 };
  if (key === "Enter" && n) return { act: "pick", index: highlighted };
  if (key === "Tab" && view.kind === "steps") return { act: "fill", index: 0 };
  return { act: "none" };
}

/** An answer as a short line: picks joined by ", ", questions by " · ". */
export function answerText(answers: string[][]): string {
  return answers.map((picked) => picked.join(", ")).join(" · ");
}

/** A thread's open question as a needs-you flag. Next steps never raise one. */
export function questionSignal(asks: ThreadAsks | undefined, names: ReadonlyMap<string, string>): Signal | null {
  const first = asks?.questions[0];
  if (!first) return null;
  return { kind: "needs_input", note: `${names.get(first.id) ?? first.id} asks: ${first.questions[0]?.question ?? "a question"}`, at: first.at ?? Date.now(), blocking: true };
}

let state: QuestionState = {};
const listeners = new Set<() => void>();
function publish(next: QuestionState) { if (next !== state) { state = next; listeners.forEach((l) => l()); } }

/** Feed one room event to the store. hub.ts calls this for every event. */
export function recordQuestion(room: string, event: RoomEvent): void { publish(applyQuestionEvent(state, room, event, Date.now())); }
export function restoreRoomQuestions(room: string, live: Pick<RoomState, "questions" | "next_steps">): void { publish(restoreQuestions(state, room, live, Date.now())); }
/** Take down a thread's questions and next steps, as when its pane goes away or the person dismisses them. */
export function forgetQuestions(room: string): void { if (state[room]) publish(put(state, room, EMPTY)); }
/** Take down only the next steps, keeping any question. */
export function dismissSteps(room: string): void { const asks = state[room]; if (asks?.offer) publish(put(state, room, { ...asks, offer: null })); }
export function subscribeQuestions(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function questionSnapshot(): QuestionState { return state; }
