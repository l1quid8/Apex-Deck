// Switching between opened threads on the phone by swiping.
//
// The Code tab already swipes between terminals (PhoneTerminal.tsx, with swipeIntent from
// phoneTerminals.ts), so threads use the same detector and feel the same under a thumb. Three
// things are different, and they are the reason this lives in a file of its own:
//
//  - The Mac shows several threads at once and its composer types into whichever pane has focus.
//    One thread fits on a phone, so a swipe is how you pick the thread, and each thread keeps its
//    own unsent text: swiping never moves your typing into another thread.
//  - The order is the Threads list's own order, and it is held still while a thread is open, so a
//    reply arriving can't shuffle the threads under your thumb mid-swipe.
//  - Some swipes are not ours: the left edge goes back to the thread list, as an edge swipe does in
//    other iPhone apps; sideways-scrolling things (code, tables, the bot row) scroll themselves; and
//    the composer keeps its own.
//
// These are plain functions so they can be tested without a screen.

import { swipeIntent } from "./phoneTerminals.ts";
export { swipeIntent };

/** What the strip needs of a thread: the list decides which panes are threads. */
export interface SwipePane {
  id: string;
  kind?: string;
  archived?: boolean;
}

/**
 * The threads a swipe moves through, in the order the Threads list shows them: Pinned first, then
 * each machine's projects, then the Work threads made from chats. Only threads are in it — never a
 * terminal, an assistant, or an archived thread, which the list keeps at the bottom and without an
 * open row. `keyOf` names a thread (machine plus id), because two machines can both have a thread
 * called the same thing.
 */
export function swipeStrip(lists: readonly (readonly SwipePane[])[], keyOf: (pane: SwipePane) => string): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const list of lists) {
    for (const pane of list) {
      if (pane.kind !== "chat" || pane.archived) continue;
      const key = keyOf(pane);
      if (seen.has(key)) continue;
      seen.add(key);
      keys.push(key);
    }
  }
  return keys;
}

/**
 * The strip while a thread is open. Its order stays put: a thread that appears (a reply starting
 * another thread, a thread made on the Mac) waits for the next time one is opened, so the row you
 * were about to swipe to is still the row you get. Threads that are gone — deleted, archived — do
 * leave, so a swipe never lands on a thread that isn't there any more.
 */
export function heldStrip(held: readonly string[], next: readonly string[], open: string | null): string[] {
  if (open === null || !held.includes(open)) return [...next];
  const live = new Set(next);
  return held.filter((key) => live.has(key));
}

/** What the screen remembers between renders: the thread it was open on, and the strip it held then. */
export interface StripHold {
  open: string | null;
  keys: string[];
}

/**
 * The strip to swipe through this time. Opening a thread — from the list, from a search, from a
 * notification — takes the order as it is at that moment; staying in it holds the order it had,
 * so the thread beside this one doesn't change while you are reading.
 */
export function holdStrip(held: StripHold | null, next: readonly string[], open: string | null): StripHold {
  if (held === null || held.open !== open) return { open, keys: [...next] };
  return { open, keys: heldStrip(held.keys, next, open) };
}

/** Where this thread sits, as "3 of 9"; empty when there is nothing to count or it isn't in the strip. */
export function stripPosition(strip: readonly string[], key: string | null): string {
  if (!key || strip.length < 2) return "";
  const at = strip.indexOf(key);
  return at < 0 ? "" : `${at + 1} of ${strip.length}`;
}

/**
 * The thread a swipe opens, or null at the end of the strip. A thread that isn't in the strip — a
 * new thread whose text hasn't been sent yet — opens the first one either way, since there is no
 * neighbour to work out from it.
 */
export function neighbour(strip: readonly string[], key: string | null, to: "next" | "previous"): string | null {
  if (strip.length === 0) return null;
  const at = key === null ? -1 : strip.indexOf(key);
  if (at < 0) return strip[0];
  const index = at + (to === "next" ? 1 : -1);
  return index >= 0 && index < strip.length ? strip[index] : null;
}

/**
 * Things that scroll sideways, and the box you type in. A swipe that starts on one of these is
 * theirs: the bot row, a wide code block, a table, the next-step chips. `data-no-swipe` marks
 * anything else that wants the gesture.
 */
export const SWIPE_BLOCKERS = "input, textarea, select, pre, table, .ph-crew-row, .ph-next-steps, [data-no-swipe]";

/** True when the swipe started on something that keeps its own sideways gesture. */
export function swipeBlocked(target: { closest?(selectors: string): unknown } | null | undefined): boolean {
  return Boolean(target && typeof target.closest === "function" && target.closest(SWIPE_BLOCKERS));
}

/** How wide the band is at the left edge that belongs to iOS's own back gesture. */
export const EDGE_GUARD = 20;

/** True for a swipe that started where iOS expects to go back to the thread list. */
export function edgeSwipe(x: number): boolean {
  return x < EDGE_GUARD;
}

/** A flick counts from here, in pixels per millisecond — about 500 px/s. */
export const FLICK = 0.5;

/** How far of the width a slow drag has to reach before it switches threads. */
export const REACH = 0.25;

export interface SwipeRelease {
  dx: number;
  dy: number;
  /** The width of the thread on screen: the reach is a quarter of it. */
  width: number;
  /** How long the drag took, so a quick flick counts even when it is short. */
  ms: number;
}

/**
 * What letting go does: switch to the next thread (a left swipe), the previous one, or spring back.
 * A slow drag has to pass a quarter of the screen; a flick switches however far it went, as long as
 * it was sideways at all.
 */
export function swipeRelease({ dx, dy, width, ms }: SwipeRelease): "next" | "previous" | "back" {
  const way = swipeIntent(dx, dy);
  if (way === null) return "back";
  const flicked = ms > 0 && Math.abs(dx) / ms >= FLICK;
  if (!flicked && Math.abs(dx) < width * REACH) return "back";
  return way === "left" ? "next" : "previous";
}

/**
 * A thread's replies are drawn only under that thread's own title: id and machine both, so a
 * same-id thread on another machine never has its messages shown here. Swiping fast can leave the
 * room from the last thread in hand for a frame; this is what stops it reaching the screen.
 */
export function roomFits(room: { id: string; hostId: string } | null, paneId: string | null, hostId: string): boolean {
  return Boolean(room && paneId && room.id === paneId && room.hostId === hostId);
}
