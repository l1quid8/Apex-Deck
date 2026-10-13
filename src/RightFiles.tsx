import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FileSearchResult, FolderListing, ThreadDiff } from "./types";
import type { Backend } from "./backend";
import { changeMarks, collapseAll, createTree, moveSelection, parseFilesPrefs, revealPath as modelRevealPath, toggle, visibleRows, type FilesTree, type Row } from "./filesTreeModel";
import { writeClipboard } from "./threadCopy";
import { FilePreviewPanel } from "./FilePreview";
import { createPortal } from "react-dom";
import { ConfirmDialog, type Question } from "./ConfirmDialog";

const join = (dir: string, name: string) => `${dir.replace(/\/$/, "")}/${name}`;
const relative = (root: string, path: string) => path === root ? "." : path.startsWith(`${root.replace(/\/$/, "")}/`) ? path.slice(root.replace(/\/$/, "").length + 1) : path;
const PREF_KEY = "apex-deck.files-tab.v1";
type Context = { row: Row; x: number; y: number } | null;
type FindMode = "name" | "text";
type FileOperation = { kind: "create-file" | "create-folder" | "rename"; path: string; name: string } | null;
export function changedSet(diff: ThreadDiff | null, root: string): Set<string> { return new Set(changeMarks(diff, root).keys()); }
export function FilesError({ onRetry }: { onRetry: () => void }) { return <div className="right-panel-empty"><p className="muted">Can&apos;t read this folder.</p><button onClick={onRetry}>Retry</button></div>; }

