// Files attached before, newest first, for the Work bar's Files list. Only
// files on this Mac are kept (dropped or browsed), so any thread can attach
// them again: a server thread copies them there with the message.

export interface RecentFile { path: string; name: string; at: number }

const LIMIT = 30;
const KEY = "apex-deck.recent-files.v1";

export function rememberFile(list: RecentFile[], path: string, at: number): RecentFile[] {
  const name = path.replace(/\/+$/, "").split("/").pop() || path;
  return [{ path, name, at }, ...list.filter((f) => f.path !== path)].slice(0, LIMIT);
}

export function fileKind(name: string): "img" | "doc" {
  return /\.(png|jpe?g|gif|webp|heic|bmp|svg)$/i.test(name) ? "img" : "doc";
}

export function findFiles(list: RecentFile[], query: string): RecentFile[] {
  const q = query.trim().toLowerCase();
  return q ? list.filter((f) => f.name.toLowerCase().includes(q)) : list;
}

const valid = (f: unknown): f is RecentFile => !!f && typeof f === "object"
  && typeof (f as RecentFile).path === "string" && typeof (f as RecentFile).name === "string" && typeof (f as RecentFile).at === "number";

export function loadRecentFiles(): RecentFile[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(raw) ? raw.filter(valid).slice(0, LIMIT) : [];
  } catch {
    return [];
  }
}

export function saveRecentFiles(list: RecentFile[]): void {
  try { localStorage.setItem(KEY, JSON.stringify(list)); } catch { /* storage unavailable: the list lasts this session */ }
}

/** One list for every pane, so a file attached in one thread shows in the others. */
let current: RecentFile[] | null = null;
const listeners = new Set<() => void>();
export const recentFiles = {
  get(): RecentFile[] { return (current ??= loadRecentFiles()); },
  remember(path: string): void {
    current = rememberFile(recentFiles.get(), path, Date.now());
    saveRecentFiles(current);
    listeners.forEach((fn) => fn());
  },
  subscribe(fn: () => void): () => void { listeners.add(fn); return () => { listeners.delete(fn); }; },
};
