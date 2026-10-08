import { useEffect, useRef, useState } from "react";
import type { Backend, LibraryItem } from "../backend";
import { botsIn, filterLibrary, itemKey, threadExists, workspaceForRoom, workspacesIn, type LibraryFilter, type LibraryThread, type MachineItem } from "../library";
import { Folder } from "./icons";
import { fitsOnPhone, gridColumns, libraryCaption, notShownReason } from "./libraryRules";

import { listPhoneLibrary, phoneLibraryNote, type PhoneLibraryMachine } from "./libraryMachines";

interface Props {
  machines: PhoneLibraryMachine[];
  /** Threads that still exist, with the workspace each is in. */
  threads: LibraryThread[];
  workspaces: { id: string; name: string; hostId?: string }[];
  /** Go to a thread. Only offered while the thread is still on the Mac. */
  onOpenThread(room: string): void;
}

/** Pictures stay on their paired source machine, with filters, a full-screen view, and delete. */
export function PhoneLibrary({ machines, threads, workspaces, onOpenThread }: Props) {
  const [items, setItems] = useState<MachineItem[]>([]);
  const [filter, setFilter] = useState<LibraryFilter>({ bot: null, workspace: null, machine: null });
  const [viewing, setViewing] = useState<MachineItem | null>(null);
  const [notes, setNotes] = useState<Record<string, string | null>>({});
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [refresh, setRefresh] = useState(0);
  const [width, setWidth] = useState(0);
  const root = useRef<HTMLElement>(null);

  // Each paired machine loads independently. Reconnects retry completed requests,
  // while an initial request already waits for hello under the same deadline.
  useEffect(() => {
    let live = true;
    setItems([]);
    setNotes({});
    setPending(Object.fromEntries(machines.map((m) => [m.id, true])));
    const stops = machines.map((machine) => {
      let asking = false;
      let disconnected = false;
      let reloadAfter = false;
      let status = machine.connection.get().status.kind;
      const load = () => {
        if (asking || !live) return;
        asking = true;
        disconnected = false;
        setPending((all) => ({ ...all, [machine.id]: true }));
        setNotes((all) => ({ ...all, [machine.id]: null }));
        listPhoneLibrary(machine).then((list) => {
          if (!live) return;
          if (machine.connection.get().status.kind !== "connected") {
            setItems((all) => all.filter((i) => i.machine !== machine.id));
            setNotes((all) => ({ ...all, [machine.id]: phoneLibraryNote(machine.name, new Error("not connected")) }));
            return;
          }
          setItems((all) => [...all.filter((i) => i.machine !== machine.id), ...list.map((i) => ({ ...i, machine: machine.id }))]);
        }, (error) => {
          if (!live) return;
          setItems((all) => all.filter((i) => i.machine !== machine.id));
          setNotes((all) => ({ ...all, [machine.id]: phoneLibraryNote(machine.name, error) }));
        }).finally(() => {
          asking = false;
          if (live) {
            setPending((all) => ({ ...all, [machine.id]: false }));
            if (reloadAfter && status === "connected") { reloadAfter = false; load(); }
          }
        });
      };
      const stop = machine.connection.subscribe(() => {
        const next = machine.connection.get().status.kind;
        if (next === status) return;
        status = next;
        if (next === "connected") {
          if (asking && disconnected) reloadAfter = true;
          else load();
        } else if (asking) disconnected = true;
        else if (next === "failed" || next === "reconnecting" || next === "idle") {
          setItems((all) => all.filter((i) => i.machine !== machine.id));
          setNotes((all) => ({ ...all, [machine.id]: phoneLibraryNote(machine.name, new Error("not connected")) }));
        }
      });
      load();
      return stop;
    });
    return () => { live = false; stops.forEach((stop) => stop()); };
  }, [machines, refresh]);

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
  const filtering = filter.bot !== null || filter.workspace !== null || !!filter.machine;
  const sourceOf = (id: string) => machines.find((m) => m.id === id);
  const viewingSource = viewing ? sourceOf(viewing.machine) : null;
  const cols = gridColumns(width);

  return <section ref={root} className="ph-lib">
    {machines.length > 0 && <div className="ph-lib-toolbar">
      <select className="ph-lib-select ph-lib-machine" aria-label="Filter by machine" value={filter.machine ?? ""} onChange={(e) => setFilter({ ...filter, machine: e.target.value || null })}>
        <option value="">All machines</option>
        {machines.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
      </select>
      <select className="ph-lib-select" aria-label="Filter by bot" value={filter.bot ?? ""} onChange={(e) => setFilter({ ...filter, bot: e.target.value || null })}>
        <option value="">All bots</option>
        {bots.map((bot) => <option key={bot} value={bot}>{bot}</option>)}
      </select>
      <select className="ph-lib-select" aria-label="Filter by workspace" value={filter.workspace ?? ""} onChange={(e) => setFilter({ ...filter, workspace: e.target.value || null })}>
        <option value="">All workspaces</option>
        {workspaceIds.map((id) => <option key={id} value={id}>{names.get(id) ?? "Workspace"}</option>)}
      </select>
    </div>}

    {machines.length === 0 && <div className="ph-empty"><h3>Pair a machine first</h3><p>Open Settings → Machines.</p></div>}
    {machines.map((m) => notes[m.id] && <div key={m.id} className="ph-banner" role="status"><p>{notes[m.id]}</p></div>)}
    {Object.values(pending).some(Boolean) && <p className="ph-muted">Loading pictures…</p>}
    {machines.length > 0 && !Object.values(pending).some(Boolean) && items.length === 0 && <div className="ph-empty">
      <Folder size={30} /><h3>No pictures available</h3><p>Pictures your bots make on your paired machines will appear here.</p>
    </div>}
    {items.length > 0 && shown.length === 0 && <p className="ph-muted ph-lib-none">{filtering ? "No pictures match these filters." : ""}</p>}
    {shown.length > 0 && <div className="ph-lib-grid" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
      {shown.map((item) => { const source = sourceOf(item.machine); return source && <LibraryTile key={itemKey(item)} item={item} backend={source.backend} machine={source.name} onOpen={() => setViewing(item)} />; })}
    </div>}

    {viewing && viewingSource && <PhoneLibraryViewer key={itemKey(viewing)} item={viewing} backend={viewingSource.backend} machine={viewingSource.name} threads={threads.filter((t) => (workspaces.find((w) => w.id === t.workspaceId)?.hostId ?? "local") === viewing.machine)} workspaceName={names.get(workspaceForRoom(viewing.room, threads) ?? "") ?? ""}
      onClose={() => setViewing(null)}
      onOpen={() => { setViewing(null); onOpenThread(viewing.room); }}
      onDeleted={() => { setViewing(null); setRefresh((n) => n + 1); }} />}
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
    setUrl(null);
    backend.readAttachment(item.path).then((bytes) => {
      if (!live) return;
      made = URL.createObjectURL(new Blob([bytes]));
      setUrl(made);
    }).catch(() => { if (live) setFailed(true); });
    return () => { live = false; if (made) URL.revokeObjectURL(made); };
  }, [item.path, item.bytes, backend, enabled, attempt]);
  return { url, failed, retry: () => setAttempt((n) => n + 1) };
}

