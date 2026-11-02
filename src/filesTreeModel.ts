import { pathBase, pathParts } from "./paths.ts";
import type { FolderListing, ThreadDiff } from "./types";

export type ChangeMark = "M" | "A" | "D";
export type Entry = { state: "loading" } | { state: "error"; message: string } | { state: "ready"; listing: FolderListing };
export interface FilesTree { root: string; expanded: Set<string>; entries: Map<string, Entry>; selected: string | null }
export interface Row { path: string; name: string; depth: number; folder: boolean; changed: ChangeMark | null; hasChangedInside: boolean; loading?: boolean; error?: string; truncated?: boolean }
export function createTree(root: string): FilesTree { return { root, expanded: new Set([root]), entries: new Map([[root, { state: "loading" }]]), selected: null }; }
const join = (dir: string, name: string) => `${dir.replace(/\/$/, "")}/${name}`;
const relative = (root: string, path: string) => path === root ? "" : path.startsWith(`${root.replace(/\/$/, "")}/`) ? path.slice(root.replace(/\/$/, "").length + 1) : path.replace(/^\//, "");
export function changeMarks(diff: ThreadDiff | null, root: string): Map<string, ChangeMark> {
  const marks = new Map<string, ChangeMark>();
  for (const file of diff?.files ?? []) {
    const patch = file.patch ?? "";
    marks.set(file.path.startsWith("/") ? file.path : join(root, file.path), /^(?:\+\+\+|\+\+\+) \/dev\/null/m.test(patch) || /^\+\+\+ \/dev\/null/m.test(patch) ? "D" : /^--- \/dev\/null/m.test(patch) ? "A" : "M");
  }
  return marks;
}
export function visibleRows(tree: FilesTree, opts: { changes: Map<string, ChangeMark>; changedOnly: boolean; showHidden: boolean }): Row[] {
  const rows: Row[] = [];
  const changedPaths = [...opts.changes.keys()];
  const insideChanged = (path: string) => changedPaths.some((p) => p.startsWith(`${path.replace(/\/$/, "")}/`));
  const visit = (dir: string, depth: number) => {
    const entry = tree.entries.get(dir);
    if (!entry || entry.state === "loading") { rows.push({ path: dir, name: pathBase(dir), depth, folder: true, changed: null, hasChangedInside: insideChanged(dir), loading: true }); return; }
    if (entry.state === "error") { rows.push({ path: dir, name: pathBase(dir), depth, folder: true, changed: null, hasChangedInside: false, error: entry.message }); return; }
    const listing = entry.listing;
    const names = [...listing.folders.map((name) => ({ name, folder: true })), ...listing.files.map((name) => ({ name, folder: false }))];
    for (const item of names) {
      const path = join(dir, item.name), changed = opts.changes.get(path) ?? null;
      if (item.name === ".git" || item.name === ".DS_Store") continue;
      if (!opts.showHidden && item.name.startsWith(".") && !changed) continue;
      if (opts.changedOnly && !changed && !(item.folder && insideChanged(path))) continue;
      rows.push({ path, name: item.name, depth, folder: item.folder, changed, hasChangedInside: item.folder && insideChanged(path), truncated: item.folder ? undefined : undefined });
      if (item.folder && (tree.expanded.has(path) || (opts.changedOnly && insideChanged(path)))) visit(path, depth + 1);
    }
    if (listing.truncated) rows.push({ path: dir, name: "More files not shown.", depth, folder: false, changed: null, hasChangedInside: false, truncated: true });
  };
  visit(tree.root, 0);
  if (opts.changedOnly) for (const [path, mark] of opts.changes) if (mark === "D" && !tree.entries.has(path)) rows.push({ path, name: pathBase(relative(tree.root, path)) || path, depth: 0, folder: false, changed: mark, hasChangedInside: false });
  return rows;
}
export function toggle(tree: FilesTree, path: string): FilesTree {
  const expanded = new Set(tree.expanded), entries = new Map(tree.entries);
  if (expanded.has(path)) expanded.delete(path); else { expanded.add(path); if (!entries.has(path)) entries.set(path, { state: "loading" }); }
  return { ...tree, expanded, entries };
}
export function collapseAll(tree: FilesTree): FilesTree { return { ...tree, expanded: new Set(), selected: tree.root }; }
export function revealPath(tree: FilesTree, path: string): { tree: FilesTree; needs: string[] } {
  const normalized = path.replace(/\\/g, "/");
  const rel = relative(tree.root, normalized);
  const parts = pathParts(rel), expanded = new Set(tree.expanded), entries = new Map(tree.entries), needs: string[] = [];
  let cursor = tree.root;
  for (const part of parts.slice(0, -1)) { cursor = join(cursor, part); expanded.add(cursor); const entry = entries.get(cursor); if (!entry) { entries.set(cursor, { state: "loading" }); needs.push(cursor); } else if (entry.state === "loading") needs.push(cursor); }
  return { tree: { ...tree, expanded, entries, selected: normalized }, needs };
}
export function moveSelection(rows: Row[], selected: string | null, key: "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight" | "Home" | "End"): { selected: string | null; action?: "expand" | "collapse" } {
  if (!rows.length) return { selected: null };
  const index = Math.max(0, rows.findIndex((row) => row.path === selected));
  if (key === "Home") return { selected: rows[0].path };
  if (key === "End") return { selected: rows.at(-1)!.path };
  if (key === "ArrowUp") return { selected: rows[Math.max(0, index - 1)].path };
  if (key === "ArrowDown") return { selected: rows[Math.min(rows.length - 1, index + 1)].path };
  const row = rows[index];
  if (key === "ArrowRight") return row.folder ? { selected: row.path, action: "expand" } : { selected: row.path };
  if (row.folder) return { selected: row.path, action: "collapse" };
  const parent = rows.slice(0, index).reverse().find((candidate) => candidate.folder && row.path.startsWith(`${candidate.path}/`));
  return { selected: parent?.path ?? row.path };
}
export function parseFilesPrefs(raw: string | null): Record<string, { expanded: string[]; changedOnly: boolean; showHidden: boolean; previewHeight: number; treeWidth: number }> {
  try {
    const parsed = JSON.parse(raw ?? "{}"); if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).slice(-20).map(([root, value]) => {
      const v = value && typeof value === "object" ? value as Record<string, unknown> : {};
      return [root, { expanded: Array.isArray(v.expanded) ? v.expanded.filter((x): x is string => typeof x === "string") : [], changedOnly: v.changedOnly === true, showHidden: v.showHidden === true, previewHeight: typeof v.previewHeight === "number" && Number.isFinite(v.previewHeight) ? Math.max(160, Math.min(700, v.previewHeight)) : 280, treeWidth: typeof v.treeWidth === "number" && Number.isFinite(v.treeWidth) ? Math.max(180, Math.min(600, v.treeWidth)) : 280 }];
    }));
  } catch { return {}; }
}
