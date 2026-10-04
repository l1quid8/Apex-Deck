// The identicon battery: an agent's avatar doubles as a gauge. The pattern
// is mirrored, so each half carries the whole identity. The left two
// columns show how much context window is left, the right two how much of
// the provider plan is left, and the middle column the lower of the two.
// Each side drains from the top.

import type { IdenticonCell } from "./identicon";
import type { PlanWindow, TokenTotals } from "./types";

/** At or under this much left, a side reads low: the shell gets a hairline outline. */
export const LOW = 0.2;
/** At or under this much left, the outline thickens and the avatar says "low". */
export const CRITICAL = 0.08;
/** Lit cells above the level stay faintly visible so the agent is recognisable. */
export const GHOST = 0.16;
/** Unlit cells below the level are tinted so the level reads on sparse patterns. */
export const TINT = 0.1;
/** Unlit cells above the level. */
export const BLANK = 0.04;
/** A partly filled lit cell is drawn between these. */
const PARTIAL_MIN = 0.3;
/** Delay between rows when a side refills, bottom row first. */
export const REFILL_STAGGER_MS = 140;

export type Side = "context" | "plan" | "both";

export interface BatteryCell extends IdenticonCell {
  side: Side;
  /** How much of this cell's row is below the level, 0 to 1. */
  fill: number;
  /** How strongly the cell is drawn, 0 to 1. Always in the agent's colour. */
  alpha: number;
}

/** Levels are 0 to 1. `null` means unknown, which is drawn full. */
export interface Levels {
  context: number | null;
  plan: number | null;
}

const clamp = (n: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, n));

/** Whole percent left, as shown in numbers. */
export function percent(level: number): number {
  return Math.round(clamp(level) * 100);
}

export function isLow(level: number | null): boolean {
  return level !== null && percent(level) <= LOW * 100;
}

export function isCritical(level: number | null): boolean {
  return level !== null && percent(level) <= CRITICAL * 100;
}

/** Context left, from the tokens the latest request used. */
export function contextLevel(use: { used: number; window: number } | undefined): number | null {
  if (!use || !(use.window > 0)) return null;
  return clamp(1 - use.used / use.window);
}

/** Windows that have not started over yet. Once a window resets, its old
 *  figure says nothing, so it counts as unknown until reported again. */
export function liveWindows(windows: PlanWindow[], nowSeconds: number): PlanWindow[] {
  return windows.filter((w) => w.resets_at == null || w.resets_at > nowSeconds);
}

/** The window closest to its limit: the one that binds. */
export function bindingWindow(windows: PlanWindow[], nowSeconds: number): PlanWindow | null {
  return liveWindows(windows, nowSeconds).reduce<PlanWindow | null>((worst, w) => (!worst || w.used_percent > worst.used_percent ? w : worst), null);
}

/** Plan left: 100 minus the highest used percent across the windows. */
export function planLevel(windows: PlanWindow[] | undefined, nowSeconds: number): number | null {
  const binding = windows ? bindingWindow(windows, nowSeconds) : null;
  return binding ? clamp(1 - binding.used_percent / 100) : null;
}

function sideOf(col: number): Side {
  if (col < 2) return "context";
  if (col > 2) return "plan";
  return "both";
}

/** How much of row `row` (0 is the top) is below `level`. */
export function rowFill(level: number, row: number): number {
  const fromBottom = 4 - row;
  return clamp(level * 5 - fromBottom);
}

/** The cells of `cells` drawn as a battery at `levels`. */
export function batteryCells(cells: IdenticonCell[], levels: Levels): BatteryCell[] {
  const context = levels.context ?? 1;
  const plan = levels.plan ?? 1;
  const middle = Math.min(context, plan);
  return cells.map((cell, i) => {
    const row = Math.floor(i / 5);
    const side = sideOf(i % 5);
    const level = side === "context" ? context : side === "plan" ? plan : middle;
    const fill = rowFill(level, row);
    let alpha: number;
    if (cell.on) alpha = fill >= 1 ? 1 : fill > 0 ? PARTIAL_MIN + (1 - PARTIAL_MIN) * fill : GHOST;
    else alpha = fill > 0 ? TINT : BLANK;
    return { ...cell, side, fill, alpha };
  });
}

/** What the shell shows: a hairline outline when either side is low, a
 *  thicker outline and the word "low" when critical. Low is not a failure,
 *  so it never uses the danger colour. */
