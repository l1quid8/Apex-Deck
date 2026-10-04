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