export function RightFiles({ root, list, diff, onOpen, backend = null, local = true, paneId = null, onRefresh, visible = true }: { root: string | null; list: (path: string) => Promise<FolderListing>; diff: ThreadDiff | null; onOpen: (path: string) => void; backend?: Backend | null; local?: boolean; paneId?: string | null; onRefresh?: () => void; visible?: boolean }) {
  const [tree, setTree] = useState<FilesTree>(() => createTree(root ?? ""));
  const [changedOnly, setChangedOnly] = useState(false), [showHidden, setShowHidden] = useState(false);
  const [previewPath, setPreviewPath] = useState<string | null>(null), [previewHeight, setPreviewHeight] = useState(280), [previewView, setPreviewView] = useState<"file" | "changes">("file");
  const [searchHighlightLine, setSearchHighlightLine] = useState<number | null>(null);
  const [findOpen, setFindOpen] = useState(false), [findMode, setFindMode] = useState<FindMode>("name"), [findQuery, setFindQuery] = useState("");
  const [nameResults, setNameResults] = useState<string[] | null>(null), [textResults, setTextResults] = useState<FileSearchResult | null>(null);
  const [searchFolder, setSearchFolder] = useState<string | null>(null), [caseSensitive, setCaseSensitive] = useState(false), [searchLoading, setSearchLoading] = useState(false), [searchError, setSearchError] = useState("");
  const [changesOpen, setChangesOpen] = useState(true), [context, setContext] = useState<Context>(null), [copied, setCopied] = useState("");
  const [operation, setOperation] = useState<FileOperation>(null), [operationError, setOperationError] = useState("");
  const [previewDirty, setPreviewDirty] = useState(false), [leaveQuestion, setLeaveQuestion] = useState<Question | null>(null);
  const [treeWidth, setTreeWidth] = useState(280), [wide, setWide] = useState(false);
  const listRef = useRef(list); listRef.current = list;
  const wasVisible = useRef(false);
  const treeRef = useRef(tree); treeRef.current = tree;
  const findRequest = useRef(0), findInput = useRef<HTMLInputElement>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  const marks = useMemo(() => changeMarks(diff, root ?? ""), [diff, root]);
  const rows = useMemo(() => visibleRows(tree, { changes: marks, changedOnly, showHidden }), [tree, marks, changedOnly, showHidden]);
  const rootRef = useRef(root); rootRef.current = root;
  const load = useCallback((path: string) => {
    const owner = rootRef.current;
    setTree((current) => current.root === owner ? ({ ...current, entries: new Map(current.entries).set(path, { state: "loading" }) }) : current);
    void listRef.current(path).then((listing) => setTree((current) => current.root === owner ? ({ ...current, entries: new Map(current.entries).set(path, { state: "ready", listing }) }) : current), (error) => setTree((current) => current.root === owner ? ({ ...current, entries: new Map(current.entries).set(path, { state: "error", message: String(error) }) }) : current));
  }, []);
  useEffect(() => {
    if (!root) return;
    let prefs: ReturnType<typeof parseFilesPrefs> = {};
    try { prefs = parseFilesPrefs(localStorage.getItem(PREF_KEY)); } catch { /* storage can be disabled */ }
    const saved = prefs[root];
    const next = createTree(root); if (saved) next.expanded = new Set([root, ...saved.expanded]);
    setTree(next); setChangedOnly(saved?.changedOnly ?? false); setShowHidden(saved?.showHidden ?? false); setPreviewHeight(saved?.previewHeight ?? 280); setTreeWidth(saved?.treeWidth ?? 280); setPreviewPath(null);
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
    const request = ++findRequest.current;
    if (!findOpen || findMode !== "name" || !findQuery.trim()) { setNameResults(null); setSearchLoading(false); return; }
    setTextResults(null); setSearchError(""); setSearchLoading(true);
    const timer = window.setTimeout(() => {
      if (!backend) { setSearchLoading(false); setSearchError("This project machine is unavailable."); return; }
      void backend.fileFind(root ?? "", findQuery).then((paths) => { if (findRequest.current === request) { setNameResults(paths); setSearchLoading(false); } }, (error) => { if (findRequest.current === request) { setSearchError(String(error)); setSearchLoading(false); } });
    }, 150);
    return () => { window.clearTimeout(timer); if (findRequest.current === request) findRequest.current++; };
  }, [backend, findMode, findOpen, findQuery, root]);
  useEffect(() => {
    if (visible && wasVisible.current) for (const path of tree.expanded) load(path);
    wasVisible.current = visible;
  }, [visible, load]);
  useEffect(() => {
    if (!root) return;
    try {
      const all = parseFilesPrefs(localStorage.getItem(PREF_KEY));
      all[root] = { expanded: [...tree.expanded].filter((path) => path !== root), changedOnly, showHidden, previewHeight, treeWidth };
      const recent = Object.fromEntries(Object.entries(all).filter(([key]) => key !== root).slice(-19));
      localStorage.setItem(PREF_KEY, JSON.stringify({ ...recent, [root]: all[root] }));
    } catch { /* storage can be disabled */ }
  }, [root, tree.expanded, changedOnly, showHidden, previewHeight, treeWidth]);
  useEffect(() => {
    const el = shellRef.current; if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => setWide(entry.contentRect.width >= 720));
    observer.observe(el); return () => observer.disconnect();
  }, [root]);
  useEffect(() => { if (context) { const close = () => setContext(null); window.addEventListener("click", close); return () => window.removeEventListener("click", close); } }, [context]);
  if (!root) return <p className="muted right-panel-empty">This project has no folder.</p>;
  const openFolder = (path: string) => { const wasOpen = tree.expanded.has(path); setTree((current) => toggle(current, path)); if (!wasOpen) load(path); };
  const refresh = () => { for (const path of tree.expanded) load(path); };
  const copy = async (text: string, what: string) => { const ok = await writeClipboard(text, navigator.clipboard); setCopied(ok ? `${what} copied` : "Clipboard unavailable"); window.setTimeout(() => setCopied(""), 1600); };
  const addToChat = (path: string) => { if (paneId) window.dispatchEvent(new CustomEvent("deck:insert-composer", { detail: { paneId, text: `\`${relative(root, path)}\`` } })); };
  /** Runs `action` now, or after the user agrees to drop unsaved edits in the open preview. */
  const confirmLeave = (action: () => void) => {
    if (!previewDirty || !previewPath) { action(); return; }
    setLeaveQuestion({ title: `Discard unsaved changes to ${previewPath.split("/").pop()}?`, body: "Your edits to this file haven't been saved.", action: "Discard", onConfirm: () => { setPreviewDirty(false); action(); } });
  };
  const openPreviewNow = (path: string, changes = false, line: number | null = null) => { setPreviewPath(path); setPreviewView(changes ? "changes" : "file"); setSearchHighlightLine(line); };
  const openPreview = (path: string, changes = false, line: number | null = null) => {
    if (path === previewPath && !changes) openPreviewNow(path, changes, line); else confirmLeave(() => openPreviewNow(path, changes, line));
  };
  const touchesPreview = (path: string) => !!previewPath && (previewPath === path || previewPath.startsWith(`${path}/`));
  const beginOperation = (kind: NonNullable<FileOperation>["kind"], path = root ?? "") => {
    const name = kind === "rename" ? path.split(/[\\/]/).pop() ?? "" : "";
    setOperation({ kind, path: kind === "rename" ? path : path || root || "", name }); setOperationError(""); setContext(null);
  };
  const submitOperation = async (event: React.FormEvent) => {
    event.preventDefault(); if (!operation || !backend) return;
    if (operation.kind === "rename" && touchesPreview(operation.path) && previewDirty) { confirmLeave(() => void runOperation(operation)); return; }
    void runOperation(operation);
  };
  const runOperation = async (operation: NonNullable<FileOperation>) => {
    if (!backend) return;
    try {
      if (operation.kind === "create-file" || operation.kind === "create-folder") {
        const path = await backend.fileCreate(root ?? "", operation.path, operation.name, operation.kind === "create-folder");
        const parent = operation.path; setTree((current) => ({ ...current, expanded: new Set([...current.expanded, parent]) })); load(parent); setTree((current) => ({ ...current, selected: path }));
      } else {
        const path = await backend.fileRename(root ?? "", operation.path, operation.name);
        if (previewPath === operation.path) { setPreviewDirty(false); setPreviewPath(path); }
        const parent = operation.path.slice(0, operation.path.lastIndexOf("/")) || root!; load(parent);
      }
      setOperation(null); setOperationError("");
    } catch (error) { setOperationError(String(error)); }
  };
  const duplicateFile = async (path: string) => {
    if (!backend) return;
    try { const copiedPath = await backend.fileDuplicate(root ?? "", path); const parent = copiedPath.slice(0, copiedPath.lastIndexOf("/")) || root!; load(parent); setCopied("File duplicated"); }
    catch (error) { setOperationError(String(error)); }
  };
  const trashPath = async (path: string) => {
    if (!backend || !window.confirm(`Move ${relative(root, path)} to Trash?${previewDirty && touchesPreview(path) ? " Unsaved changes in the open file will be lost." : ""}`)) return;
    try { await backend.fileTrash(root ?? "", path); if (touchesPreview(path)) { setPreviewDirty(false); setPreviewPath(null); } const parent = path.slice(0, path.lastIndexOf("/")) || root!; load(parent); setCopied("Moved to Trash"); }
    catch (error) { setOperationError(String(error)); }
  };
  const showFind = (mode: FindMode = "name", folder: string | null = null) => { setFindOpen(true); setFindMode(mode); setSearchFolder(folder); setFindQuery(""); setNameResults(null); setTextResults(null); setSearchError(""); requestAnimationFrame(() => findInput.current?.focus()); };
  const revealSearchResult = (path: string, line: number | null = null) => {
    const fullPath = path.startsWith(`${root.replace(/\/$/, "")}/`) ? path : join(root, path);
    const revealed = modelRevealPath(tree, fullPath); setTree(revealed.tree); for (const folder of revealed.needs) load(folder);
    setFindOpen(false); openPreview(fullPath, false, line);
  };
  const runTextSearch = () => {
    const request = ++findRequest.current;
    if (!backend) { setSearchError("This project machine is unavailable."); return; }
    setSearchLoading(true); setSearchError(""); setTextResults(null);
    void backend.fileSearch(root, findQuery, caseSensitive, searchFolder).then((result) => { if (findRequest.current === request) { setTextResults(result); setSearchLoading(false); } }, (error) => { if (findRequest.current === request) { setSearchError(String(error)); setSearchLoading(false); } });
  };
  const contextActions = context ? [
    { label: "Open", action: () => openPreview(context.row.path), show: !context.row.folder },
    { label: "Open in default app", action: () => void backend?.openTarget(context.row.path, root, false), show: local },
    { label: "Reveal in Finder", action: () => void backend?.openTarget(context.row.path, root, true), show: local },
    { label: "Copy relative path", action: () => void copy(relative(root, context.row.path), "Path"), show: true },
    { label: "Copy full path", action: () => void copy(context.row.path, "Path"), show: true },
    { label: "Copy file name", action: () => void copy(context.row.name, "Name"), show: true },
    { label: "Add to chat", action: () => addToChat(context.row.path), show: !!paneId },
    { label: "Show changes", action: () => openPreview(context.row.path, true), show: !!context.row.changed },
    { label: "Collapse inside", action: () => setTree((current) => ({ ...current, expanded: new Set([...current.expanded].filter((path) => !path.startsWith(`${context.row.path}/`))) })), show: context.row.folder },
    { label: "Find in folder…", action: () => showFind("text", context.row.path), show: context.row.folder },
    { label: "New file…", action: () => beginOperation("create-file", context.row.folder ? context.row.path : context.row.path.slice(0, context.row.path.lastIndexOf("/")) || root!), show: true },
    { label: "New folder…", action: () => beginOperation("create-folder", context.row.folder ? context.row.path : context.row.path.slice(0, context.row.path.lastIndexOf("/")) || root!), show: true },
    { label: "Rename…", action: () => beginOperation("rename", context.row.path), show: !context.row.truncated && context.row.path !== root },
    { label: "Duplicate", action: () => void duplicateFile(context.row.path), show: !context.row.folder },
    { label: "Move to Trash…", action: () => void trashPath(context.row.path), show: context.row.path !== root },
  ].filter((item) => item.show) : [];
  const activateKey = (event: React.KeyboardEvent) => {
    if (event.key === "F2" && tree.selected) { event.preventDefault(); beginOperation("rename", tree.selected); return; }
    if ((event.metaKey || event.ctrlKey) && event.key === "Backspace" && tree.selected) { event.preventDefault(); void trashPath(tree.selected); return; }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "c" && tree.selected) {
      event.preventDefault(); void copy(relative(root, tree.selected), "Path"); return;
    }
    if (event.key === "Enter") {
      event.preventDefault(); const row = rows.find((item) => item.path === tree.selected);
      if (row) row.folder ? openFolder(row.path) : openPreview(row.path);
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
      <button type="button" className={`right-files-item${row.changed ? " changed" : ""}${tree.selected === row.path ? " selected" : ""}`} style={{ paddingLeft: `${6 + row.depth * 14}px` }} tabIndex={tree.selected === row.path || (!tree.selected && index === 0) ? 0 : -1} data-file-path={row.path} draggable={!row.loading && !row.error} onDragStart={(event) => { event.dataTransfer.setData("text/plain", relative(root, row.path)); }} onFocus={() => setTree((current) => ({ ...current, selected: row.path }))} onContextMenu={(event) => { event.preventDefault(); setContext({ row, x: event.clientX, y: event.clientY }); }} onDoubleClick={() => { if (!row.folder && local) onOpen(row.path); }} onClick={(event) => { if (row.error) load(row.path); else if (event.altKey && local) onOpen(row.path); else row.folder ? openFolder(row.path) : openPreview(row.path); }} title={row.error ? `${row.path} · Click to retry` : row.path}>
        <span aria-hidden="true" className="right-files-disclosure">{row.folder ? (tree.expanded.has(row.path) ? "▾" : "▸") : ""}</span><span className="right-files-name">{row.name}</span>{row.hasChangedInside && <span className="right-files-dot" aria-label="Changes inside"/>}{row.changed && <span className={`right-files-mark mark-${row.changed}`} aria-label={row.changed}>{row.changed}</span>}{row.loading && <span className="muted">Loading…</span>}{row.error && <span className="muted">Error · retry</span>}<span className="right-files-more" onClick={(event) => { event.stopPropagation(); const rect = (event.currentTarget as HTMLElement).getBoundingClientRect(); setContext({ row, x: rect.left, y: rect.bottom }); }} aria-label={`More actions for ${row.name}`}>⋯</span>
      </button>
    </li>;
  };
  return <div ref={shellRef} className={`right-files-shell${wide ? " wide" : ""}`} onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") { event.preventDefault(); showFind(); } }}><div className="right-files-toolbar"><button type="button" title="Find files" aria-label="Find files" onClick={() => showFind()}>Find</button><button type="button" title="Refresh files" aria-label="Refresh files" onClick={() => { refresh(); onRefresh?.(); }}>↻</button><button type="button" title="Collapse all folders" aria-label="Collapse all folders" onClick={() => setTree((current) => collapseAll(current))}>⊟</button><button type="button" aria-pressed={changedOnly} onClick={() => setChangedOnly((value) => !value)}>Changed only</button><button type="button" aria-pressed={showHidden} onClick={() => setShowHidden((value) => !value)}>Show hidden</button><details className="right-files-toolbar-menu"><summary aria-label="File actions" title="File actions">⋯</summary><div className="right-files-context"><button onClick={() => beginOperation("create-file")}>New file…</button><button onClick={() => beginOperation("create-folder")}>New folder…</button></div></details><span className="muted" role="status">{copied}</span></div>{operationError && !operation && <p className="right-files-operation-error" role="alert">{operationError}<button onClick={() => setOperationError("")}>Dismiss</button></p>}
    {findOpen && <form className="right-files-find" aria-label="Find in project" onSubmit={(event) => { event.preventDefault(); if (findMode === "text") runTextSearch(); else if (nameResults?.[0]) revealSearchResult(nameResults[0]); }}>
      <div className="right-files-find-modes"><button type="button" aria-pressed={findMode === "name"} onClick={() => { setFindMode("name"); setTextResults(null); }}>Name</button><button type="button" aria-pressed={findMode === "text"} onClick={() => { setFindMode("text"); setNameResults(null); }}>Text</button><button type="button" aria-label="Close find" title="Close find" onClick={() => { setFindOpen(false); setFindQuery(""); setSearchFolder(null); }}>×</button></div>
      <div className="right-files-find-input"><input ref={findInput} aria-label={findMode === "name" ? "Find files by name" : "Search text in files"} placeholder={findMode === "name" ? "Find files by name…" : "Search text in files…"} value={findQuery} onChange={(event) => { setFindQuery(event.target.value); setTextResults(null); setSearchError(""); }} />{findMode === "text" && <button type="button" aria-pressed={caseSensitive} title="Match case" aria-label="Match case" onClick={() => setCaseSensitive((value) => !value)}>Aa</button>}{findMode === "text" && <button type="submit" disabled={!findQuery.trim() || searchLoading} aria-label="Search project">Search</button>}</div>
      {searchFolder && <button type="button" className="right-files-search-scope" onClick={() => setSearchFolder(null)} title="Remove folder scope">In {relative(root, searchFolder)} ×</button>}
      {searchError && <p className="right-files-search-status" role="alert">{searchError}</p>}{searchLoading && <p className="right-files-search-status muted" role="status">Searching…</p>}
    </form>}
    <div className="right-files-body"><div className="right-files-browser" style={wide ? (previewPath ? { width: treeWidth } : undefined) : previewPath ? { height: `calc(100% - ${previewHeight + 9}px)`, flex: "0 0 auto" } : { flex: "1 1 auto" }}>
      {marks.size > 0 && <section className="right-files-changes"><button className="right-files-section-toggle" aria-expanded={changesOpen} onClick={() => setChangesOpen((value) => !value)}>Changed in this thread <span>{marks.size}</span><span>{changesOpen ? "▾" : "▸"}</span></button>{changesOpen && <ul>{(diff?.files ?? []).map((file) => { const path = file.path.startsWith("/") ? file.path : join(root, file.path); const mark = marks.get(path)!; return <li key={path}><button className={`right-files-change mark-${mark}`} onClick={() => openPreview(path, true)}><span>{mark}</span><span className={mark === "D" ? "right-files-deleted" : ""}>{relative(root, path)}</span><small>+{file.added} −{file.removed}</small></button></li>; })}</ul>}</section>}
      {findOpen ? <div className="right-files-find-results" aria-live="polite">
        {findMode === "name" && nameResults?.map((path) => <button key={path} className="right-files-find-name" onClick={() => revealSearchResult(path)}><strong>{path.split("/").pop()}</strong><span className="muted">{path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "Project root"}</span></button>)}
        {findMode === "name" && nameResults?.length === 0 && !searchLoading && !searchError && <p className="muted right-files-search-status">No matching files.</p>}
        {findMode === "text" && textResults && <TextSearchResults result={textResults} query={findQuery} onOpen={(path, line) => revealSearchResult(path, line)} />}
      </div> : <ul className="right-files" role="tree" aria-label="Files" onKeyDown={activateKey}>{rows.map(fileRow)}</ul>}
    </div>
    {previewPath && wide && <div className="right-files-resize-v" role="separator" aria-orientation="vertical" aria-label="Resize file tree" onPointerDown={(event) => { const start = event.clientX, width = treeWidth; const move = (next: PointerEvent) => setTreeWidth(Math.max(180, Math.min(600, width + next.clientX - start))); const end = () => window.removeEventListener("pointermove", move); window.addEventListener("pointermove", move); window.addEventListener("pointerup", end, { once: true }); }} />}
    {previewPath && <><div className="right-files-resize" role="separator" aria-orientation="horizontal" aria-label="Resize file preview" onPointerDown={(event) => { const start = event.clientY, height = previewHeight; const move = (next: PointerEvent) => setPreviewHeight(Math.max(160, Math.min(Math.floor(window.innerHeight * .7), height + start - next.clientY))); const end = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", end); }; window.addEventListener("pointermove", move); window.addEventListener("pointerup", end, { once: true }); }} /><div className="right-files-preview-slot" style={{ height: previewHeight, minHeight: 160, flex: "0 0 auto" }}><FilePreviewPanel key={previewPath} root={root} path={previewPath} backend={backend ?? ({ fileRead: async () => { throw new Error("Preview unavailable"); }, openTarget: async () => { throw new Error("Open unavailable"); } } as unknown as Backend)} diff={diff} local={local} paneId={paneId} view={previewView} onView={(next) => next === "file" ? setPreviewView(next) : confirmLeave(() => setPreviewView(next))} onClose={() => confirmLeave(() => setPreviewPath(null))} highlightLine={searchHighlightLine} onDirtyChange={setPreviewDirty} onSaved={() => onRefresh?.()} /></div></>}</div>
    {context && <div className="right-files-context" role="menu" aria-label={`${context.row.name} actions`} style={{ left: context.x, top: context.y }} onClick={(event) => event.stopPropagation()}>{contextActions.map((item) => <button role="menuitem" key={item.label} onClick={() => { setContext(null); item.action(); }}>{item.label}</button>)}</div>}
    {leaveQuestion && createPortal(<ConfirmDialog question={leaveQuestion} onCancel={() => setLeaveQuestion(null)} />, document.body)}
    {operation && <div className="right-files-operation-backdrop"><form className="right-files-operation" role="dialog" aria-modal="true" aria-labelledby="right-files-operation-title" onSubmit={submitOperation}><h3 id="right-files-operation-title">{operation.kind === "rename" ? "Rename" : operation.kind === "create-file" ? "New file" : "New folder"}</h3><label>Name<input autoFocus value={operation.name} onChange={(event) => setOperation({ ...operation, name: event.target.value })} /></label>{operationError && <p role="alert">{operationError}</p>}<div><button type="button" onClick={() => setOperation(null)}>Cancel</button><button type="submit" disabled={!operation.name.trim()}>Save</button></div></form></div>}
  </div>;
}

export function RightFilesTab({ root, backend, threadId, visible, onOpen, local = true, paneId = null }: { root: string | null; backend: Backend | null; threadId: string | null; visible: boolean; onOpen: (path: string) => void; local?: boolean; paneId?: string | null }) {
  const [diff, setDiff] = useState<ThreadDiff | null>(null);
  const refreshDiff = useCallback(() => { if (!visible || !threadId || !backend) return; void backend.roomDiff(threadId).then(setDiff, () => setDiff(null)); }, [visible, threadId, backend]);
  useEffect(() => {
    if (!visible || !threadId || !backend) { setDiff(null); return; }
    let live = true;
    void backend.roomDiff(threadId).then((value) => { if (live) setDiff(value); }, () => { if (live) setDiff(null); });
    return () => { live = false; };
  }, [visible, threadId, backend]);
  if (!backend) return <p className="muted right-panel-empty">This project machine is unavailable.</p>;
  return <RightFiles root={root} list={(path) => backend.listFolder(path)} diff={diff} onOpen={onOpen} backend={backend} local={local} paneId={paneId} visible={visible} onRefresh={() => { refreshDiff(); }} />;
}

function TextSearchResults({ result, query, onOpen }: { result: FileSearchResult; query: string; onOpen(path: string, line: number): void }) {
  const groups = new Map<string, FileSearchResult["hits"]>();
  for (const hit of result.hits) groups.set(hit.path, [...(groups.get(hit.path) ?? []), hit]);
  return <div className="right-files-search-groups">
    {groups.size === 0 && !result.truncated && <p className="muted right-files-search-status">No matches.</p>}
    {[...groups.entries()].map(([path, hits]) => <section className="right-files-search-group" key={path}>
      <h4>{path} · {hits.length}</h4>
      {hits.map((hit, index) => <button className="right-files-search-hit" key={`${path}:${hit.line}:${index}`} onClick={() => onOpen(path, hit.line)}><span>{hit.line}:</span><span>{highlightMatch(hit.text, query)}</span></button>)}
    </section>)}
    {result.truncated && <p className="muted right-files-search-status">Showing the first 500 matches.</p>}
  </div>;
}

function highlightMatch(text: string, query: string) {
  const index = text.toLowerCase().indexOf(query.toLowerCase());
  if (index < 0 || !query) return text;
  return <>{text.slice(0, index)}<mark>{text.slice(index, index + query.length)}</mark>{text.slice(index + query.length)}</>;
}
