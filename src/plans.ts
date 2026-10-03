// Plan usage belongs to the provider account, not to an agent or a chat,
// so it is kept once for the whole app. Every chat's events feed it (see
// hub.ts) and every agent on that provider shows the same figure.

import { useSyncExternalStore } from "react";

import { hasReset, liveWindows, mergePlan } from "./battery";
import type { AgentTool, PlanWindow } from "./types";

export interface PlanState {
  windows: PlanWindow[];
  /** Goes up each time a window starts over, to play the refill. */
  resets: number;
}

let plans: Partial<Record<AgentTool, PlanState>> = {};
const listeners = new Set<() => void>();
const timers = new Map<AgentTool, ReturnType<typeof setTimeout>>();

function publish(next: Partial<Record<AgentTool, PlanState>>) {
  plans = next;
  listeners.forEach((listener) => listener());
}

/** Wake when the soonest window starts over. Its old figure then no longer
 *  counts, and the right side refills. */
function watchResets(provider: AgentTool) {
  clearTimeout(timers.get(provider));
  const now = Date.now() / 1000;
  const next = Math.min(...liveWindows(plans[provider]?.windows ?? [], now).map((w) => w.resets_at ?? Infinity));
  if (!Number.isFinite(next)) return;
  // Timers cannot wait longer than about 24 days; check again by then.
  const wait = Math.min((next - now) * 1000 + 500, 2 ** 31 - 1);
  timers.set(provider, setTimeout(() => {
    const state = plans[provider];
    if (state) publish({ ...plans, [provider]: { ...state, resets: state.resets + 1 } });
    watchResets(provider);
  }, wait));
}

export function recordPlan(provider: AgentTool, windows: PlanWindow[], partial: boolean) {
  const known = plans[provider];
  const merged = mergePlan(known?.windows, windows, partial);
  const reset = hasReset(known?.windows, windows);
  publish({ ...plans, [provider]: { windows: merged, resets: (known?.resets ?? 0) + (reset ? 1 : 0) } });
  watchResets(provider);
}

export function usePlans(): Partial<Record<AgentTool, PlanState>> {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => plans,
  );
}
