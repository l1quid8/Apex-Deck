import { useEffect, useRef, useState } from "react";
import type { Backend, LibraryItem } from "./backend";
import { ConfirmDialog, type Question } from "./ConfirmDialog";
import { botsIn, filterLibrary, isVideoItem, itemKey, listLibrary, loadOutcome, machineNote, threadExists, workspacesIn, workspaceForRoom, type LibraryFilter, type LibraryThread, type MachineItem, type MachineLoad } from "./library";
import { videoType } from "./attachments";
import type { Workspace } from "./types";

/** A machine whose Library is shown: this Mac ("local") or a saved server. */
export interface LibraryMachine {
  id: string;
  name: string;
  /** Already known to be unreachable, so it isn't asked. */
  offline: boolean;
}

interface Props {
  machines: LibraryMachine[];
  /** A machine's backend; asking for a server's connects to it. */
  backendOf: (machine: string) => Backend | null;
  /** Threads on the deck, with the workspace each is in. */
  threads: LibraryThread[];
  workspaces: Workspace[];
  /** Go to a thread. Only offered while the thread is still on the deck. */
  onOpenThread: (room: string) => void;
}

/** How long a server gets to connect and list its pictures before it counts as offline. */
const LIST_WAIT_MS = 20000;

/** Every picture the bots made on every machine, with filters, a larger view, and delete. */
export function LibraryView({ machines, backendOf, threads, workspaces, onOpenThread }: Props) {
  const [items, setItems] = useState<MachineItem[]>([]);
  const [loads, setLoads] = useState<Record<string, MachineLoad>>({});
  const [filter, setFilter] = useState<LibraryFilter>({ bot: null, workspace: null, machine: null });
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<"newest" | "oldest" | "name">("newest");
  const [layout, setLayout] = useState<"gallery" | "list">("gallery");
  const [viewing, setViewing] = useState<MachineItem | null>(null);
  const [question, setQuestion] = useState<Question | null>(null);
  const [error, setError] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");
  const [renameError, setRenameError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const live = useRef(0);

  const nameOf = (id: string) => machines.find((m) => m.id === id)?.name ?? id;
  const backendFor = (id: string) => { try { return backendOf(id); } catch { return null; } };

  /** Reload every machine's list. Runs each time the tab opens. Pictures show as each machine answers. */
  const load = () => {
    const run = ++live.current;
    setItems([]);
    setLoads({});
    let left = machines.length;
    const done = () => { if (--left <= 0 && run === live.current) setLoaded(true); };
    if (left === 0) setLoaded(true);
    for (const machine of machines) {
      const settle = (load: MachineLoad, list: LibraryItem[] = []) => {
        if (run !== live.current) return;
        setLoads((all) => ({ ...all, [machine.id]: load }));
        if (list.length) setItems((all) => [...all.filter((i) => i.machine !== machine.id), ...list.map((i) => ({ ...i, machine: machine.id }))]);
        done();
      };
      const backend = machine.offline ? null : backendFor(machine.id);
      if (!backend) { settle({ kind: "offline" }); continue; }
      listLibrary(backend, LIST_WAIT_MS).then((list) => settle({ kind: "ok" }, list), (err) => settle(loadOutcome(err)));
    }
  };
  const machineIds = machines.map((m) => `${m.id}:${m.offline}`).join(",");
  useEffect(load, [machineIds]);

  const names = new Map(workspaces.map((w) => [w.id, w.name]));
  const bots = botsIn(items);
  const workspaceIds = workspacesIn(items, threads);
  const query = search.trim().toLocaleLowerCase();
  const shown = filterLibrary(items, filter, threads)
    .filter((item) => !query || `${item.name ?? ""} ${item.file}`.toLocaleLowerCase().includes(query))
    .sort((a, b) => sort === "name"
      ? (a.name ?? a.file).localeCompare(b.name ?? b.file, undefined, { sensitivity: "base", numeric: true })
      : sort === "newest" ? b.created - a.created : a.created - b.created);
  const navigate = (step: number) => {
    if (question || renaming || shown.length < 2) return;
    setViewing((current) => {
      if (!current) return current;
      const index = shown.findIndex((item) => itemKey(item) === itemKey(current));
      return index < 0 ? current : shown[(index + step + shown.length) % shown.length];
    });
  };
  useEffect(() => {
    if (!viewing || question || renaming || shown.length < 2) return;
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return;
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable || target.closest("input, textarea, select"))) return;
      event.preventDefault();
      event.stopPropagation();
      navigate(event.key === "ArrowRight" ? 1 : -1);
    };
    // Capture before media controls consume the same arrow press.
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [viewing, shown, question, renaming]);
  const filtering = filter.bot !== null || filter.workspace !== null || !!filter.machine;
  const several = machines.length > 1;
  const notes = machines.map((m) => loads[m.id] && machineNote(m.name, loads[m.id])).filter((n): n is string => !!n);

  const remove = async (item: MachineItem) => {
    const backend = backendFor(item.machine);
    if (!backend) return;
    try {
      await backend.libraryRemove(item.file);
      setViewing(null);
      setError("");
      setItems((all) => all.filter((i) => itemKey(i) !== itemKey(item)));
    } catch (err) {
      setError(String((err as Error)?.message ?? err));
    }
  };

  const beginRename = (item: MachineItem) => { setRenaming(itemKey(item)); setDraftName(item.name ?? item.file); setRenameError(""); };
  const cancelRename = () => { setRenaming(null); setRenameError(""); };
  const rename = async (item: MachineItem) => {
    const backend = backendFor(item.machine);
    if (!backend) { setRenameError("This machine is unavailable."); return; }
    try {
      await backend.libraryRename(item.file, draftName);
      const name = draftName.trim();
      setItems((all) => all.map((entry) => itemKey(entry) === itemKey(item) ? { ...entry, name } : entry));
      setViewing((current) => current && itemKey(current) === itemKey(item) ? { ...current, name } : current);
      cancelRename();
    } catch (err) { setRenameError(String((err as Error)?.message ?? err)); }
  };
  const askDelete = (item: MachineItem) => setQuestion({ title: "Delete this picture?", body: several ? `It is removed from ${nameOf(item.machine)}'s Library. The thread it came from is not changed.` : "It is removed from the Library. The thread it came from is not changed.", action: "Delete", onConfirm: () => { setQuestion(null); void remove(item); } });

  return <section className="library-section">
    <header className="section-intro">
      <span className="eyebrow">Every picture your bots made</span>
      <h1>Library</h1>
      <p>{several ? "Pictures stay on the machine that made them, and stay after their thread is gone." : "Pictures stay here after their thread is gone."}</p>
    </header>
    <div className="library-filters">
      <div className="library-layout" role="group" aria-label="Library layout">
        <button type="button" aria-pressed={layout === "gallery"} onClick={() => setLayout("gallery")}>Gallery</button>
        <button type="button" aria-pressed={layout === "list"} onClick={() => setLayout("list")}>List</button>
      </div>
      <label className="library-search">Search <input type="search" aria-label="Search by display name or original filename" placeholder="Name or filename" value={search} onChange={(e) => setSearch(e.target.value)} /></label>
      <label>Sort <select aria-label="Sort Library" value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}>
        <option value="newest">Newest</option>
        <option value="oldest">Oldest</option>
        <option value="name">Name</option>
      </select></label>
      {several && <label>Machine <select aria-label="Filter by machine" value={filter.machine ?? ""} onChange={(e) => setFilter({ ...filter, machine: e.target.value || null })}>
          <option value="">All machines</option>
          {machines.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
      </select></label>}
      <label>Bot <select aria-label="Filter by bot" value={filter.bot ?? ""} onChange={(e) => setFilter({ ...filter, bot: e.target.value || null })}>
          <option value="">All bots</option>
          {bots.map((bot) => <option key={bot} value={bot}>{bot}</option>)}
      </select></label>
      <label>Workspace <select aria-label="Filter by workspace" value={filter.workspace ?? ""} onChange={(e) => setFilter({ ...filter, workspace: e.target.value || null })}>
          <option value="">All workspaces</option>
          {workspaceIds.map((id) => <option key={id} value={id}>{names.get(id) ?? "Workspace"}</option>)}
      </select></label>
    </div>
    <div className="library-scroll">
      {error && <p className="library-error" role="alert">{error}</p>}
      {notes.length > 0 && <div className="library-notes">{notes.map((note) => <p key={note} className="library-note">{note}</p>)}</div>}
      {loaded && items.length === 0 && <div className="library-empty"><p className="muted">Pictures your bots make will appear here.</p></div>}
      {items.length > 0 && <>
      {shown.length === 0 && <p className="muted library-none">{filtering || query ? "No pictures match your search and filters." : "No pictures to show."}</p>}
      <div className={`library-grid${layout === "list" ? " is-list" : ""}`}>
        {shown.map((item) => <LibraryTile key={itemKey(item)} item={item} backend={backendFor(item.machine)} machine={several ? nameOf(item.machine) : ""} renaming={renaming === itemKey(item)} draftName={draftName} renameError={renaming === itemKey(item) ? renameError : ""} setDraftName={setDraftName} onRename={() => void rename(item)} onCancelRename={cancelRename} onBeginRename={() => beginRename(item)} onSaveAs={() => void saveLibraryItem(item, backendFor(item.machine)).catch((err) => setError(String((err as Error)?.message ?? err)))} onOpen={() => setViewing(item)} onOpenThread={threadExists(item.room, threads) ? () => onOpenThread(item.room) : undefined} onDelete={() => askDelete(item)} />)}
      </div>
      </>}
    </div>
    {viewing && <div className="library-viewer-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) setViewing(null); }}>
      <LibraryViewer item={viewing} backend={backendFor(viewing.machine)} bot={viewing.by} when={viewing.created} openable={threadExists(viewing.room, threads)}
        canNavigate={shown.length > 1} navigationDisabled={!!question || !!renaming} onPrevious={() => navigate(-1)} onNext={() => navigate(1)}
        workspace={names.get(workspaceForRoom(viewing.room, threads) ?? "") ?? ""} machine={several ? nameOf(viewing.machine) : ""}
        renaming={renaming === itemKey(viewing)} draftName={draftName} renameError={renameError} setDraftName={setDraftName} onRename={() => void rename(viewing)} onCancelRename={cancelRename} onBeginRename={() => beginRename(viewing)}
        onClose={() => setViewing(null)}
        onOpen={() => { setViewing(null); onOpenThread(viewing.room); }}
        onDelete={() => askDelete(viewing)} />
    </div>}
    {question && <ConfirmDialog question={question} onCancel={() => setQuestion(null)} />}
  </section>;
}

