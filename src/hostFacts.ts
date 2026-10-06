// What the sidebar says about a machine: its dot, the notice on its
// project's card, and whether a probed address is the same machine.

import type { HostEntry } from "./backend";
import type { HostConnection } from "./hostConnections.ts";

type HostStatus = HostConnection["status"];

/** on: connected. wait: on its way. off: can't be reached. idle: not used yet this session. */
export type DotState = "on" | "wait" | "off" | "idle";

export function dotState(status: HostStatus): DotState {
  if (status.kind === "connected") return "on";
  if (status.kind === "idle") return "idle";
  return status.kind === "connecting" || status.kind === "resync" ? "wait" : "off";
}

/** Words for a helper older than this app. Deck has no updater, so there is no Restart button. */
export function helperNotice(name: string, app: string, helper: string | null | undefined): string | null {
  if (helper === undefined || helper === app) return null;
  return helper === null
    ? `Deck's helper on ${name} is older than this app (${app}). Update apex-daemon there to recover live approvals after a reconnect.`
    : `${name} runs apex-daemon ${helper}; this app is ${app}. Update it there (docs/daemon-ubuntu.md).`;
}

export interface ReachNotice { tone: "warn" | "bad"; text: string; action: "retry" | "connect" | null }

/** The card's line when a machine isn't connected; null when it is. */
export function reachNotice(name: string, status: HostStatus, seenAt: number | undefined, time: (at: number) => string): ReachNotice | null {
  if (status.kind === "idle") return { tone: "warn", text: "Not connected yet. Deck connects when one of its threads opens.", action: "connect" };
  if (status.kind === "connecting") return { tone: "warn", text: `Connecting to ${name}…`, action: null };
  if (status.kind === "resync") return { tone: "warn", text: `Catching up with ${name}…`, action: null };
  if (status.kind === "reconnecting" || status.kind === "failed") {
    return { tone: "bad", text: seenAt ? `Can't reach ${name}. Last reached at ${time(seenAt)}.` : `Can't reach ${name}.`, action: "retry" };
  }
  return null;
}

export type ProbeKind = "same" | "bind" | "different" | "known" | "new";

/**
 * A probed daemon identity against the saved machines. `hostId` is the one
 * being edited, or null when adding. The main process applies the same rules
 * when it saves (desktop/hostIdentity.mjs), so this only chooses the words.
 */
export function classifyIdentity(hosts: HostEntry[], hostId: string | null, daemonHostId: string): { kind: ProbeKind; name?: string } {
  const other = hosts.find((h) => h.id !== hostId && h.daemonHostId === daemonHostId);
  if (other) return { kind: "known", name: other.name };
  const host = hostId ? hosts.find((h) => h.id === hostId) : undefined;
  if (!host) return { kind: "new" };
  if (host.daemonHostId === daemonHostId) return { kind: "same" };
  return host.daemonHostId ? { kind: "different" } : { kind: "bind" };
}
