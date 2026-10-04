// The workspace list in the rail.
//
// Removing a workspace only hides it. Its threads stay saved and closed,
// its terminals end, and Undo, Show or adding the same folder again bring
// it back. These rules are plain functions so they can be tested on their own.

import type { Pane, Workspace } from "./types";

/** Workspaces listed in the rail. */
export function shownWorkspaces(list: Workspace[]): Workspace[] {
  return list.filter((w) => !w.hidden);
}

/** Remove a workspace from the list, or bring it back. */
export function setHidden(list: Workspace[], id: string, hidden: boolean): Workspace[] {
  return list.map((w) => (w.id === id ? { ...w, hidden } : w));
}

/** The workspace to show: the active one while it is listed, otherwise the first listed one. */
export function activeAfter(list: Workspace[], active: string | null): string | null {
  const shown = shownWorkspaces(list);
  return active && shown.some((w) => w.id === active) ? active : (shown[0]?.id ?? null);
}

/** Panes of listed workspaces. A removed workspace's threads are not mounted, so their rooms close. */
export function listedPanes(panes: Pane[], list: Workspace[]): Pane[] {
  const hidden = new Set(list.filter((w) => w.hidden).map((w) => w.id));
  return panes.filter((p) => !hidden.has(p.workspaceId));
}

/** A workspace's threads that are open on the deck, so Undo can open them again. */
export function openThreadIds(panes: Pane[], workspaceId: string): string[] {
  return panes.filter((p) => p.workspaceId === workspaceId && p.kind === "chat" && !p.closed).map((p) => p.id);
}

/** Panes once a workspace is removed: its terminals are gone and its threads are closed. Nothing is deleted. */
export function removeWorkspacePanes(panes: Pane[], workspaceId: string): Pane[] {
  return panes
    .filter((p) => !(p.workspaceId === workspaceId && p.kind === "terminal"))
    .map((p) => (p.workspaceId === workspaceId && p.kind === "chat" && !p.closed ? { ...p, closed: true } : p));
}

/** Open these threads again, for Undo. */
export function reopenThreads(panes: Pane[], ids: string[]): Pane[] {
  return panes.map((p) => (ids.includes(p.id) ? { ...p, closed: false } : p));
}
