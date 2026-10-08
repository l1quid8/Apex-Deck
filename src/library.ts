import type { LibraryItem } from "./backend";

export interface LibraryFilter {
  /** The bot's name, or null for every bot. */
  bot: string | null;
  /** The workspace id, or null for every workspace. */
  workspace: string | null;
}

/** The part of a thread the Library needs: its id and the workspace it is in. */
export interface LibraryThread {
  id: string;
  workspaceId: string;
}

/** The workspace a picture's thread is in, or null when that thread is gone. */
export function workspaceForRoom(room: string, threads: LibraryThread[]): string | null {
  return threads.find((t) => t.id === room)?.workspaceId ?? null;
}

/** A thread that is still on the deck, so "Open thread" can go there. */
export function threadExists(room: string, threads: LibraryThread[]): boolean {
  return threads.some((t) => t.id === room);
}

/** Every bot that made a picture, A to Z. Pictures with no bot name are left out. */
export function botsIn(items: LibraryItem[]): string[] {
  const names = new Set(items.map((item) => item.by?.trim() ?? "").filter(Boolean));
  return [...names].sort((a, b) => a.localeCompare(b));
}

/** Every workspace that still has a thread with a picture, in the order given. */
export function workspacesIn(items: LibraryItem[], threads: LibraryThread[]): string[] {
  const ids = new Set<string>();
  for (const item of items) {
    const workspace = workspaceForRoom(item.room, threads);
    if (workspace) ids.add(workspace);
  }
  return [...ids];
}

/** Pictures that match both filters, newest first. A filter set to null matches all. */
export function filterLibrary(items: LibraryItem[], filter: LibraryFilter, threads: LibraryThread[]): LibraryItem[] {
  return items
    .filter((item) => !filter.bot || item.by?.trim() === filter.bot)
    .filter((item) => !filter.workspace || workspaceForRoom(item.room, threads) === filter.workspace)
    .slice()
    .sort((a, b) => b.created - a.created);
}