function LibraryTile({ item, backend, machine, onOpen }: { item: LibraryItem; backend: Backend; machine: string; onOpen: () => void }) {
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
  const reason = notShownReason(item, machine);
  return <div className="ph-lib-tile-wrap">
    <button ref={box} type="button" className="ph-lib-tile" onClick={onOpen} aria-label={`${libraryCaption(item, true)} · ${machine}`}>
      <span className="ph-lib-thumb">{url && <img src={url} alt="" />}{reason && <span className="ph-lib-big">{reason}</span>}{failed && <span className="ph-lib-big">Couldn't load this picture</span>}</span>
      <span className="ph-lib-caption">{libraryCaption(item, false)} · {machine}</span>
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
  const reason = notShownReason(item, machine);
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
        <span className="ph-lib-caption">{libraryCaption(item, true)} · {machine}{workspaceName && ` · ${workspaceName}`}</span>
        <span className="ph-lib-viewer-actions">
          {openable && <button type="button" className="ph-lib-action primary" onClick={onOpen}>Open thread</button>}
          <button type="button" className="ph-lib-action ph-lib-danger" onClick={() => setConfirming(true)}>Delete</button>
          <button type="button" className="ph-lib-action" onClick={onClose}>Close</button>
        </span>
      </>}
    </div>
  </div>;
}
