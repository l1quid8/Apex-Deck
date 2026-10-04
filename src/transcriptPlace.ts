// Keeping your place in a thread's transcript.
//
// The transcript follows new content only while you are at its bottom.
// Scrolled up, it stays where you are and offers pills instead: one to
// jump to the latest reply, one to bring an approval card back into view.
// These rules are plain functions so they can be tested without a browser.

import { joinNames, waitingVerb } from "./composerStatus.ts";

/** How close to the bottom still counts as at the bottom, in pixels. */
export const AT_BOTTOM_PX = 80;

/**
 * Whether a scroller sits at its bottom, or within AT_BOTTOM_PX of it. A
 * transcript that is not laid out (a hidden pane measures all zeros) counts
 * as at the bottom, so it opens at the latest message when it is shown.
 */
export function isAtBottom(scrollTop: number, scrollHeight: number, clientHeight: number): boolean {
  return scrollHeight - scrollTop - clientHeight <= AT_BOTTOM_PX;
}

/** The pill that jumps down: "3 new · Jump to latest". */
export function newPill(count: number): string {
  return `${count} new · Jump to latest`;
}

/** An open approval card's place on screen, in the same coordinates as the view. */
export interface CardBox {
  /** The bot that asked. */
  by: string;
  /** The request id from its `approval_requested` event. */
  request: string;
  top: number;
  bottom: number;
}

/** Cards wholly above or below the visible part of the transcript, oldest first. A card you can see part of is in view. */
export function cardsOutOfView(cards: CardBox[], viewTop: number, viewBottom: number): CardBox[] {
  return cards.filter((card) => card.bottom <= viewTop || card.top >= viewBottom);
}

/** The bots that own `cards`, each once, in order. */
export function owners(cards: CardBox[]): string[] {
  return [...new Set(cards.map((card) => card.by))];
}

/** "Null is waiting for you", "Null and Jigga are waiting for you". */
export function waitingLine(names: string[]): string {
  return `${joinNames(names)} ${waitingVerb(names.length)}`;
}

/** A message as the "New since you looked" divider sees it. */
export interface SeenMessage {
  seq: number;
  /** Your own messages never count as new. */
  bot: boolean;
}

/** Read transcript messages for the divider. */
export function seenList(messages: { seq: number; speaker: { kind: string } }[]): SeenMessage[] {
  return messages.map((m) => ({ seq: m.seq, bot: m.speaker.kind === "bot" }));
}

/**
 * Where "New since you looked" goes: the seq of the first bot message after
 * `lastSeen`, the newest message you saw at the bottom of the thread. Null
 * when nothing is new, and when there is no mark (threads saved before marks
 * existed, or a mark that is not a number). A mark past the newest message
 * means the thread was cleared since (messages count from 0 again), so all
 * of it is new.
 */
export function firstUnseen(messages: SeenMessage[], lastSeen: unknown): number | null {
  if (typeof lastSeen !== "number" || !Number.isFinite(lastSeen)) return null;
  const newest = messages.length > 0 ? messages[messages.length - 1].seq : -1;
  const mark = lastSeen > newest ? -1 : lastSeen;
  return messages.find((m) => m.bot && m.seq > mark)?.seq ?? null;
}

/** How many bot messages are at or after `from`, for the pill when a thread opens at its divider. */
export function unseenCount(messages: SeenMessage[], from: number | null): number {
  return from === null ? 0 : messages.filter((m) => m.bot && m.seq >= from).length;
}

/** The mark to save while you watch the bottom of a thread: the newest message's seq, or null when the saved mark already says so. */
export function seenMark(messages: SeenMessage[], saved: number | undefined): number | null {
  if (messages.length === 0) return null;
  const newest = messages[messages.length - 1].seq;
  return newest === saved ? null : newest;
}
