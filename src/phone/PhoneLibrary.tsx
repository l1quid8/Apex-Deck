import { useEffect, useRef, useState } from "react";
import type { Backend, LibraryItem } from "../backend";
import { botsIn, filterLibrary, threadExists, workspaceForRoom, workspacesIn, type LibraryFilter, type LibraryThread } from "../library";
import { Folder } from "./icons";
import { fitsOnPhone, gridColumns, libraryCaption, libraryErrorLine, notShownReason } from "./libraryRules";

interface Props {
  /** The Mac's backend. */
  backend: Backend;
  /** The Mac's name, e.g. "Tyler's MacBook Pro". */
  machine: string;
  /** Threads that still exist, with the workspace each is in. */
  threads: LibraryThread[];
  workspaces: { id: string; name: string }[];
  /** Go to a thread. Only offered while the thread is still on the Mac. */
  onOpenThread(room: string): void;
}

/** The Library on the phone: every picture the bots made on the Mac, with filters, a full-screen view, and delete. */
export function PhoneLibrary({ backend, machine, threads, workspaces, onOpenThread }: Props) {
  const [items, setItems] = useState<LibraryItem[]>([]);
  const [filter, setFilter] = useState<LibraryFilter>({ bot: null, workspace: null });
  const [viewing, setViewing] = useState<LibraryItem | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loaded, setLoaded] = useState(false);
  const [width, setWidth] = useState(0);
  const root = useRef<HTMLElement>(null);

  /** Reload the list. Runs each time the tab opens and after a delete. */
  const load = () => {
    backend.libraryList()
      .then((list) => { setItems(list); setError(null); })
      .catch((err) => setError(err))
      .finally(() => setLoaded(true));
  };
  useEffect(load, [backend]);

  /** Track the width so the grid can switch to three columns on wide screens. */
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const measure = () => setWidth(el.clientWidth);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const watch = new ResizeObserver(measure);
    watch.observe(el);
    return () => watch.disconnect();
  }, []);

  const names = new Map(workspaces.map((w) => [w.id, w.name]));
  const bots = botsIn(items);
  const workspaceIds = workspacesIn(items, threads);
  const shown = filterLibrary(items, filter, threads);
  const filtering = filter.bot !== null || filter.workspace !== null;
  const cols = gridColumns(width);

  return <section ref={root} className="ph-lib">
    {items.length > 0 && <div className="ph-lib-toolbar">
      <select className="ph-lib-select" aria-label="Filter by bot" value={filter.bot ?? ""} onChange={(e) => setFilter({ ...filter, bot: e.target.value || null })}>
        <option value="">All bots</option>
        {bots.map((bot) => <option key={bot} value={bot}>{bot}</option>)}
      </select>
      <select className="ph-lib-select" aria-label="Filter by workspace" value={filter.workspace ?? ""} onChange={(e) => setFilter({ ...filter, workspace: e.target.value || null })}>
        <option value="">All workspaces</option>
        {workspaceIds.map((id) => <option key={id} value={id}>{names.get(id) ?? "Workspace"}</option>)}
      </select>
    </div>}

    {error !== null && <div className="ph-banner bad" role="alert"><p>{libraryErrorLine(error, machine)}</p></div>}
    {!loaded && <div className="ph-empty"><p>Loading pictures…</p></div>}
    {loaded && !error && items.length === 0 && <div className="ph-empty">
      <Folder size={30} />
      <h3>No pictures yet</h3>
      <p>Pictures your bots make on {machine} will appear here.</p>
    </div>}
    {items.length > 0 && shown.length === 0 && <p className="ph-muted ph-lib-none">{filtering ? "No pictures match these filters." : ""}</p>}
    {shown.length > 0 && <div className="ph-lib-grid" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
      {shown.map((item) => <LibraryTile key={item.file} item={item} backend={backend} onOpen={() => setViewing(item)} />)}
    </div>}

    {viewing && <PhoneLibraryViewer item={viewing} backend={backend} machine={machine} threads={threads} workspaceName={names.get(workspaceForRoom(viewing.room, threads) ?? "") ?? ""}
      onClose={() => setViewing(null)}
      onOpen={() => { setViewing(null); onOpenThread(viewing.room); }}
      onDeleted={() => { setViewing(null); load(); }} />}
  </section>;
}

