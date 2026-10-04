// Closing and deleting panes.
//
// × on a pane head only ever closes it. A thread that is closed stays saved
// and listed in the rail; deleting one is a separate, confirmed action with
// a short time to undo it. These rules are plain functions so they can be
// tested on their own.

import type { LayoutNode } from "./layout";
import { leafIds, removeLeaf, validate } from "./layout.ts";
import { normalizeAddress } from "./previewAddress.ts";
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

/** The deck a pane sits on: threads on Threads, terminals on Code, a preview wherever it was added. */
export function paneSection(pane: Pick<Pane, "kind" | "deck">): "code" | "threads" {
  if (pane.kind === "chat") return "threads";
  if (pane.kind === "preview") return pane.deck === "threads" ? "threads" : "code";
  return "code";
}

/**
 * What is written to the session file: every thread, and each terminal and
 * preview as a descriptor (its id, workspace, name, and its tool or address;
 * never a terminal's output or its process). A thread waiting out its undo
 * time is still written, so quitting before the time is up keeps it: the
 * delete only happens when the time runs out.
 */
export function savedPanes(panes: Pane[]): Pane[] {
  return panes.map((p) => {
    if (p.kind === "chat") return p;
    if (p.kind === "preview") {
      const preview: Pane = { id: p.id, workspaceId: p.workspaceId, kind: "preview", title: p.title, url: p.url ?? "" };
      if (p.servedBy) preview.servedBy = p.servedBy;
      if (p.deck === "threads") preview.deck = "threads";
      return preview;
    }
    const terminal: Pane = { id: p.id, workspaceId: p.workspaceId, kind: "terminal", title: p.title };
    if (p.agent) terminal.agent = p.agent;
    return terminal;
  });
}

/**
 * Panes read back from a session file. Older files have no `closed` field,
 * and their threads open as before; they have no terminals either. A
 * terminal comes back as its descriptor only, and the deck shows it Stopped
 * until you start it. A preview comes back with its address, if it is a web
 * address. Anything malformed, repeated, or in a workspace that is gone is
 * left out.
 */
export function loadedPanes(saved: unknown[], workspaceIds: string[]): Pane[] {
  const seen = new Set<string>();
  return saved.flatMap((value): Pane[] => {
    if (!value || typeof value !== "object") return [];
    const p = value as Partial<Pane>;
    if (typeof p.id !== "string" || !p.id || seen.has(p.id)) return [];
    if (typeof p.workspaceId !== "string" || !workspaceIds.includes(p.workspaceId)) return [];
    if (p.kind === "chat") {
      seen.add(p.id);
      return [p.closed ? (p as Pane) : { ...(p as Pane), closed: false }];
    }
    if (p.kind === "preview") {
      if (typeof p.title !== "string" || !p.title.trim()) return [];
      seen.add(p.id);
      const preview: Pane = { id: p.id, workspaceId: p.workspaceId, kind: "preview", title: p.title, url: typeof p.url === "string" ? normalizeAddress(p.url) ?? "" : "" };
      if (typeof p.servedBy === "string" && p.servedBy) preview.servedBy = p.servedBy;
      if (p.deck === "threads") preview.deck = "threads";
      return [preview];
    }
    if (p.kind !== "terminal" || typeof p.title !== "string" || !p.title.trim()) return [];
    if (p.agent != null && typeof p.agent !== "string") return [];
    seen.add(p.id);
    const terminal: Pane = { id: p.id, workspaceId: p.workspaceId, kind: "terminal", title: p.title };
    if (p.agent) terminal.agent = p.agent;
    return [terminal];
  });
}

/** Layouts are kept by "<workspace id>:<section>". Threads and Code are both saved, for workspaces still listed. */
export function savedLayouts(layouts: Record<string, LayoutNode>, workspaceIds: string[]): Record<string, LayoutNode> {
  const keep = new Set(workspaceIds.flatMap((id) => [`${id}:threads`, `${id}:code`]));
  return Object.fromEntries(Object.entries(layouts).filter(([key]) => keep.has(key)));
}

/**
 * Layouts read back from a session file, for the panes that loaded. A layout
 * that can't be read is dropped; a pane that didn't load, or that belongs to
 * the other section, is taken out and its space goes to its neighbours; and
 * a layout with no panes left is dropped.
 */
export function restoredLayouts(saved: unknown, panes: Pane[]): Record<string, LayoutNode> {
  const out: Record<string, LayoutNode> = {};
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) return out;
  for (const [key, value] of Object.entries(saved)) {
    const cut = key.lastIndexOf(":");
    const section = key.slice(cut + 1);
    if (cut < 1 || (section !== "threads" && section !== "code")) continue;
    const workspace = key.slice(0, cut);
    const loaded = new Set(panes.filter((p) => p.workspaceId === workspace && paneSection(p) === section).map((p) => p.id));
    let tree = validate(value);
    for (const id of leafIds(tree)) if (!loaded.has(id)) tree = removeLeaf(tree, id);
    if (tree) out[key] = tree;
  }
  return out;
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
