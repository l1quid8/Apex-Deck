// Closing and deleting panes.
//
// × on a pane head only ever closes it. A thread that is closed stays saved
// and listed in the rail; deleting one is a separate, confirmed action with
// a short time to undo it. These rules are plain functions so they can be
// tested on their own.

import type { Pane, PaneStatus, ThreadStatus } from "./types";

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

// ------------------------------------------------- removing a workspace

/** What is going on in a workspace about to be removed from the list. */
export interface RemoveCounts {
  /** Terminals that are working, and terminals waiting for you: the two states closeNeedsConfirm asks about. */
  working: number;
  waiting: number;
  /** Threads with a bot replying and none on a card, and threads with a bot stopped on a card. */
  replying: number;
  asking: number;
  /** Every thread of the workspace. They all stay saved. */
  threads: number;
}

export function removeCounts(terminals: PaneStatus[], threads: (ThreadStatus | undefined)[]): RemoveCounts {
  return {
    working: terminals.filter((s) => closeNeedsConfirm("terminal", s) && s === "working").length,
    waiting: terminals.filter((s) => closeNeedsConfirm("terminal", s) && s === "needs_input").length,
    replying: threads.filter((t) => t !== undefined && t.waiting.length === 0 && t.replying.length > 0).length,
    asking: threads.filter((t) => t !== undefined && t.waiting.length > 0).length,
    threads: threads.length,
  };
}

const many = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;
const isAre = (n: number) => (n === 1 ? "is" : "are");

/** "2 terminals are working and 1 is waiting for you." Empty when both counts are 0. */
function busySentence(noun: string, doing: string, active: number, waiting: number): string {
  if (active > 0 && waiting > 0) return `${many(active, noun)} ${isAre(active)} ${doing} and ${waiting} ${isAre(waiting)} waiting for you.`;
  if (active > 0) return `${many(active, noun)} ${isAre(active)} ${doing}.`;
  if (waiting > 0) return `${many(waiting, noun)} ${isAre(waiting)} waiting for you.`;
  return "";
}

/**
 * The question asked before removing a workspace from the list, or `null`
 * to remove it at once because nothing in it is running. Clauses whose
 * count is 0 are left out.
 */
export function removeQuestion(name: string, counts: RemoveCounts): { title: string; body: string; action: string } | null {
  const terminals = counts.working + counts.waiting;
  const threads = counts.replying + counts.asking;
  if (terminals + threads === 0) return null;
  const body = [
    busySentence("terminal", "working", counts.working, counts.waiting),
    terminals === 0 ? "" : terminals === 1 ? "It ends now." : "They end now.",
    busySentence("thread", "replying", counts.replying, counts.asking),
    threads === 0 ? "" : threads === 1 ? "It stops now." : "They stop now.",
    counts.threads === 0 ? "" : counts.threads === 1
      ? "Its thread stays saved and comes back if you add the folder again."
      : `Its ${counts.threads} threads stay saved and come back if you add the folder again.`,
  ].filter(Boolean).join(" ");
  return { title: `Remove ${name} from the list?`, body, action: "Remove from list" };
}

// ------------------------------------------------------------- quitting

/** A terminal pane when the app is asked to quit. */
export interface TerminalNow {
  title: string;
  workspace: string;
  /** Runs a coding agent rather than a plain shell. */
  agent: boolean;
  /** Its program has ended. Read this, not `status`: a failed exit shows as "failed". */
  exited: boolean;
  status: PaneStatus;
}

/** A thread when the app is asked to quit. `status` is missing until it has reported. */
export interface ThreadNow {
  title: string;
  workspace: string;
  status: ThreadStatus | undefined;
}

/** Something still running when the app is asked to quit. */
export interface Running {
  /** The bare name: "Codex", "Null". */
  name: string;
  /** The thread a bot is in; empty for a terminal. */
  thread: string;
  workspace: string;
  state: "working" | "replying" | "waiting" | "idle";
}

/** How many running things the quit question lists before "and n more". */
export const QUIT_ROWS = 5;

/**
 * What quitting would end: every agent terminal that hasn't exited, a plain
 * shell only while it is working or waiting, and every bot replying or
 * stopped on a card.
 */
export function stillRunning(terminals: TerminalNow[], threads: ThreadNow[]): Running[] {
  const out: Running[] = [];
  for (const t of terminals) {
    if (t.exited) continue;
    const state = t.status === "needs_input" ? "waiting" : t.status === "working" ? "working" : "idle";
    // A shell sitting at its prompt has nothing to lose.
    if (!t.agent && state === "idle") continue;
    out.push({ name: t.title, thread: "", workspace: t.workspace, state });
  }
  for (const t of threads) {
    for (const name of t.status?.waiting ?? []) out.push({ name, thread: t.title, workspace: t.workspace, state: "waiting" });
    for (const name of t.status?.replying ?? []) out.push({ name, thread: t.title, workspace: t.workspace, state: "replying" });
  }
  return out;
}

const STATE_WORDS: Record<Running["state"], string> = { waiting: "Waiting for you", working: "Working", replying: "Replying", idle: "Idle" };
const STATE_ORDER: Running["state"][] = ["waiting", "working", "replying", "idle"];

/**
 * The question asked before quitting, or `null` to quit at once because
 * nothing is running. Rows are most urgent first, at most QUIT_ROWS of them,
 * then "and n more".
 */
export function quitQuestion(busy: Running[]): { title: string; body: string; rows: string[]; action: string } | null {
  if (busy.length === 0) return null;
  const sorted = [...busy].sort((a, b) => STATE_ORDER.indexOf(a.state) - STATE_ORDER.indexOf(b.state));
  const rows = sorted
    .slice(0, QUIT_ROWS)
    .map((r) => [r.thread ? `${r.name} in ${r.thread}` : r.name, r.workspace, STATE_WORDS[r.state]].filter(Boolean).join(" · "));
  if (sorted.length > QUIT_ROWS) rows.push(`and ${sorted.length - QUIT_ROWS} more`);
  const title = busy.length === 1 && busy[0].state === "waiting"
    ? `${busy[0].name} is waiting for you.`
    : busy.length === 1 ? "1 agent is still running." : `${busy.length} agents are still running.`;
  return {
    title,
    body: "Quitting ends them and anything they're running. Threads and their messages are saved; replies in progress are not.",
    rows,
    action: "Quit and end them",
  };
}
