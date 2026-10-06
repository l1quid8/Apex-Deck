// What the sidebar lists: Pinned, Projects and Recents, as in Codex, plus
// the Archived line at the bottom. Plain functions, tested on their own.

import type { AppSection, Pane, Workspace } from "./types";
import { paneSection } from "./closing.ts";
import { workspaceHost } from "./hostSession.ts";

/** How many threads Recents shows. */
export const RECENT_LIMIT = 5;

export interface ProjectBlock { workspace: Workspace; panes: Pane[] }
export interface SidebarSections { pinned: Pane[]; projects: ProjectBlock[]; recents: Pane[]; archived: Pane[] }

const byActivity = (a: Pane, b: Pane) => (b.activeAt ?? 0) - (a.activeAt ?? 0);

/**
 * The rail's lists for one section. A pinned pane sits in Pinned instead of
 * under its project; Recents (Threads only) repeats the most recently active
 * threads; archived threads only appear in `archived`. Removed projects and
 * threads being deleted are left out.
 */
export function sidebarSections(panes: Pane[], workspaces: Workspace[], section: AppSection, deleting: ReadonlySet<string>): SidebarSections {
  const shown = workspaces.filter((w) => !w.hidden);
  const listed = new Set(shown.map((w) => w.id));
  const live = panes.filter((p) => listed.has(p.workspaceId) && !deleting.has(p.id));
  const order = [...shown.filter((w) => w.pinned), ...shown.filter((w) => !w.pinned)];
  if (section === "agents") return { pinned: [], projects: order.map((workspace) => ({ workspace, panes: [] })), recents: [], archived: [] };
  const mine = live.filter((p) => paneSection(p) === section && !p.archived);
  const threads = live.filter((p) => p.kind === "chat");
  return {
    pinned: mine.filter((p) => p.pinned),
    projects: order.map((workspace) => ({ workspace, panes: mine.filter((p) => p.workspaceId === workspace.id && !p.pinned) })),
    recents: section === "threads" ? threads.filter((p) => !p.archived && (p.activeAt ?? 0) > 0).sort(byActivity).slice(0, RECENT_LIMIT) : [],
    archived: threads.filter((p) => p.archived).sort(byActivity),
  };
}

/** A home folder written as ~: /home/pi/code → ~/code, /root/x → ~/x. */
export function homeShort(path: string): string {
  return path.replace(/^(\/home\/[^/]+|\/Users\/[^/]+|\/root)(?=\/|$)/, "~");
}

/** The folder, when another listed project on the same machine has the same name; otherwise "". */
export function twinPath(workspace: Workspace, workspaces: Workspace[]): string {
  const host = workspaceHost(workspace);
  const twins = workspaces.filter((w) => !w.hidden && w.name === workspace.name && workspaceHost(w) === host);
  return twins.length > 1 ? homeShort(workspace.path) : "";
}

/** The colours a server's globe can take. */
export const HOST_TINTS = ["#1ed7ee", "#a78bfa", "#f472b6", "#f2c14e", "#60a5fa", "#34d399", "#fb923c", "#e879f9"] as const;

const hash = (text: string) => {
  let h = 2166136261;
  for (const c of text) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
};

/** In hosts-list order, each server takes its hashed colour, or the next one not taken. */
export function hostTints(hostIds: string[]): Map<string, string> {
  const used = new Set<string>();
  const tints = new Map<string, string>();
  for (const id of hostIds) {
    const start = hash(id) % HOST_TINTS.length;
    let pick: string = HOST_TINTS[start];
    for (let i = 0; i < HOST_TINTS.length; i++) {
      const tint = HOST_TINTS[(start + i) % HOST_TINTS.length];
      if (!used.has(tint)) { pick = tint; break; }
    }
    used.add(pick);
    tints.set(id, pick);
  }
  return tints;
}

/** How long ago, in Codex's words: now, 5m, 3h, 2d, 2w. */
export function ageWords(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return days < 7 ? `${days}d` : `${Math.floor(days / 7)}w`;
}

const without = <T extends object>(value: T, key: keyof T): T => {
  const { [key]: _drop, ...rest } = value;
  return rest as T;
};

/** Archive threads: they close and leave Pinned, Projects and Recents. Other panes are untouched. */
export function archiveThreads(panes: Pane[], ids: string[]): Pane[] {
  return panes.map((p) => (p.kind === "chat" && ids.includes(p.id) ? { ...p, archived: true, closed: true } : p));
}

/** Bring archived threads back to their project, still closed. */
export function unarchiveThreads(panes: Pane[], ids: string[]): Pane[] {
  return panes.map((p) => (ids.includes(p.id) && p.archived ? { ...without(p, "archived"), closed: true } : p));
}

export function setUnread(panes: Pane[], id: string, unread: boolean): Pane[] {
  return panes.map((p) => (p.id !== id || !!p.unread === unread ? p : unread ? { ...p, unread: true } : without(p, "unread")));
}

/** Note a thread's newest message time. Never goes back; unchanged lists are returned as they were. */
export function noteActive(panes: Pane[], id: string, at: number): Pane[] {
  return panes.some((p) => p.id === id && (p.activeAt ?? 0) < at) ? panes.map((p) => (p.id === id ? { ...p, activeAt: at } : p)) : panes;
}

export function toggleProjectPin(list: Workspace[], id: string): Workspace[] {
  return list.map((w) => (w.id !== id ? w : w.pinned ? without(w, "pinned") : { ...w, pinned: true }));
}

export function setCollapsed(list: Workspace[], id: string, collapsed: boolean): Workspace[] {
  return list.map((w) => (w.id !== id || !!w.collapsed === collapsed ? w : collapsed ? { ...w, collapsed: true } : without(w, "collapsed")));
}
