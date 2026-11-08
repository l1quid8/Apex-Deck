import type { AppSession, Pane, Workspace } from "./types";

/** JSON with sorted keys and no nulls, so two copies of the same threads compare equal. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v) => (v && typeof v === "object" && !Array.isArray(v)
    ? Object.fromEntries(Object.keys(v).sort().filter((k) => v[k] !== null && v[k] !== undefined).map((k) => [k, v[k]]))
    : v));
}

/**
 * A saved session that came back from the Mac's helper, reduced to what changed.
 * Returns the threads and projects to use, or null when there is nothing new:
 * the same threads we hold, or an older save of our own arriving late.
 * Another client (the phone) saving tells us through `savedBy`, or by having none.
 */
export function remoteSessionEdit(
  local: { workspaces: Workspace[]; panes: Pane[] },
  remote: Partial<AppSession> | null | undefined,
  ours: { tag: string; seq: number },
): { workspaces: Workspace[]; panes: unknown[] } | null {
  if (!remote || !Array.isArray(remote.workspaces) || !Array.isArray(remote.panes)) return null;
  const [tag, seq] = String(remote.savedBy ?? "").split(":");
  if (tag === ours.tag && Number(seq) < ours.seq) return null;
  if (canonical(remote.workspaces) === canonical(local.workspaces) && canonical(remote.panes) === canonical(local.panes)) return null;
  return { workspaces: remote.workspaces, panes: remote.panes };
}

/** Apply a Mac session event to the phone's project/thread registry while preserving phone UI state. */
export function mergePhoneSessionChange(
  current: AppSession,
  remote: Partial<AppSession> | null | undefined,
  ours: { tag: string; seq: number },
): AppSession {
  const edit = remoteSessionEdit({ workspaces: current.workspaces, panes: current.panes }, remote, ours);
  return edit ? { ...current, workspaces: edit.workspaces, panes: edit.panes as Pane[] } : current;
}

/** Profiles have their own revision and author, so a stale layout save cannot
 * turn another client's agent changes into an acknowledgement of our own edits. */
export function remoteProfileEdit(
  revision: number,
  remote: Partial<AppSession> | null | undefined,
  tag: string,
): { revision: number; profiles: AppSession["profiles"]; ownSave: boolean } | null {
  if (!remote || !Array.isArray(remote.profiles) || !Number.isSafeInteger(remote.profileRevision) || remote.profileRevision! <= revision) return null;
  return { revision: remote.profileRevision!, profiles: remote.profiles, ownSave: String(remote.profileSavedBy ?? "").split(":")[0] === tag };
}
