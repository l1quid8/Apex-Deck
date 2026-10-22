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

/** A message back in the box brings its quotes with their Send to, ahead of any quoted since, as its text comes back ahead of what was typed since. */
export function quotesBack(now: readonly ReplyQuote[], back: readonly ReplyQuote[]): ReplyQuote[] {
  return [...back, ...now.filter((q) => !back.some((b) => b.id === q.id && b.name === q.name && b.text === q.text))];
}

/**
 * Where Add to chat / More details go for text picked on the phone, measured from the phone frame.
 * iPhone puts its own Copy menu on the side of the text with more room: under text in the top half of
 * the screen, over text in the bottom half. These take the other side, so the two never cover each other.
 * In the iPhone app the frame fills the screen, as iPhone measures it; in Safari, whose bars shorten the
 * page, the two can still meet over text a line or two above the middle.
 * Centred on the text, `half` their width inside the frame's edges, at the chat's edge when the text runs
 * past it; none while the text is scrolled out of the chat.
 */
export function selectionSpot(
  text: { left: number; width: number; top: number; bottom: number },
  chat: { top: number; bottom: number },
  frame: { left: number; top: number; right: number; bottom: number },
  half: number,
): { x: number; y: number; side: "above" | "below" } | null {
  if (text.bottom <= chat.top || text.top >= chat.bottom) return null;
  const x = Math.min(Math.max(text.left + text.width / 2, frame.left + half + 8), frame.right - half - 8) - frame.left;
  return text.top + text.bottom < frame.top + frame.bottom
    ? { x, y: Math.max(text.top, chat.top) - frame.top, side: "above" }
    : { x, y: Math.min(text.bottom, chat.bottom) - frame.top, side: "below" };
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
