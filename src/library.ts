import type { LibraryItem } from "./backend";

export interface LibraryFilter {
  /** The bot's name, or null for every bot. */
  bot: string | null;
  /** The workspace id, or null for every workspace. */
  workspace: string | null;
  /** The machine's host id ("local" for this Mac), or null for every machine. */
  machine?: string | null;
}

/** A Library picture and the machine whose Library keeps it. */
export type MachineItem = LibraryItem & { machine: string };

/** How loading one machine's Library went. */
export type MachineLoad = { kind: "ok" } | { kind: "offline" } | { kind: "old" } | { kind: "failed"; message: string };

/** One key per picture across machines: two machines may hold the same file name. */
export function itemKey(item: MachineItem): string {
  return `${item.machine}/${item.file}`;
}

/** A helper from before the Library answers library_list as an unknown command. */
export function loadOutcome(error: unknown): MachineLoad {
  const message = String((error as Error)?.message ?? error);
  if (/unknown variant [`'"]?library_list|unknown command.*library_list|unsupported.*library_list/i.test(message)) return { kind: "old" };
  if (/not connected|unavailable|can't be reached|timed out/i.test(message)) return { kind: "offline" };
  return { kind: "failed", message };
}

/** The part of a backend needed to list a machine's Library. */
export interface LibrarySource {
  libraryList(): Promise<LibraryItem[]>;
  host?: { connection: { get(): { status: { kind: string } }; subscribe(listener: () => void): () => void } };
}

/** Lists a machine's pictures, first waiting for a server's connection to finish starting; gives up after `ms`. */
export function listLibrary(backend: LibrarySource, ms: number): Promise<LibraryItem[]> {
  const connection = backend.host?.connection;
  return new Promise((resolve, reject) => {
    let off = () => {};
    let asked = false;
    const timer = setTimeout(() => { off(); reject(new Error("timed out")); }, ms);
    const finish = (run: () => void) => { clearTimeout(timer); off(); run(); };
    const ask = () => {
      asked = true;
      off();
      backend.libraryList().then((list) => finish(() => resolve(list)), (err) => finish(() => reject(err)));
    };
    const check = () => {
      if (asked) return;
      const kind = connection?.get().status.kind ?? "connected";
      if (kind === "connected") ask();
      else if (kind === "failed") finish(() => reject(new Error("not connected")));
    };
    if (connection) off = connection.subscribe(check);
    check();
  });
}

/** The line shown for a machine whose pictures couldn't be listed; null when they were. */
export function machineNote(name: string, load: MachineLoad): string | null {
  if (load.kind === "ok") return null;
  if (load.kind === "offline") return `${name} offline. Its pictures show when it's back.`;
  if (load.kind === "old") return `${name} runs an older apex-daemon without a Library. Update it there to see its pictures.`;
  return `Couldn't load ${name}'s Library: ${load.message}`;
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
export function filterLibrary<T extends LibraryItem>(items: T[], filter: LibraryFilter, threads: LibraryThread[]): T[] {
  return items
    .filter((item) => !filter.bot || item.by?.trim() === filter.bot)
    .filter((item) => !filter.workspace || workspaceForRoom(item.room, threads) === filter.workspace)
    .filter((item) => !filter.machine || (item as Partial<MachineItem>).machine === filter.machine)
    .slice()
    .sort((a, b) => b.created - a.created);
}