/** Reads a picture only when its tile scrolls near the screen. */
function useImage(item: LibraryItem, backend: Backend | null, enabled: boolean): string | null {
  const [image, setImage] = useState<{ path: string; backend: Backend; url: string } | null>(null);
  useEffect(() => {
    setImage(null);
    if (!enabled || !backend) return;
    let made: string | null = null;
    let live = true;
    backend.readAttachment(item.path).then((bytes) => {
      if (!live) return;
      made = URL.createObjectURL(new Blob([bytes], { type: isVideoItem(item) ? videoType(item.file) : "" }));
      setImage({ path: item.path, backend, url: made });
    }).catch(() => {});
    return () => { live = false; if (made) URL.revokeObjectURL(made); };
  }, [item.path, backend, enabled]);
  return enabled && image?.path === item.path && image.backend === backend ? image.url : null;
}

function LibraryTile({ item, backend, machine, onOpen, onBeginRename, onRename, onCancelRename, onSaveAs, onOpenThread, onDelete, renaming, draftName, renameError, setDraftName }: {
  item: LibraryItem; backend: Backend | null; machine: string; onOpen: () => void; onBeginRename: () => void; onRename: () => void; onCancelRename: () => void;
  onSaveAs: () => void; onOpenThread?: () => void; onDelete: () => void; renaming: boolean; draftName: string; renameError: string; setDraftName: (name: string) => void;
}) {
  const box = useRef<HTMLButtonElement>(null);
  const [near, setNear] = useState(typeof IntersectionObserver === "undefined");
  useEffect(() => {
    const el = box.current;
    if (near || !el || typeof IntersectionObserver === "undefined") return;
    const watch = new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) { setNear(true); watch.disconnect(); } }, { rootMargin: "200px" });
    watch.observe(el);
    return () => watch.disconnect();
  }, [near]);
  const url = useImage(item, backend, near);
  const video = isVideoItem(item);
  const size = item.bytes == null ? "" : item.bytes < 1024 * 1024 ? `${Math.max(1, Math.round(item.bytes / 1024))} KB` : `${(item.bytes / (1024 * 1024)).toFixed(1)} MB`;
  const details = [video ? "Video" : "Image", size, new Date(item.created).toLocaleString(), machine].filter(Boolean);
  return <article className="library-tile-wrap">
    <button ref={box} type="button" className="library-tile" onClick={onOpen} title={item.path}>
      <span className="library-thumb">{url && (video ? <video src={url} muted preload="metadata" aria-label={item.name ?? item.file} /> : <img src={url} alt={item.name ?? item.file} />)}{video && <span className="library-play" aria-hidden="true">▶</span>}</span>
      <span className="library-caption">
        <strong className="library-file">{item.name ?? item.file}</strong>
        <span className="library-meta"><span>{item.by ?? "A bot"}</span><span>{details.join(" · ")}</span></span>
      </span>
    </button>
    <LibraryActions onBeginRename={onBeginRename} onSaveAs={onSaveAs} onOpenThread={onOpenThread} onDelete={onDelete} />
    {renaming && <form className="library-rename" onSubmit={(event) => { event.preventDefault(); onRename(); }}>
      <label>Library name<input autoFocus value={draftName} maxLength={160} onChange={(event) => setDraftName(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); onCancelRename(); } }} /></label>
      {renameError && <span role="alert" className="library-error">{renameError}</span>}
      <span><button type="submit">Save name</button><button type="button" onClick={onCancelRename}>Cancel</button><small>Original file: {item.file}</small></span>
    </form>}
  </article>;
}

