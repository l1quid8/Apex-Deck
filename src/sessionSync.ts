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
