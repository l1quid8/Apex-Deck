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
  const [viewing, setViewing] = useState<MachineItem | null>(null);
  const [question, setQuestion] = useState<Question | null>(null);
  const [error, setError] = useState("");
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
  const shown = filterLibrary(items, filter, threads);
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

  return <section className="library-section">
    <header className="section-intro">
      <span className="eyebrow">Every picture your bots made</span>
      <h1>Library</h1>
      <p>{several ? "Pictures stay on the machine that made them, and stay after their thread is gone." : "Pictures stay here after their thread is gone."}</p>
    </header>
    {error && <p className="library-error" role="alert">{error}</p>}
    {notes.length > 0 && <div className="library-notes">{notes.map((note) => <p key={note} className="library-note">{note}</p>)}</div>}
    {loaded && items.length === 0 && <div className="library-empty"><p className="muted">Pictures your bots make will appear here.</p></div>}
    {items.length > 0 && <>
      <div className="library-filters">
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
      {shown.length === 0 && <p className="muted library-none">{filtering ? "No pictures match these filters." : ""}</p>}
      <div className="library-grid">
        {shown.map((item) => <LibraryTile key={itemKey(item)} item={item} backend={backendFor(item.machine)} machine={several ? nameOf(item.machine) : ""} onOpen={() => setViewing(item)} />)}
      </div>
    </>}
    {viewing && <div className="library-viewer-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) setViewing(null); }}>
      <LibraryViewer item={viewing} backend={backendFor(viewing.machine)} bot={viewing.by} when={viewing.created} openable={threadExists(viewing.room, threads)}
        workspace={names.get(workspaceForRoom(viewing.room, threads) ?? "") ?? ""} machine={several ? nameOf(viewing.machine) : ""}
        onClose={() => setViewing(null)}
        onOpen={() => { setViewing(null); onOpenThread(viewing.room); }}
        onDelete={() => setQuestion({ title: "Delete this picture?", body: several ? `It is removed from ${nameOf(viewing.machine)}'s Library. The thread it came from is not changed.` : "It is removed from the Library. The thread it came from is not changed.", action: "Delete", onConfirm: () => { setQuestion(null); void remove(viewing); } })} />
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
      made = URL.createObjectURL(new Blob([bytes], { type: isVideoItem(item) ? videoType(item.file) : "" }));
      setUrl(made);
    }).catch(() => {});
    return () => { live = false; if (made) URL.revokeObjectURL(made); };
  }, [item.path, backend, enabled]);
  return url;
}

function LibraryTile({ item, backend, machine, onOpen }: { item: LibraryItem; backend: Backend | null; machine: string; onOpen: () => void }) {
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
  return <button ref={box} type="button" className="library-tile" onClick={onOpen} title={item.path}>
    <span className="library-thumb">{url && (video ? <video src={url} muted preload="metadata" aria-label={item.file} /> : <img src={url} alt={item.file} />)}{video && <span className="library-play" aria-hidden="true">▶</span>}</span>
    <span className="library-caption">{item.by ?? "A bot"} · {new Date(item.created).toLocaleDateString()}{machine && ` · ${machine}`}</span>
  </button>;
}

function LibraryViewer({ item, backend, bot, when, openable, workspace, machine, onClose, onOpen, onDelete }: {
  item: LibraryItem; backend: Backend | null; bot?: string; when: number; openable: boolean; workspace: string; machine: string;
  onClose: () => void; onOpen: () => void; onDelete: () => void;
}) {
  const url = useImage(item, backend, true);
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);
  return <div className="library-viewer" role="dialog" aria-label="Picture">
    <div className="library-viewer-image">{url && (isVideoItem(item) ? <video src={url} controls autoPlay aria-label={item.file} /> : <img src={url} alt={item.file} />)}</div>
    <div className="library-viewer-bar">
      <span className="library-caption">{bot ?? "A bot"} · {new Date(when).toLocaleString()}{workspace && ` · ${workspace}`}{machine && ` · ${machine}`}</span>
      <span className="library-viewer-actions">
        {openable && <button className="accent" onClick={onOpen}>Open thread</button>}
        <button className="danger" onClick={onDelete}>Delete</button>
        <button onClick={onClose}>Close</button>
      </span>
    </div>
  </div>;
}
