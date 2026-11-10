// Deleting a thread from the phone.
//
// The Mac asks first, takes the thread off the deck, and deletes it on the machine
// once the undo time runs out (App.tsx, deleteThread). The phone has no undo:
// the thread goes from the machine at once, so the question says so plainly, and
// a phone that can't delete is told why instead of being shown a button that fails.
//
// What can be deleted here is a Work thread. A talk-only chat is a row in the
// host's chat list, and the host has no command that deletes a chat, only
// archiving it; that stays Archive on the chat's menu.
//
// These rules are plain functions so they can be tested on their own.

import type { AppSession } from "../types";

/** The question asked before a thread is deleted on the phone. Nothing can bring it back. */
export function deleteThreadWords(title: string): { title: string; body: string; action: string } {
  return {
    title: `Delete ${title}?`,
    body: "Its messages, pins and temp files are removed from the machine. There is no undo here, and the Mac can't bring it back either.",
    action: "Delete thread",
  };
}

/**
 * Why this phone can't delete the thread, or "" when it can.
 * Deleting needs Full access on the thread's machine: the host checks it
 * (crates/apex-daemon/src/authority.rs, "room_delete").
 */
export function deleteThreadGate(input: { paired: boolean; online: boolean; full: boolean; machine: string }): string {
  if (!input.paired) return "This thread's machine isn't paired with this phone.";
  if (!input.online) return `Connect ${input.machine} before deleting this thread.`;
  if (!input.full) return `Deleting a thread needs Full access on ${input.machine}. Change this phone's level in that machine's Settings → Phones.`;
  return "";
}

/**
 * The saved list without the thread. An id that isn't in the list gives the
 * list unchanged, so deleting twice never disturbs another thread.
 */
export function removeThreadFrom(session: AppSession, id: string): AppSession {
  if (!session.panes.some((pane) => pane.id === id)) return session;
  return {
    ...session,
    panes: session.panes.filter((pane) => pane.id !== id),
    focusedPane: session.focusedPane === id ? null : session.focusedPane,
  };
}
