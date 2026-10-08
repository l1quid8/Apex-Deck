import { useEffect, useRef, useState } from "react";
import type { Backend, LibraryItem } from "./backend";
import { ConfirmDialog, type Question } from "./ConfirmDialog";
import { botsIn, filterLibrary, threadExists, workspacesIn, workspaceForRoom, type LibraryFilter, type LibraryThread } from "./library";
import type { Workspace } from "./types";

interface Props {
  backend: Backend | null;
  /** Threads on the deck, with the workspace each is in. */
  threads: LibraryThread[];
  workspaces: Workspace[];
  /** Go to a thread. Only offered while the thread is still on the deck. */
  onOpenThread: (room: string) => void;
}

/** Every picture the bots made, with filters, a larger view, and delete. */
export function LibraryView({ backend, threads, workspaces, onOpenThread }: Props) {
  const [items, setItems] = useState<LibraryItem[]>([]);
  const [filter, setFilter] = useState<LibraryFilter>({ bot: null, workspace: null });
  const [viewing, setViewing] = useState<LibraryItem | null>(null);
  const [question, setQuestion] = useState<Question | null>(null);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);

  /** Reload the list. Runs each time the tab opens. */
  const load = () => {
    if (!backend) return;
    backend.libraryList().then((list) => { setItems(list); setLoaded(true); }).catch((err) => setError(String(err?.message ?? err)));
  };
  useEffect(load, [backend]);

  const names = new Map(workspaces.map((w) => [w.id, w.name]));
  const bots = botsIn(items);
  const workspaceIds = workspacesIn(items, threads);
  const shown = filterLibrary(items, filter, threads);
  const filtering = filter.bot !== null || filter.workspace !== null;

  const remove = async (item: LibraryItem) => {
    if (!backend) return;
    try {
      await backend.libraryRemove(item.file);
      setViewing(null);
      setError("");
      load();
    } catch (err) {
      setError(String((err as Error)?.message ?? err));
    }
  };

  return <section className="library-section">
    <header className="section-intro">
      <span className="eyebrow">Every picture your bots made</span>
      <h1>Library</h1>
      <p>Pictures stay here after their thread is gone.</p>
    </header>
    {error && <p className="library-error" role="alert">{error}</p>}
    {loaded && items.length === 0 && <div className="library-empty"><p className="muted">Pictures your bots make will appear here.</p></div>}
    {items.length > 0 && <>
      <div className="library-filters">
        <label>Bot <select aria-label="Filter by bot" value={filter.bot ?? ""} onChange={(e) => setFilter({ ...filter, bot: e.target.value || null })}>
          <option value="">All bots</option>
          {bots.map((bot) => <option key={bot} value={bot}>{bot}</option>)}
        </select></label>
        <label>Workspace <select aria-label="Filter by workspace" value={filter.workspace ?? ""} onChange={(e) => setFilter({ ...filter, workspace: e.target.value || null })}>
          <option value="">All workspaces</option>
          {workspaceIds.map((id) => <option key={id} value={id}>{names.get(id) ?? "Workspace"}</option>)}
        </select></label>
      </div>
      {shown.length === 0 && <p className="muted library-none">{filtering ? "No pictures match these filters." : ""}</p>}
      <div className="library-grid">
        {shown.map((item) => <LibraryTile key={item.file} item={item} backend={backend} onOpen={() => setViewing(item)} />)}
      </div>
    </>}
    {viewing && <div className="library-viewer-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) setViewing(null); }}>
      <LibraryViewer item={viewing} backend={backend} bot={viewing.by} when={viewing.created} openable={threadExists(viewing.room, threads)} workspace={names.get(workspaceForRoom(viewing.room, threads) ?? "") ?? ""}
        onClose={() => setViewing(null)}
        onOpen={() => { setViewing(null); onOpenThread(viewing.room); }}
        onDelete={() => setQuestion({ title: "Delete this picture?", body: "It is removed from the Library. The thread it came from is not changed.", action: "Delete", onConfirm: () => { setQuestion(null); void remove(viewing); } })} />
    </div>}
    {question && <ConfirmDialog question={question} onCancel={() => setQuestion(null)} />}
  </section>;
}

/** Reads a picture only when its tile scrolls near the screen. */
function useImage(item: LibraryItem, backend: Backend | null, enabled: boolean): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled || !backend) return;
    let made: string | null = null;
    let live = true;
    backend.readAttachment(item.path).then((bytes) => {
      if (!live) return;
      made = URL.createObjectURL(new Blob([bytes]));
      setUrl(made);
    }).catch(() => {});
    return () => { live = false; if (made) URL.revokeObjectURL(made); };
  }, [item.path, backend, enabled]);
  return url;
}

function LibraryTile({ item, backend, onOpen }: { item: LibraryItem; backend: Backend | null; onOpen: () => void }) {
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
  return <button ref={box} type="button" className="library-tile" onClick={onOpen} title={item.path}>
    <span className="library-thumb">{url && <img src={url} alt={item.file} />}</span>
    <span className="library-caption">{item.by ?? "A bot"} · {new Date(item.created).toLocaleDateString()}</span>
  </button>;
}

function LibraryViewer({ item, backend, bot, when, openable, workspace, onClose, onOpen, onDelete }: {
  item: LibraryItem; backend: Backend | null; bot?: string; when: number; openable: boolean; workspace: string;
  onClose: () => void; onOpen: () => void; onDelete: () => void;
}) {
  const url = useImage(item, backend, true);
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);
  return <div className="library-viewer" role="dialog" aria-label="Picture">
    <div className="library-viewer-image">{url && <img src={url} alt={item.file} />}</div>
    <div className="library-viewer-bar">
      <span className="library-caption">{bot ?? "A bot"} · {new Date(when).toLocaleString()}{workspace && ` · ${workspace}`}</span>
      <span className="library-viewer-actions">
        {openable && <button className="accent" onClick={onOpen}>Open thread</button>}
        <button className="danger" onClick={onDelete}>Delete</button>
        <button onClick={onClose}>Close</button>
      </span>
    </div>
  </div>;
}
