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

/** Workspaces removed from the list, for the rail's Removed line. */
export function hiddenWorkspaces(list: Workspace[]): Workspace[] {
  return list.filter((w) => w.hidden);
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

/** Rename a workspace. A blank name leaves it as it was. */
export function renameWorkspace(list: Workspace[], id: string, name: string): Workspace[] {
  const trimmed = name.trim();
  if (!trimmed) return list;
  return list.map((w) => (w.id === id ? { ...w, name: trimmed } : w));
}

/**
 * Add folders to the list. A folder already listed is reused, and one
 * removed from the list comes back instead of being added twice. An empty
 * path (a workspace with no folder) never matches. Returns the new list and
 * the workspace id for each path, in order.
 */
export function addFolders(list: Workspace[], paths: string[], makeId: () => string, nameOf: (path: string) => string): { list: Workspace[]; ids: string[] } {
  let next = list;
  const ids: string[] = [];
  for (const path of paths) {
    const existing = path ? next.find((w) => w.path === path) : undefined;
    if (existing) {
      if (existing.hidden) next = setHidden(next, existing.id, false);
      ids.push(existing.id);
    } else {
      const workspace: Workspace = { id: makeId(), name: nameOf(path), path };
      next = [...next, workspace];
      ids.push(workspace.id);
    }
  }
  return { list: next, ids };
}
