import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FolderListing, ThreadDiff } from "./types";
import type { Backend } from "./backend";
import { changeMarks, collapseAll, createTree, moveSelection, parseFilesPrefs, toggle, visibleRows, type FilesTree, type Row } from "./filesTreeModel";
import { writeClipboard } from "./threadCopy";

const join = (dir: string, name: string) => `${dir.replace(/\/$/, "")}/${name}`;
const relative = (root: string, path: string) => path === root ? "." : path.startsWith(`${root.replace(/\/$/, "")}/`) ? path.slice(root.replace(/\/$/, "").length + 1) : path;
const PREF_KEY = "apex-deck.files-tab.v1";
type Context = { row: Row; x: number; y: number } | null;
export function changedSet(diff: ThreadDiff | null, root: string): Set<string> { return new Set(changeMarks(diff, root).keys()); }
export function FilesError({ onRetry }: { onRetry: () => void }) { return <div className="right-panel-empty"><p className="muted">Can&apos;t read this folder.</p><button onClick={onRetry}>Retry</button></div>; }

export function RightFiles({ root, list, diff, onOpen, backend = null, local = true, paneId = null, onRefresh, visible = true }: { root: string | null; list: (path: string) => Promise<FolderListing>; diff: ThreadDiff | null; onOpen: (path: string) => void; backend?: Backend | null; local?: boolean; paneId?: string | null; onRefresh?: () => void; visible?: boolean }) {
  const [tree, setTree] = useState<FilesTree>(() => createTree(root ?? ""));
  const [changedOnly, setChangedOnly] = useState(false), [showHidden, setShowHidden] = useState(false);
  const [changesOpen, setChangesOpen] = useState(true), [context, setContext] = useState<Context>(null), [copied, setCopied] = useState("");
  const listRef = useRef(list); listRef.current = list;
  const wasVisible = useRef(false);
  const treeRef = useRef(tree); treeRef.current = tree;
  const marks = useMemo(() => changeMarks(diff, root ?? ""), [diff, root]);
  const rows = useMemo(() => visibleRows(tree, { changes: marks, changedOnly, showHidden }), [tree, marks, changedOnly, showHidden]);
  const rootRef = useRef(root); rootRef.current = root;
  const load = useCallback((path: string) => {
    setTree((current) => ({ ...current, entries: new Map(current.entries).set(path, { state: "loading" }) }));
    void listRef.current(path).then((listing) => setTree((current) => current.root === rootRef.current ? ({ ...current, entries: new Map(current.entries).set(path, { state: "ready", listing }) }) : current), (error) => setTree((current) => current.root === rootRef.current ? ({ ...current, entries: new Map(current.entries).set(path, { state: "error", message: String(error) }) }) : current));
  }, []);
  useEffect(() => {
    if (!root) return;
    let prefs: ReturnType<typeof parseFilesPrefs> = {};
    try { prefs = parseFilesPrefs(localStorage.getItem(PREF_KEY)); } catch { /* storage can be disabled */ }
    const saved = prefs[root];
    const next = createTree(root); if (saved) next.expanded = new Set([root, ...saved.expanded]);
    setTree(next); setChangedOnly(saved?.changedOnly ?? false); setShowHidden(saved?.showHidden ?? false);
    for (const path of next.expanded) load(path);
  }, [root, load]);
  useEffect(() => {
    if (!changedOnly) return;
    for (const path of marks.keys()) {
      if (!path.startsWith(`${root?.replace(/\/$/, "")}/`)) continue;
      const rel = path.slice(root!.replace(/\/$/, "").length + 1).split("/");
      let parent = root!;
      for (const part of rel.slice(0, -1)) { parent = join(parent, part); if (tree.entries.get(parent)?.state !== "ready") load(parent); }
    }
  }, [changedOnly, marks, root, load]);
  useEffect(() => {
    if (visible && wasVisible.current) for (const path of tree.expanded) load(path);
    wasVisible.current = visible;
  }, [visible, load]);
  useEffect(() => {
    if (!root) return;
    try {
      const all = parseFilesPrefs(localStorage.getItem(PREF_KEY));
      all[root] = { expanded: [...tree.expanded].filter((path) => path !== root), changedOnly, showHidden };
      const recent = Object.fromEntries(Object.entries(all).filter(([key]) => key !== root).slice(-19));
      localStorage.setItem(PREF_KEY, JSON.stringify({ ...recent, [root]: all[root] }));
    } catch { /* storage can be disabled */ }
  }, [root, tree.expanded, changedOnly, showHidden]);
  useEffect(() => { if (context) { const close = () => setContext(null); window.addEventListener("click", close); return () => window.removeEventListener("click", close); } }, [context]);
  if (!root) return <p className="muted right-panel-empty">This project has no folder.</p>;
  const openFolder = (path: string) => { const wasOpen = tree.expanded.has(path); setTree((current) => toggle(current, path)); if (!wasOpen) load(path); };
  const refresh = () => { for (const path of tree.expanded) load(path); };
  const copy = async (text: string, what: string) => { const ok = await writeClipboard(text, navigator.clipboard); setCopied(ok ? `${what} copied` : "Clipboard unavailable"); window.setTimeout(() => setCopied(""), 1600); };
  const addToChat = (path: string) => { if (paneId) window.dispatchEvent(new CustomEvent("deck:insert-composer", { detail: { paneId, text: `\`${relative(root, path)}\`` } })); };
  const contextActions = context ? [
    { label: "Open", action: () => onOpen(context.row.path), show: !context.row.folder },
    { label: "Open in default app", action: () => void backend?.openTarget(context.row.path, root, false), show: local },
    { label: "Reveal in Finder", action: () => void backend?.openTarget(context.row.path, root, true), show: local },
    { label: "Copy relative path", action: () => void copy(relative(root, context.row.path), "Path"), show: true },
    { label: "Copy full path", action: () => void copy(context.row.path, "Path"), show: true },
    { label: "Copy file name", action: () => void copy(context.row.name, "Name"), show: true },
    { label: "Add to chat", action: () => addToChat(context.row.path), show: !!paneId },
    { label: "Show changes", action: () => onOpen(context.row.path), show: !!context.row.changed },
    { label: "Collapse inside", action: () => setTree((current) => ({ ...current, expanded: new Set([...current.expanded].filter((path) => !path.startsWith(`${context.row.path}/`))) })), show: context.row.folder },
  ].filter((item) => item.show) : [];
  const activateKey = (event: React.KeyboardEvent) => {
    if (event.key === "Enter") {
      event.preventDefault(); const row = rows.find((item) => item.path === tree.selected);
      if (row) row.folder ? openFolder(row.path) : onOpen(row.path);
      return;
    }
    if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault(); const next = moveSelection(rows, tree.selected, event.key as "ArrowUp");
    let selection = next.selected;
    if (next.action === "expand" && next.selected) {
      if (tree.expanded.has(next.selected)) selection = rows.find((row) => row.depth === (rows.find((item) => item.path === next.selected)?.depth ?? -1) + 1 && row.path.startsWith(`${next.selected}/`))?.path ?? next.selected;
      else openFolder(next.selected);
    } else if (next.action === "collapse" && next.selected) {
      if (tree.expanded.has(next.selected)) setTree((current) => toggle(current, next.selected!));
      else { const currentIndex = rows.findIndex((row) => row.path === next.selected); selection = rows.slice(0, currentIndex).reverse().find((row) => row.folder && next.selected!.startsWith(`${row.path}/`))?.path ?? next.selected; }
    }
    setTree((current) => ({ ...current, selected: selection }));
    requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-file-path="${CSS.escape(selection ?? "")}"]`)?.focus());
  };
  const fileRow = (row: Row, index: number) => {
    if (row.truncated) return <li key={`${row.path}:truncated`} className="muted right-files-loading">More files not shown.</li>;
    return <li key={row.path} role="treeitem" aria-level={row.depth + 1} aria-expanded={row.folder ? tree.expanded.has(row.path) : undefined}>
      <button type="button" className={`right-files-item${row.changed ? " changed" : ""}${tree.selected === row.path ? " selected" : ""}`} style={{ paddingLeft: `${6 + row.depth * 14}px` }} tabIndex={tree.selected === row.path || (!tree.selected && index === 0) ? 0 : -1} data-file-path={row.path} draggable={!row.loading && !row.error} onDragStart={(event) => { event.dataTransfer.setData("text/plain", relative(root, row.path)); }} onFocus={() => setTree((current) => ({ ...current, selected: row.path }))} onContextMenu={(event) => { event.preventDefault(); setContext({ row, x: event.clientX, y: event.clientY }); }} onDoubleClick={() => { if (!row.folder && local) void backend?.openTarget(row.path, root, false); }} onClick={(event) => { if (event.altKey && local) void backend?.openTarget(row.path, root, false); else row.folder ? openFolder(row.path) : onOpen(row.path); }} title={row.path}>
        <span aria-hidden="true" className="right-files-disclosure">{row.folder ? (tree.expanded.has(row.path) ? "▾" : "▸") : ""}</span><span className="right-files-name">{row.name}</span>{row.hasChangedInside && <span className="right-files-dot" aria-label="Changes inside"/>}{row.changed && <span className={`right-files-mark mark-${row.changed}`} aria-label={row.changed}>{row.changed}</span>}{row.loading && <span className="muted">Loading…</span>}{row.error && <span className="muted">Error · retry</span>}<span className="right-files-more" onClick={(event) => { event.stopPropagation(); const rect = (event.currentTarget as HTMLElement).getBoundingClientRect(); setContext({ row, x: rect.left, y: rect.bottom }); }} aria-label={`More actions for ${row.name}`}>⋯</span>
      </button>
    </li>;
  };
  return <div className="right-files-shell"><div className="right-files-toolbar"><button title="Refresh files" aria-label="Refresh files" onClick={() => { refresh(); onRefresh?.(); }}>↻</button><button title="Collapse all folders" aria-label="Collapse all folders" onClick={() => setTree((current) => collapseAll(current))}>⊟</button><button aria-pressed={changedOnly} onClick={() => setChangedOnly((value) => !value)}>Changed only</button><button aria-pressed={showHidden} onClick={() => setShowHidden((value) => !value)}>Show hidden</button><span className="muted" role="status">{copied}</span></div>
    {marks.size > 0 && <section className="right-files-changes"><button className="right-files-section-toggle" aria-expanded={changesOpen} onClick={() => setChangesOpen((value) => !value)}>Changed in this thread <span>{marks.size}</span><span>{changesOpen ? "▾" : "▸"}</span></button>{changesOpen && <ul>{(diff?.files ?? []).map((file) => { const path = file.path.startsWith("/") ? file.path : join(root, file.path); const mark = marks.get(path)!; return <li key={path}><button className={`right-files-change mark-${mark}`} onClick={() => onOpen(path)}><span>{mark}</span><span className={mark === "D" ? "right-files-deleted" : ""}>{relative(root, path)}</span><small>+{file.added} −{file.removed}</small></button></li>; })}</ul>}</section>}
    <ul className="right-files" role="tree" aria-label="Files" onKeyDown={activateKey}>{rows.map(fileRow)}</ul>
    {context && <div className="right-files-context" role="menu" aria-label={`${context.row.name} actions`} style={{ left: context.x, top: context.y }} onClick={(event) => event.stopPropagation()}>{contextActions.map((item) => <button role="menuitem" key={item.label} onClick={() => { setContext(null); item.action(); }}>{item.label}</button>)}</div>}
  </div>;
}

export function RightFilesTab({ root, backend, threadId, visible, onOpen, local = true, paneId = null }: { root: string | null; backend: Backend | null; threadId: string | null; visible: boolean; onOpen: (path: string) => void; local?: boolean; paneId?: string | null }) {
  const [diff, setDiff] = useState<ThreadDiff | null>(null);
  const refreshDiff = useCallback(() => { if (!visible || !threadId || !backend) { setDiff(null); return; } let live = true; void backend.roomDiff(threadId).then((value) => { if (live) setDiff(value); }, () => { if (live) setDiff(null); }); return () => { live = false; }; }, [visible, threadId, backend]);
  useEffect(() => refreshDiff(), [refreshDiff]);
  if (!backend) return <p className="muted right-panel-empty">This project machine is unavailable.</p>;
  return <RightFiles root={root} list={(path) => backend.listFolder(path)} diff={diff} onOpen={onOpen} backend={backend} local={local} paneId={paneId} visible={visible} onRefresh={() => { refreshDiff(); }} />;
}
