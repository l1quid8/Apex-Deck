// Plan usage belongs to the provider account, not to an agent or a chat, so
// it is kept once for the whole app. Every chat's events feed it (see hub.ts)
// and every agent on that provider shows the same figure.
//
// A provider can also read a model apart from the account's larger quota
// (Gemini keeps Argon in a group of its own, which runs out while the Gemini
// figure still reads 98% left), so the model is part of the key: those bots
// show their own figure, and every other model keeps the account's.

import { useSyncExternalStore } from "react";

import { hasReset, liveWindows, mergePlan } from "./battery.ts";
import type { AgentTool, PlanWindow, ResetCredits } from "./types";

export interface PlanState {
  windows: PlanWindow[];
  /** Goes up each time a window starts over, to play the refill. */
  resets: number;
  /** Usage resets the provider granted, when it has said. */
  credits?: ResetCredits;
}

/** What one row of the plan table is filed under: the provider, and the model
 *  whose own quota group it reports. No model means the account's figure. */
export type PlanKey = string;

/** "gemini", or "gemini:gemini-4-argon" for a model the provider reads apart. */
export function planKey(provider: AgentTool, model?: string | null): PlanKey {
  const named = (model ?? "").trim().toLowerCase();
  return named ? `${provider}:${named}` : provider;
}

/** The plan a bot shows: its own model's group when the provider reported one,
 *  otherwise the account's figure. Never another model's group. */
export function planOf<T>(
  plans: { [key: string]: T | undefined } | undefined,
  provider: AgentTool | null | undefined,
  model?: string | null,
): T | undefined {
  if (!provider) return undefined;
  return plans?.[planKey(provider, model)] ?? plans?.[planKey(provider)];
}

let plans: Record<string, Record<PlanKey, PlanState>> = {};
const EMPTY: Record<PlanKey, PlanState> = {};
const listeners = new Set<() => void>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();

function publish(next: typeof plans) {
  plans = next;
  listeners.forEach((listener) => listener());
}

/** Wake when the soonest window starts over. Its old figure then no longer
 *  counts, and the right side refills. */
function watchResets(key: PlanKey, host = "local") {
  const timer = JSON.stringify([host, key]);
  clearTimeout(timers.get(timer));
  const now = Date.now() / 1000;
  const next = Math.min(...liveWindows(plans[host]?.[key]?.windows ?? [], now).map((w) => w.resets_at ?? Infinity));
  if (!Number.isFinite(next)) return;
  // Timers cannot wait longer than about 24 days; check again by then.
  const wait = Math.min((next - now) * 1000 + 500, 2 ** 31 - 1);
  timers.set(timer, setTimeout(() => {
    const state = plans[host]?.[key];
    if (state) publish({ ...plans, [host]: { ...plans[host], [key]: { ...state, resets: state.resets + 1 } } });
    watchResets(key, host);
  }, wait));
  // A browser tab may wait out a refill; a test runner and any other Node
  // process should not be held open by it. `unref` is Node's.
  (timers.get(timer) as unknown as { unref?: () => void } | undefined)?.unref?.();
}

/** `credits` left out keeps the last ones known: most reports don't list them. */
export function recordPlan(provider: AgentTool, model: string | null | undefined, windows: PlanWindow[], partial: boolean, host = "local", credits?: ResetCredits) {
  const key = planKey(provider, model);
  const known = plans[host]?.[key];
  const merged = mergePlan(known?.windows, windows, partial);
  const reset = hasReset(known?.windows, windows);
  publish({ ...plans, [host]: { ...plans[host], [key]: { windows: merged, resets: (known?.resets ?? 0) + (reset ? 1 : 0), credits: credits ?? known?.credits } } });
  watchResets(key, host);
}

export function planSnapshot(host = "local"): Record<PlanKey, PlanState> { return plans[host] ?? EMPTY; }

export function usePlans(host = "local"): Record<PlanKey, PlanState> {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => planSnapshot(host),
  );
}