function LibraryActions({ onBeginRename, onSaveAs, onOpenThread, onDelete }: { onBeginRename: () => void; onSaveAs: () => void; onOpenThread?: () => void; onDelete: () => void }) {
  return <details className="library-actions"><summary aria-label="Asset actions" title="Asset actions">⋯</summary><div role="menu">
    <button role="menuitem" onClick={onBeginRename}>Rename</button>
    <button role="menuitem" onClick={onSaveAs}>Save as…</button>
    {onOpenThread && <button role="menuitem" onClick={onOpenThread}>Open thread</button>}
    <button role="menuitem" className="danger" onClick={onDelete}>Delete</button>
  </div></details>;
}

async function saveLibraryItem(item: LibraryItem, backend: Backend | null) {
  if (!backend) throw new Error("This machine is unavailable.");
  const bytes = await backend.readAttachment(item.path);
  const blob = new Blob([bytes], { type: isVideoItem(item) ? videoType(item.file) : "" });
  const suggestedName = item.name || item.file;
  const picker = (window as Window & { showSaveFilePicker?: (options: { suggestedName: string }) => Promise<{ createWritable(): Promise<{ write(data: Blob): Promise<void>; close(): Promise<void> }> }> }).showSaveFilePicker;
  if (picker) {
    try { const handle = await picker({ suggestedName }); const writable = await handle.createWritable(); await writable.write(blob); await writable.close(); return; }
    catch (error) { if ((error as DOMException)?.name === "AbortError") return; throw error; }
  }
  const url = URL.createObjectURL(blob); const link = document.createElement("a"); link.href = url; link.download = suggestedName; link.click(); URL.revokeObjectURL(url);
}

