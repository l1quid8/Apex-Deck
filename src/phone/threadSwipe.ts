// Switching between opened threads on the phone by swiping.
//
// The Code tab already swipes between terminals (PhoneTerminal.tsx, with swipeIntent from
// phoneTerminals.ts), so threads use the same detector and feel the same under a thumb. Three
// things are different, and they are the reason this lives in a file of its own:
//
//  - The Mac shows several threads at once and its composer types into whichever pane has focus.
//    One thread fits on a phone, so a swipe is how you pick the thread, and each thread keeps its
//    own unsent text: swiping never moves your typing into another thread.
//  - The strip is the phone's open threads, in the order they were opened (openThreads.ts), not the
//    Threads list. Opening a thread puts it in the strip, ⋯ → Close thread takes it out, and nothing
//    a machine does can reorder it: a reply that starts another thread can't move the one under your
//    thumb.
//  - Some swipes are not ours: the left edge goes back to the thread list, as an edge swipe does in
//    other iPhone apps; sideways-scrolling things (code, tables, the bot row) scroll themselves; and
//    the composer keeps its own.
//
// These are plain functions so they can be tested without a screen.

import { swipeIntent } from "./phoneTerminals.ts";
export { swipeIntent };

/**
 * Where this thread sits among the open ones, for the dots over the title: 3 of 5 is `{ at: 2, of: 5 }`.
 * Null with fewer than two open — one thread has nothing to sit among — and for a thread that isn't in
 * the strip, such as a new one whose text hasn't been sent yet.
 */
export function stripPlace(strip: readonly string[], key: string | null): { at: number; of: number } | null {
  if (!key || strip.length < 2) return null;
  const at = strip.indexOf(key);
  return at < 0 ? null : { at, of: strip.length };
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
 * theirs: the bot row, a wide code block, a table, the next-step line under a reply. `data-no-swipe` marks
 * anything else that wants the gesture.
 */
export const SWIPE_BLOCKERS = "input, textarea, select, pre, table, .ph-crew-row, .ph-next-steps, .reply-next-steps-links, [data-no-swipe]";

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

/**
 * Whether a lost-capture event ends the swipe. On iOS a finger already belongs to whatever it touched,
 * so when the swipe box takes it over, the text underneath loses it — and that event bubbles up to the
 * box. Only the box itself losing the finger means the swipe is over.
 */
export function swipeLostCapture(event: { target: unknown; currentTarget: unknown }): boolean {
  return event.target === event.currentTarget;
}
