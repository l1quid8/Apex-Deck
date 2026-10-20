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

/** The words for each dot, shared by the sidebar and Settings › Hosts. */
export const DOT_WORDS = { on: "Connected", wait: "Connecting", off: "Can't be reached", idle: "Not connected yet" } as const;

/** This Mac's name. desktop/hosts.mjs reserves it, so no saved host can be called this. */
export const LOCAL_HOST_NAME = "This Mac";

/** Words for a helper older than this app. Deck has no updater, so there is no Restart button. */
export function helperNotice(name: string, app: string, helper: string | null | undefined): string | null {
  if (helper === undefined || helper === app) return null;
  // This Mac's daemon ships inside the app bundle, so reinstalling the app is
  // the update; the daemon-ubuntu doc only helps a server someone else runs.
  const local = name === LOCAL_HOST_NAME;
  if (helper === null) {
    return local
      ? `This Mac's daemon is older than this app (${app}), so live approvals stop after a reconnect. Reinstall the app to update the daemon it ships.`
      : `Deck's helper on ${name} is older than this app (${app}). Update apex-daemon there to recover live approvals after a reconnect.`;
  }
  return local
    ? `This Mac runs apex-daemon ${helper}, which ships with the app; this app is ${app}. Reinstall the app to update it.`
    : `${name} runs apex-daemon ${helper}; this app is ${app}. Update it there (docs/daemon-ubuntu.md).`;
}

/** The commit a build came from, as apex-daemon's welcome and vite.config.ts report it. */
export interface Build { commit: string; dirty: boolean }

const label = (build: Build) => `${build.commit}${build.dirty ? "-dirty" : ""}`;

/**
 * Words for a service built from a different commit than this app. Same
 * version numbers can hide different builds, and a newer app on an older
 * service fails in confusing ways, so say it plainly. Quiet when the app
 * itself has no commit to compare (a dev build without git).
 */
export function buildNotice(name: string, app: Build, build: Build | null | undefined): string | null {
  if (build === undefined || app.commit === "unknown") return null;
  if (build === null) return `${name}'s service is older than build IDs, so Deck can't tell whether it matches this app (build ${label(app)}). Update the service there.`;
  if (build.commit === "unknown") return `${name}'s service doesn't know which build it is, so Deck can't tell whether it matches this app (build ${label(app)}).`;
  if (build.commit === app.commit) return null;
  return `${name}'s service is build ${label(build)}; this app is build ${label(app)}. Features may fail until they match, so update one of them.`;
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

export interface HostLine {
  dot: DotState;
  /** "Connected · apex-daemon 0.7.0", or reachNotice's words. */
  text: string;
  tone: "plain" | "warn" | "bad";
  /** The raw reason from the connection, when it has one (reconnecting/failed). */
  why: string | null;
  /** A second warn line when connected to a mismatched helper or build. */
  notice: string | null;
  action: "connect" | "retry" | null;
}

/** Everything Settings › Hosts says about one machine, from the same helpers as the sidebar. */
export function hostLine(name: string, state: HostConnection | null, app: { version: string; build: Build }, time: (at: number) => string): HostLine {
  const status = state?.status ?? { kind: "idle" as const };
  const dot = dotState(status);
  if (state && status.kind === "connected") {
    return {
      dot, tone: "plain", why: null, action: null,
      text: typeof state.helper === "string" ? `Connected · apex-daemon ${state.helper}` : "Connected",
      notice: buildNotice(name, app.build, state.build) ?? helperNotice(name, app.version, state.helper),
    };
  }
  const reach = reachNotice(name, status, state?.seenAt, time)!;
  return {
    dot, text: reach.text, tone: reach.tone, action: reach.action, notice: null,
    why: status.kind === "reconnecting" || status.kind === "failed" ? status.reason : null,
  };
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
