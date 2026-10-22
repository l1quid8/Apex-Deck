// What the phone's message actions change: quotes waiting in the box, the chat after a Retry or
// Revert, and the lines it says back. The desktop's own rules (reply.ts, messagePins.ts,
// revertConfirm.ts) decide the rest, so both say and send the same thing.

import type { Message } from "../types";
import { pinsBefore } from "../messagePins.ts";
import { replyText, type ReplyQuote } from "../reply.ts";
import type { Mentionable } from "../slug.ts";

/** Add a quote unless the same one is already waiting, as on the desktop. */
export function withQuote(list: readonly ReplyQuote[], next: ReplyQuote): ReplyQuote[] {
  return list.some((q) => q.id === next.id && q.name === next.name && q.text === next.text) ? [...list] : [...list, next];
}

/** The text as it goes out: with quotes, their lead in front and the quotes below, as the desktop sends it. */
export function outgoingText(text: string, quotes: readonly ReplyQuote[], people: readonly Mentionable[]): string {
  return quotes.length ? replyText(text, [...quotes], people) : text.trim();
}

/** What Retry or Revert leaves: the messages before `seq`, and only the pins taken from those. */
export function cutBack<T extends { messages: Message[]; pins: string[] }>(room: T, seq: number): T {
  return { ...room, messages: room.messages.filter((message) => message.seq < seq), pins: pinsBefore(room.pins, seq) };
}

/** Why an action that changes the thread can't run on this phone's level. */
export function needsFull(what: string, machine: string): string {
  return `${what} needs Full access on ${machine}. Change this phone's level in that machine's Settings → Phones.`;
}

/** The line after files went back: "Put back src/a.ts." or "Put back 3 files." */
export function putBackLine(files: readonly string[]): string | null {
  if (files.length === 0) return null;
  return `Put back ${files.length === 1 ? files[0] : `${files.length} files`}.`;
}