/** Reads a picture only when its tile scrolls near the screen, and never one too big for the phone's link. A failed read can be retried. */
function useImage(item: LibraryItem, backend: Backend, enabled: boolean): { url: string | null; failed: boolean; retry: () => void } {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!enabled || !fitsOnPhone(item)) return;
    let made: string | null = null;
    let live = true;
    setFailed(false);
    backend.readAttachment(item.path).then((bytes) => {
      if (!live) return;
      made = URL.createObjectURL(new Blob([bytes]));
      setUrl(made);
    }).catch(() => { if (live) setFailed(true); });
    return () => { live = false; if (made) URL.revokeObjectURL(made); };
  }, [item.path, item.bytes, backend, enabled, attempt]);
  return { url, failed, retry: () => setAttempt((n) => n + 1) };
}

function LibraryTile({ item, backend, onOpen }: { item: LibraryItem; backend: Backend; onOpen: () => void }) {
  const box = useRef<HTMLButtonElement>(null);
  const [near, setNear] = useState(typeof IntersectionObserver === "undefined");
  useEffect(() => {
    const el = box.current;
    if (near || !el || typeof IntersectionObserver === "undefined") return;
    const watch = new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) { setNear(true); watch.disconnect(); } }, { rootMargin: "200px" });
    watch.observe(el);
    return () => watch.disconnect();
  }, [near]);
  const { url, failed, retry } = useImage(item, backend, near);
  const reason = notShownReason(item);
  return <div className="ph-lib-tile-wrap">
    <button ref={box} type="button" className="ph-lib-tile" onClick={onOpen} aria-label={libraryCaption(item, true)}>
      <span className="ph-lib-thumb">{url && <img src={url} alt="" />}{reason && <span className="ph-lib-big">{reason}</span>}{failed && <span className="ph-lib-big">Couldn't load this picture</span>}</span>
      <span className="ph-lib-caption">{libraryCaption(item, false)}</span>
    </button>
    {failed && <button type="button" className="ph-lib-action ph-lib-retry" onClick={retry}>Retry</button>}
  </div>;
}

/** The full-screen view. Delete asks first, inside this view. */
function PhoneLibraryViewer({ item, backend, machine, threads, workspaceName, onClose, onOpen, onDeleted }: {
  item: LibraryItem; backend: Backend; machine: string; threads: LibraryThread[]; workspaceName: string;
  onClose: () => void; onOpen: () => void; onDeleted: () => void;
}) {
  const { url, failed, retry } = useImage(item, backend, true);
  const reason = notShownReason(item);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<unknown>(null);
  const openable = threadExists(item.room, threads);

  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);

  const remove = () => {
    setBusy(true);
    setDeleteError(null);
    backend.libraryRemove(item.file)
      .then(() => onDeleted())
      .catch((err) => { setDeleteError(err); setConfirming(false); })
      .finally(() => setBusy(false));
  };

  return <div className="ph-lib-viewer" role="dialog" aria-label="Picture">
    <div className="ph-lib-viewer-image">{url && <img src={url} alt="" />}
      {reason && <p className="ph-lib-big">{reason === "Too big for the phone" ? `This picture is too big to show on the phone. Open it on ${machine}.` : `${machine} didn't say how big this picture is, so the phone won't risk loading it. Update Deck on ${machine}, or open it there.`}</p>}
      {failed && <p className="ph-lib-big" role="alert">Couldn't load this picture from {machine}. <button type="button" className="ph-lib-action" onClick={retry}>Retry</button></p>}</div>
    <div className="ph-lib-viewer-bar">
      {deleteError !== null && <p className="ph-lib-viewer-error" role="alert">Couldn't delete this picture: {String((deleteError as { message?: unknown } | null)?.message ?? deleteError)}</p>}
      {confirming ? <>
        <p className="ph-lib-viewer-ask">Delete this picture? It is removed from the Library. The thread it came from is not changed.</p>
        <span className="ph-lib-viewer-actions">
          <button type="button" className="ph-lib-action ph-lib-danger" onClick={remove} disabled={busy}>Delete</button>
          <button type="button" className="ph-lib-action" onClick={() => setConfirming(false)} disabled={busy}>Cancel</button>
        </span>
      </> : <>
        <span className="ph-lib-caption">{libraryCaption(item, true)}{workspaceName && ` · ${workspaceName}`}</span>
        <span className="ph-lib-viewer-actions">
          {openable && <button type="button" className="ph-lib-action primary" onClick={onOpen}>Open thread</button>}
          <button type="button" className="ph-lib-action ph-lib-danger" onClick={() => setConfirming(true)}>Delete</button>
          <button type="button" className="ph-lib-action" onClick={onClose}>Close</button>
        </span>
      </>}
    </div>
  </div>;
}
