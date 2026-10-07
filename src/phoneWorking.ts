// What each bot in an open thread is doing right now, on the phone. The Mac
// and servers send turn_started, the reply as it is written (delta), what the
// bot is doing (activity) and the end of the turn; the phone shows each bot's
// turn until its reply lands or the turn ends some other way.

import type { RoomEvent } from "./types";

export interface PhoneTurn {
  startedAt: number;
  phase: "thinking" | "tool" | "writing";
  /** The latest thing it said it was doing, such as reading a file. */
  step: string;
  /** The reply so far. */
  text: string;
}

export type PhoneWorking = Record<string, PhoneTurn>;

const fresh = (now: number): PhoneTurn => ({ startedAt: now, phase: "thinking", step: "", text: "" });

/** Bots already working when the thread was opened. */
export function workingFrom(active: readonly string[], now: number): PhoneWorking {
  return Object.fromEntries(active.map((id) => [id, fresh(now)]));
}

function without(working: PhoneWorking, id: string): PhoneWorking {
  if (!(id in working)) return working;
  const { [id]: _done, ...rest } = working;
  return rest;
}

/** The same object back when the event changes nothing, so React can skip a render. */
export function applyTurnEvent(working: PhoneWorking, event: RoomEvent, now: number): PhoneWorking {
  switch (event.type) {
    case "turn_started":
      return { ...working, [event.id]: fresh(now) };
    case "delta": {
      const turn = working[event.id] ?? fresh(now);
      return { ...working, [event.id]: { ...turn, phase: "writing", text: turn.text + event.text } };
    }
    case "activity": {
      const turn = working[event.id] ?? fresh(now);
      return { ...working, [event.id]: { ...turn, phase: "tool", step: event.text } };
    }
    case "message_added":
      return event.message.speaker.kind === "bot" ? without(working, event.message.speaker.id) : working;
    case "participant_idle":
    case "passed":
    case "failed":
    case "compacted":
      return without(working, event.id);
    case "stopped":
    case "idle":
      return Object.keys(working).length === 0 ? working : {};
    default:
      return working;
  }
}

/** "Thinking", "Writing", or the step it named. A step waiting on an approval reads as waiting. */
export function turnWords(turn: PhoneTurn, asking: boolean, planning: boolean): string {
  if (asking) return "Waiting for you";
  if (turn.phase === "tool" && turn.step && !turn.step.startsWith("Waiting for approval: ")) return turn.step;
  if (planning && turn.phase !== "writing") return "Planning";
  return turn.phase === "writing" ? "Writing" : turn.phase === "tool" ? "Working" : "Thinking";
}

/** The line left behind when the machine dropped mid-turn. */
export function cutLine(names: readonly string[], machine: string): string {
  const who = names.length === 0 ? "" : names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `Lost ${machine} while ${who} ${names.length === 1 ? "was" : "were"} working. The reply shows here once ${machine} is back.`;
}

/** Which bots are working in a thread, for the thread list. Only starts and
 *  endings change it, so a reply streaming in doesn't redraw the list. */
export function busyAfter(ids: readonly string[], event: RoomEvent): readonly string[] {
  switch (event.type) {
    case "turn_started":
    case "delta":
    case "activity":
      return ids.includes(event.id) ? ids : [...ids, event.id];
    case "message_added": {
      const speaker = event.message.speaker;
      return speaker.kind === "bot" && ids.includes(speaker.id) ? ids.filter((id) => id !== speaker.id) : ids;
    }
    case "participant_idle":
    case "passed":
    case "failed":
    case "compacted":
      return ids.includes(event.id) ? ids.filter((id) => id !== event.id) : ids;
    case "stopped":
    case "idle":
      return ids.length === 0 ? ids : [];
    default:
      return ids;
  }
}

/** What a bot had written when its machine dropped. `after` is the last message
 *  before the cut, so its finished reply can be told apart from older ones. */
export interface PhoneCut { text: string; after: number; ended?: boolean }
export type PhoneCuts = Record<string, PhoneCut>;

/** Marks the text the phone missed while the machine was out of reach. */
export const CUT_GAP = "\n\n…\n\n";

/** The machine dropped: every working bot is cut off, keeping what it had written. */
export function cutOff(cut: PhoneCuts, working: PhoneWorking, after: number): PhoneCuts {
  const next = { ...cut };
  for (const [id, turn] of Object.entries(working)) {
    const earlier = cut[id];
    if (!earlier) next[id] = { text: turn.text, after };
    // A second drop during the same turn keeps what was cut the first time, with
    // anything written since after it, and still waits on that turn's reply.
    else if (!turn.text) next[id] = { ...earlier, ended: false };
    else if (!earlier.ended) next[id] = { text: earlier.text ? earlier.text + CUT_GAP + turn.text : turn.text, after: earlier.after };
    else next[id] = { text: turn.text, after };
  }
  return next;
}

type Said = { seq: number; speaker: { kind: string; id?: string } };
const replied = (transcript: readonly Said[], id: string, after: number) =>
  transcript.some((message) => message.seq > after && message.speaker.kind === "bot" && message.speaker.id === id);

/** The machine is back and the thread reloaded. A cut reply stays until that
 *  bot's reply lands; a bot still working keeps it above its live turn; a bot
 *  that ended without a reply keeps it, marked as ended. */
export function resumeCut(cut: PhoneCuts, active: readonly string[], transcript: readonly Said[]): PhoneCuts {
  const next: PhoneCuts = {};
  for (const [id, part] of Object.entries(cut)) {
    if (replied(transcript, id, part.after)) continue;
    next[id] = { ...part, ended: !active.includes(id) };
  }
  return next;
}

/** The same object back when the event changes nothing. */
export function applyCutEvent(cut: PhoneCuts, event: RoomEvent): PhoneCuts {
  const ids = Object.keys(cut);
  if (ids.length === 0) return cut;
  const end = (which: readonly string[]) => {
    const open = which.filter((id) => cut[id] && !cut[id].ended);
    return open.length === 0 ? cut : { ...cut, ...Object.fromEntries(open.map((id) => [id, { ...cut[id], ended: true }])) };
  };
  switch (event.type) {
    case "message_added": {
      const speaker = event.message.speaker;
      if (speaker.kind !== "bot" || !(speaker.id in cut)) return cut;
      const { [speaker.id]: _landed, ...rest } = cut;
      return rest;
    }
    case "participant_idle":
    case "passed":
    case "failed":
    case "compacted":
      return end([event.id]);
    case "stopped":
    case "idle":
      return end(ids);
    default:
      return cut;
  }
}

/** The line under a reply whose bot stopped before finishing it. */
export function endedLine(names: readonly string[]): string {
  const who = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `${who} stopped before finishing ${names.length === 1 ? "this reply" : "these replies"}.`;
}