function LibraryViewer({ item, backend, bot, when, openable, workspace, machine, onClose, onOpen, onDelete, renaming, draftName, renameError, setDraftName, onRename, onCancelRename, onBeginRename, canNavigate, navigationDisabled, onPrevious, onNext }: {
  item: LibraryItem; backend: Backend | null; bot?: string; when: number; openable: boolean; workspace: string; machine: string;
  onClose: () => void; onOpen: () => void; onDelete: () => void; renaming: boolean; draftName: string; renameError: string; setDraftName: (name: string) => void; onRename: () => void; onCancelRename: () => void; onBeginRename: () => void;
  canNavigate: boolean; navigationDisabled: boolean; onPrevious: () => void; onNext: () => void;
}) {
  const url = useImage(item, backend, true);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === "Escape" && !e.defaultPrevented && !navigationDisabled) onClose(); };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose, navigationDisabled]);
  useEffect(() => { setZoom(1); setPan({ x: 0, y: 0 }); drag.current = null; }, [item.path, backend]);
  const save = async () => {
    if (!url) return;
    const blob = await fetch(url).then((response) => response.blob());
    const picker = (window as Window & { showSaveFilePicker?: (options: { suggestedName: string }) => Promise<{ createWritable(): Promise<{ write(data: Blob): Promise<void>; close(): Promise<void> }> }> }).showSaveFilePicker;
    if (picker) {
      try { const handle = await picker({ suggestedName: item.name ?? item.file }); const writable = await handle.createWritable(); await writable.write(blob); await writable.close(); return; }
      catch (error) { if ((error as DOMException)?.name === "AbortError") return; throw error; }
    }
    const link = document.createElement("a"); link.href = url; link.download = item.name ?? item.file; link.click();
  };
  const setScale = (next: number) => { setZoom(Math.max(1, Math.min(16, next))); if (next <= 1) setPan({ x: 0, y: 0 }); };
  return <div className={`library-viewer-frame${canNavigate ? " has-navigation" : ""}`} role="dialog" aria-modal="true" aria-label="Picture">
    {canNavigate && <button type="button" className="library-viewer-nav is-previous" aria-label="Previous picture" disabled={navigationDisabled} onClick={onPrevious}>‹</button>}
    <div className="library-viewer">
    <div className={`library-viewer-image${zoom > 1 && !isVideoItem(item) ? " is-zoomed" : ""}`} onPointerDown={(event) => { if (zoom > 1 && !isVideoItem(item)) { drag.current = { x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y }; event.currentTarget.setPointerCapture(event.pointerId); } }} onPointerMove={(event) => { if (drag.current) setPan({ x: drag.current.panX + event.clientX - drag.current.x, y: drag.current.panY + event.clientY - drag.current.y }); }} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }} onLostPointerCapture={() => { drag.current = null; }}>
      {url ? (isVideoItem(item) ? <video key={url} src={url} controls autoPlay aria-label={item.name ?? item.file} /> : <img key={url} ref={imageRef} src={url} alt={item.name ?? item.file} draggable={false} style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }} />) : <span className="muted" role="status">Loading preview…</span>}
    </div>
    <div className="library-viewer-bar">
      <span className="library-caption"><strong>{item.name ?? item.file}</strong><span>{bot ?? "A bot"} · {new Date(when).toLocaleString()}{workspace && ` · ${workspace}`}{machine && ` · ${machine}`}</span><small>Original file: {item.file}</small></span>
      <span className="library-viewer-actions">
        {!isVideoItem(item) && <><button aria-label="Zoom out" onClick={() => setScale(zoom - 0.25)}>−</button><span className="library-zoom-label">{Math.round(zoom * 100)}%</span><button aria-label="Zoom in" onClick={() => setScale(zoom + 0.25)}>+</button><button onClick={() => { setScale(1); setPan({ x: 0, y: 0 }); }}>Fit</button><button onClick={() => { const image = imageRef.current; if (image) { setScale(image.naturalWidth / Math.max(1, image.clientWidth)); setPan({ x: 0, y: 0 }); } }}>Actual size</button></>}
        <button onClick={() => void save()} disabled={!url}>Save as…</button>
        <button onClick={onBeginRename}>Rename</button>
        {openable && <button className="accent" onClick={onOpen}>Open thread</button>}
        <button className="danger" onClick={onDelete}>Delete</button>
        <button onClick={onClose}>Close</button>
      </span>
    </div>
    {renaming && <form className="library-viewer-rename" onSubmit={(event) => { event.preventDefault(); onRename(); }}>
      <label>Library name<input autoFocus value={draftName} maxLength={160} onChange={(event) => setDraftName(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); onCancelRename(); } }} /></label>
      {renameError && <span role="alert" className="library-error">{renameError}</span>}
      <button type="submit">Save name</button><button type="button" onClick={onCancelRename}>Cancel</button>
    </form>}
    </div>
    {canNavigate && <button type="button" className="library-viewer-nav is-next" aria-label="Next picture" disabled={navigationDisabled} onClick={onNext}>›</button>}
  </div>;
}
