// Closing and deleting panes.
//
// × on a pane head only ever closes it. A thread that is closed stays saved
// and listed in the rail; deleting one is a separate, confirmed action with
// a short time to undo it. These rules are plain functions so they can be
// tested on their own.

import type { Pane, PaneStatus } from "./types";

/** How long a deleted thread can still be brought back. */
export const UNDO_MS = 8000;

/**
 * Whether closing a pane should ask first. Only a terminal can lose work by
 * closing, and only while it is busy or waiting on the person: an idle or
 * exited terminal, and every thread, close at once.
 */
export function closeNeedsConfirm(kind: Pane["kind"], status: PaneStatus): boolean {
  return kind === "terminal" && (status === "working" || status === "needs_input");
}

/** The words of the question asked before closing a busy terminal. */
export function closeQuestion(title: string, status: PaneStatus): { title: string; body: string; action: string } {
  return {
    title: status === "needs_input" ? `${title} is waiting for you.` : `${title} is still working.`,
    body: "Closing the pane ends it and anything it's running.",
    action: "End and close",
  };
}

/** Panes that are on the deck: not closed, and not on their way to being deleted. */
export function openPanes(panes: Pane[], deleting: ReadonlySet<string>): Pane[] {
  return panes.filter((p) => !p.closed && !deleting.has(p.id));
}

/**
 * The threads written to the session file. A thread waiting out its undo
 * time is still written, so quitting before the time is up keeps it: the
 * delete only happens when the time runs out.
 */
export function savedThreads(panes: Pane[]): Pane[] {
  return panes.filter((p) => p.kind === "chat");
}

/** Threads read back from a session file. Older files have no `closed` field, and their threads open as before. */
export function loadedThreads(saved: unknown[], workspaceIds: string[]): Pane[] {
  return saved
    .filter((p): p is Pane => Boolean(p) && typeof p === "object" && (p as Pane).kind === "chat" && workspaceIds.includes((p as Pane).workspaceId))
    .map((p) => (p.closed ? p : { ...p, closed: false }));
}
