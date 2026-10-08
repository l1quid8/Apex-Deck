// Removing a project from the phone.
//
// The phone takes a project out of the saved thread list on the Mac. Only the
// list changes: the folder on disk is never touched. These rules are plain
// functions so they can be tested on their own.

import type { AppSession, Pane, Workspace } from "../types";

/** What Undo needs to put a removed project back: its workspace and its threads. */
export interface RemovedProject {
  workspace: Workspace;
  /** Where it sat in the project list, so Undo puts it back in the same place. */
  index?: number;
  /** Only threads come back. Terminals and previews do not, the same as on the Mac. */
  panes: Pane[];
}

/**
 * Take a project and every pane in it out of the thread list. Returns the new
 * list and what Undo needs. An id that isn't in the list gives `undo: null`
 * and the list unchanged.
 */
export function removeProjectFrom(session: AppSession, id: string): { next: AppSession; undo: RemovedProject | null } {
  const workspace = session.workspaces.find((item) => item.id === id);
  if (!workspace) return { next: session, undo: null };
  const gone = session.panes.filter((pane) => pane.workspaceId === id);
  const goneIds = new Set(gone.map((pane) => pane.id));
  const next: AppSession = {
    ...session,
    workspaces: session.workspaces.filter((item) => item.id !== id),
    panes: session.panes.filter((pane) => pane.workspaceId !== id),
    activeWorkspace: session.activeWorkspace === id ? null : session.activeWorkspace,
    focusedPane: session.focusedPane !== null && goneIds.has(session.focusedPane) ? null : session.focusedPane,
  };
  return { next, undo: { workspace, index: session.workspaces.indexOf(workspace), panes: gone.filter((pane) => pane.kind === "chat") } };
}

/**
 * Put a removed project back: its workspace, then its threads. Anything already
 * in the list is left as it is, so restoring twice never duplicates a row.
 */
export function restoreProjectTo(session: AppSession, undo: RemovedProject): AppSession {
  const haveWorkspace = session.workspaces.some((item) => item.id === undo.workspace.id);
  const havePanes = new Set(session.panes.map((pane) => pane.id));
  const at = Math.min(undo.index ?? session.workspaces.length, session.workspaces.length);
  return {
    ...session,
    workspaces: haveWorkspace ? session.workspaces : [...session.workspaces.slice(0, at), undo.workspace, ...session.workspaces.slice(at)],
    panes: [...session.panes, ...undo.panes.filter((pane) => !havePanes.has(pane.id))],
  };
}

/**
 * The question asked before removing a project on the phone. The phone can't
 * see the Mac's terminals, so it does not count what is running; it says that
 * anything running in the project stops. Archived threads leave too, and are
 * named apart so the count matches the project's own "N threads".
 */
export function removeProjectWords(name: string, threads: number, archived = 0): { title: string; body: string; action: string } {
  const listed = threads === 1 ? "Its thread" : `Its ${threads} threads`;
  const stored = `${archived} archived thread${archived === 1 ? "" : "s"}`;
  const who = threads === 0 && archived === 0 ? ""
    : threads === 0 ? `Its ${stored}`
    : archived === 0 ? listed
    : `${listed} and ${stored}`;
  const leave = !who ? ""
    : `${who} ${threads + archived === 1 ? "leaves" : "leave"} the app with it. Undo brings ${threads + archived === 1 ? "it" : "them"} back for a few seconds.`;
  return {
    title: `Remove ${name} from the list?`,
    body: ["Anything running in it stops.", "Its folder on disk isn't deleted.", leave].filter(Boolean).join(" "),
    action: "Remove project",
  };
}
