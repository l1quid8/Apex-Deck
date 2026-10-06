// Where a thread runs, and what changing it does. A thread that hasn't
// started goes wherever it is pointed; one that has stays, and the person is
// asked whether to start a new thread or a fork in the new place. Work in
// lists every machine, one row per folder, so two copies on one server are
// never confused. Plain functions, tested on their own.

import type { Pane, Workspace } from "./types";
import { workspaceFamily, workspaceHost } from "./hostSession.ts";

/** Started: a message arrived after the thread was made (or forked, at `forkAt`), or Send was pressed. */
export function threadStarted(messages: number, forkAt: number, sending: boolean): boolean {
  return sending || messages > forkAt;
}

export type ChoiceOutcome = "same" | "move" | "ask";

/** What picking `target` does to a thread in `current`. */
export function chooseOutcome(current: string, target: string, started: boolean): ChoiceOutcome {
  if (current === target) return "same";
  return started ? "ask" : "move";
}

export interface WorkRow {
  hostId: string;
  /** The project copy this row picks; null when that machine has no copy yet. */
  workspaceId: string | null;
  path: string;
  /** The first row for its machine, which shows the machine's name. */
  first: boolean;
  offline: boolean;
  current: boolean;
}

/**
 * Work in's rows: for each machine in `hostIds` order, one row per folder
 * holding a copy of `current`'s project, or one "no copy yet" row. A project
 * without a folder only exists where it is.
 */
export function workInRows(workspaces: Workspace[], hostIds: string[], current: Workspace, offline: (hostId: string) => boolean): WorkRow[] {
  const shown = workspaces.filter((w) => !w.hidden);
  const family = workspaceFamily(current);
  const rows: WorkRow[] = [];
  for (const hostId of hostIds) {
    const copies = !current.path
      ? (workspaceHost(current) === hostId ? [current] : [])
      : shown.filter((w) => w.path && workspaceHost(w) === hostId && workspaceFamily(w) === family);
    const off = offline(hostId);
    if (copies.length === 0) rows.push({ hostId, workspaceId: null, path: "", first: true, offline: off, current: false });
    else copies.forEach((w, i) => rows.push({ hostId, workspaceId: w.id, path: w.path, first: i === 0, offline: off, current: w.id === current.id }));
  }
  return rows;
}

export interface PickerRow { workspace: Workspace; hostId: string; current: boolean; offline: boolean }

/** The project picker's rows: projects with recent threads first, then the rest in list order. */
export function pickerRows(workspaces: Workspace[], panes: Pane[], current: string, offline: (hostId: string) => boolean): PickerRow[] {
  const recent = new Map<string, number>();
  for (const p of panes) if (p.kind === "chat" && !p.archived && p.activeAt) recent.set(p.workspaceId, Math.max(recent.get(p.workspaceId) ?? 0, p.activeAt));
  const shown = workspaces.filter((w) => !w.hidden);
  const ordered = [
    ...shown.filter((w) => recent.has(w.id)).sort((a, b) => recent.get(b.id)! - recent.get(a.id)!),
    ...shown.filter((w) => !recent.has(w.id)),
  ];
  return ordered.map((workspace) => {
    const hostId = workspaceHost(workspace);
    return { workspace, hostId, current: workspace.id === current, offline: offline(hostId) };
  });
}

/** Search reads the project's name, its machine's name and its folder. */
export function pickerMatches(row: PickerRow, hostName: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return `${row.workspace.name} ${hostName} ${row.workspace.path}`.toLowerCase().includes(q);
}

/** A long name shortened in the middle, as headers show it when room runs out: apex-smoke-test → apex…test. */
export function shortName(name: string, room = 9): string {
  if (name.length <= room) return name;
  const head = Math.ceil((room - 1) / 2);
  const tail = Math.floor((room - 1) / 2);
  return `${name.slice(0, head)}…${name.slice(name.length - tail)}`.replace(/[-\s]?…[-\s]?/, "…");
}
