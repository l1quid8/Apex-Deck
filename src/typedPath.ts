// Asking for a folder or file on a host on another machine, where this Mac's
// file dialog can't look. PathPrompt.tsx shows it, browsing the host's folders.

import type { FolderListing } from "./types";

export interface PathRequest {
  kind: "directory" | "file";
  title: string;
}

export interface FolderRow {
  name: string;
  path: string;
  folder: boolean;
}

/** The rows the picker shows: folders, then files when a file is wanted.
 *  Names starting with a dot only with `hidden`. */
export function folderRows(listing: FolderListing, kind: PathRequest["kind"], hidden: boolean): FolderRow[] {
  const shown = (name: string) => hidden || !name.startsWith(".");
  const row = (folder: boolean) => (name: string): FolderRow => ({ name, path: childPath(listing.path, name), folder });
  return [
    ...listing.folders.filter(shown).map(row(true)),
    ...(kind === "file" ? listing.files.filter(shown).map(row(false)) : []),
  ];
}

/** Whether listing failed because the host's apex-daemon predates `folder_list`. */
export function listingUnsupported(error: unknown): boolean {
  return /unknown variant `folder_list`/.test(error instanceof Error ? error.message : String(error));
}

function childPath(dir: string, name: string): string {
  return dir.endsWith("/") ? `${dir}${name}` : `${dir}/${name}`;
}

function parentPath(path: string): string {
  const cut = path.replace(/\/+$/, "").lastIndexOf("/");
  return cut <= 0 ? "/" : path.slice(0, cut);
}

export function pathPromptStore() {
  let current: (PathRequest & { resolve: (path: string | null) => void }) | null = null;
  let last: string | null = null;
  const listeners = new Set<() => void>();
  const change = (next: typeof current) => {
    current = next;
    listeners.forEach((cb) => cb());
  };
  return {
    get: (): PathRequest | null => current,
    /** The folder the last answer was in, so the next question opens there. Null for home. */
    startAt: (): string | null => last,
    subscribe(cb: () => void) {
      listeners.add(cb);
      return () => { listeners.delete(cb); };
    },
    /** Resolves with the path, or null when cancelled. */
    ask(request: PathRequest): Promise<string | null> {
      current?.resolve(null);
      return new Promise((resolve) => change({ ...request, resolve }));
    },
    answer(path: string | null) {
      const asked = current;
      if (!asked) return;
      const chosen = path === null ? null : path.trim();
      if (chosen) last = parentPath(chosen);
      change(null);
      asked.resolve(chosen);
    },
  };
}

/** The app's one path prompt. */
export const pathPrompt = pathPromptStore();