export function shellState(levels: Levels): "ok" | "low" | "critical" {
  const lowest = Math.min(levels.context ?? 1, levels.plan ?? 1);
  if (isCritical(lowest)) return "critical";
  if (isLow(lowest)) return "low";
  return "ok";
}

/** A row's place in a refill, bottom row first. */
export function refillDelay(row: number): number {
  return (4 - row) * REFILL_STAGGER_MS;
}

/** A token count short enough for a card: 950, 1.8k, 23k, 1.2M. */
export function shortCount(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** "18% left · 36k of 200k tokens" */
export function contextLine(use: { used: number; window: number }): string {
  const level = contextLevel(use) ?? 0;
  return `${percent(level)}% left · ${shortCount(Math.max(0, use.window - use.used))} of ${shortCount(use.window)} tokens`;
}

/** The usage card's token sentence for one bot. The totals are saved with the thread. */
export function tokenLine(use: TokenTotals | undefined): string {
  if (!use || use.turns === 0) return "No tokens used in this thread yet.";
  const turns = use.turns === 1 ? "1 turn" : `${use.turns} turns`;
  return `${use.input.toLocaleString()} in, ${use.output.toLocaleString()} out over ${turns} in this thread. Input includes the conversation and files the tool re-read from its cache.`;
}

/** What a plan window is called: "5-hour", "weekly". */
export function windowLabel(w: PlanWindow): string {
  const minutes = w.window_minutes;
  if (minutes === 10_080) return "weekly";
  if (minutes != null && minutes > 0) {
    if (minutes % 1440 === 0) return `${minutes / 1440}-day`;
    if (minutes % 60 === 0) return `${minutes / 60}-hour`;
    return `${minutes}-minute`;
  }
  return w.name.replace(/_/g, " ");
}

/** When a window starts over: "3:00 PM" today, "Tue 3:00 PM" later. */
export function resetLabel(resetsAt: number, now: Date): string {
  const at = new Date(resetsAt * 1000);
  const time = at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const sameDay = at.toDateString() === now.toDateString();
  return sameDay ? time : `${at.toLocaleDateString([], { weekday: "short" })} ${time}`;
}

/** Short countdown to a reset: "2h14m", "3d4h", "12m". */
export function countdown(resetsAt: number, nowSeconds: number): string {
  const m = Math.max(0, Math.round((resetsAt - nowSeconds) / 60));
  if (m >= 1440) return `${Math.floor(m / 1440)}d${Math.floor((m % 1440) / 60)}h`;
  if (m >= 60) return `${Math.floor(m / 60)}h${m % 60}m`;
  return `${m}m`;
}

/** "64% left · resets 3:00 PM · weekly 81%" */
export function planLine(windows: PlanWindow[], now: Date): string | null {
  const nowSeconds = now.getTime() / 1000;
  const binding = bindingWindow(windows, nowSeconds);
  if (!binding) return null;
  const parts = [`${100 - Math.min(100, binding.used_percent)}% left`];
  if (binding.resets_at != null) parts.push(`resets ${resetLabel(binding.resets_at, now)}`);
  for (const other of liveWindows(windows, nowSeconds)) {
    if (other !== binding) parts.push(`${windowLabel(other)} ${100 - Math.min(100, other.used_percent)}%`);
  }
  return parts.join(" · ");
}

/** Fold a plan report into what was known. A partial report only changes
 *  the windows it lists. */
export function mergePlan(known: PlanWindow[] | undefined, windows: PlanWindow[], partial: boolean): PlanWindow[] {
  if (!partial || !known) return windows;
  const updated = known.map((w) => windows.find((n) => n.name === w.name) ?? w);
  return [...updated, ...windows.filter((n) => !known.some((w) => w.name === n.name))];
}

/** True when a report shows a window that has started over since `known`. */
export function hasReset(known: PlanWindow[] | undefined, windows: PlanWindow[]): boolean {
  if (!known) return false;
  return windows.some((w) => {
    const before = known.find((k) => k.name === w.name);
    return before?.resets_at != null && w.resets_at != null && w.resets_at > before.resets_at && w.used_percent < before.used_percent;
  });
}

/** Full reset date and time: "Oct 4, 3:00 PM". */
export function resetDate(resetsAt: number): string {
  const at = new Date(resetsAt * 1000);
  return `${at.toLocaleDateString([], { month: "short", day: "numeric" })}, ${at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
}
