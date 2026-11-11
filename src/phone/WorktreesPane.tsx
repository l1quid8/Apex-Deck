// The thread's Worktrees pane: in from the right over the thread, opened by the branch icon in the title
// bar (a swipe from the edge already moves between open threads). Agent copies first, then the project's
// worktrees, each with the phone's bottom sheet for what you can do with it. The commands are the ones the
// Mac's Worktrees tab sends, so both always agree.
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { ChevronRight, Plus, RefreshCw, X } from "./icons";
import type { Backend } from "../backend";
import type { RoomOptions, Worktree, WorktreeAdd, WorktreeList } from "../types";
import { worktreeErrorMessage } from "../RightWorktrees";
import { mountWorktree } from "../worktreeMount";
import { copyText } from "../copyText";
import { hasChanges, newWorktreeFolder, shortPath, startFrom, worktreeActions, worktreeRow } from "./worktrees";

export interface WorktreesState { listing: WorktreeList | null; mounted: string; error: string; load(): Promise<void> }

/**
 * The project's worktrees and the folder this thread works in, read when the thread opens and again
 * whenever `refresh` changes (a reply finished: that is when an agent copy folds back or gets stuck).
 */
export function useWorktrees(backend: Backend | null, root: string, thread: string, enabled: boolean, refresh: string): WorktreesState {
  const [listing, setListing] = useState<WorktreeList | null>(null);
  const [mounted, setMounted] = useState(root);
  const [error, setError] = useState("");
  const loadId = useRef(0);
  const load = async () => {
    if (!enabled || !backend || !root) return;
    const id = ++loadId.current;
    try {
      const [list, state] = await Promise.all([backend.worktreeList(root), backend.roomState?.(thread).catch(() => null)]);
      if (id !== loadId.current) return;
      setListing(list); setMounted(state?.cwd || root); setError("");
    } catch (reason) {
      if (id === loadId.current) setError(worktreeErrorMessage(reason));
    }
  };
  useEffect(() => { setListing(null); setMounted(root); setError(""); }, [backend, root, thread]);
  useEffect(() => {
    void load();
    return () => { loadId.current++; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, backend, root, thread, refresh]);
  return { listing, mounted, error, load };
}

/** Some agent copy of this project is stuck and needs a person: the amber dot on the title bar's icon. */
export const copyNeedsYou = (listing: WorktreeList | null) => Boolean(listing?.items.some((item) => item.copy?.state === "needs_you"));

type Ask =
  | { kind: "row"; item: Worktree }
  | { kind: "add" }
  | { kind: "remove"; item: Worktree }
  | { kind: "prune"; item: Worktree }
  | { kind: "discard"; item: Worktree };

export function WorktreesPane(props: {
  backend: Backend; root: string; thread: string; threadTitle: string; project: string; machine: string;
  state: WorktreesState;
  /** Agents are mid-turn in this thread, so its folder can't change yet. */
  busyTurn: boolean;
  options: RoomOptions;
  onClose(): void;
  /** The phone's one-line notice at the bottom, for "Pathname copied" and the like. */
  onNotice(text: string): void;
}) {
  const { listing, mounted, error, load } = props.state;
  const [ask, setAsk] = useState<Ask | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const [request, setRequest] = useState<WorktreeAdd>({ branch: "", newBranch: true, base: null, folder: null });
  // Read again each time the pane opens, so it never shows what was true an hour ago.
  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);
  // While an agent copy is working, its state moves on its own; follow it as the Mac's tab does.
  const moving = Boolean(listing?.items.some((item) => item.copy && item.copy.state !== "needs_you" && item.copy.state !== "folded"));
  useEffect(() => {
    if (!moving) return;
    const timer = window.setInterval(() => void load(), 10000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [moving]);

  const close = () => { if (!busy) { setAsk(null); setProblem(""); } };
  /** Run one command; a folder with uncommitted changes asks again instead of failing. */
  const run = async (work: () => Promise<unknown>, onChanges?: () => void) => {
    setBusy(true); setProblem("");
    try { await work(); setAsk(null); await load(); }
    catch (reason) {
      if (onChanges && hasChanges(reason)) onChanges();
      else setProblem(String(reason).includes("room-busy:") ? "Agents are working in this thread. Mount it when they finish." : worktreeErrorMessage(reason));
    } finally { setBusy(false); }
  };
  const mount = (item: Worktree) => run(async () => {
    await mountWorktree(props.backend, props.thread, item.path, props.options);
    props.onNotice(`Now working in ${item.branch ?? item.path.split("/").pop()}.`);
  });
  const copyPath = async (path: string) => { setAsk(null); props.onNotice((await copyText(path)) ? "Pathname copied" : "The phone couldn't copy that path."); };
  const openAdd = () => {
    setProblem("");
    setRequest({ branch: "", newBranch: true, base: startFrom(listing?.items ?? []), folder: null });
    setAsk({ kind: "add" });
  };

  // ---- Swipe the pane back to the right to close it ----
  const [dragX, setDragX] = useState(0);
  const drag = useRef<{ x: number; y: number; id: number; on: boolean } | null>(null);
  const down = (event: ReactPointerEvent) => { drag.current = { x: event.clientX, y: event.clientY, id: event.pointerId, on: false }; };
  const move = (event: ReactPointerEvent<HTMLElement>) => {
    const start = drag.current;
    if (!start || start.id !== event.pointerId) return;
    const dx = event.clientX - start.x, dy = event.clientY - start.y;
    if (!start.on) {
      if (Math.abs(dx) < 12 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
      if (dx < 0) { drag.current = null; return; }
      start.on = true;
      try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* older WebViews */ }
    }
    setDragX(Math.max(0, dx));
  };
  const up = () => { const far = dragX > 80; drag.current = null; setDragX(0); if (far) props.onClose(); };

  const items = listing?.items ?? [];
  // This thread's copies first, then any that need you, as the Mac lists the rest.
  const rank = (item: Worktree) => item.copy?.thread === props.thread ? 0 : item.copy?.state === "needs_you" ? 1 : 2;
  const copies = items.filter((item) => item.copy).sort((a, b) => rank(a) - rank(b));
  const trees = items.filter((item) => !item.copy);
  const row = (item: Worktree) => {
    const view = worktreeRow(item, props.thread, mounted);
    return (
      <button key={item.path} type="button" className={`ph-srow ph-wt-row${ask && "item" in ask && ask.item.path === item.path ? " pressed" : ""}`}
        aria-label={`${view.name}${view.tag ? `, ${view.tag}` : ""}. ${view.line}${view.warn ? `. ${view.warn}` : ""}`}
        onClick={() => { setProblem(""); setAsk({ kind: "row", item }); }}>
        <i className={`ph-dot ph-wt-dot ${view.dot}`} aria-hidden="true" />
        <span className="ph-grow">
          <strong><span className="ph-wt-name">{view.name}</span>{view.tag && <em className={`ph-wt-tag${view.here ? " here" : ""}`}>{view.tag}</em>}</strong>
          <small>{view.line}</small>
          {view.warn && <small className="ph-wt-warn">{view.warn}</small>}
        </span>
        <ChevronRight size={16} />
      </button>
    );
  };

  return (
    <>
      <div className="ph-wt-back" aria-hidden="true" onClick={props.onClose} />
      <aside className={`ph-wt-pane${dragX ? " dragging" : ""}`} aria-label="Worktrees" style={dragX ? { transform: `translateX(${dragX}px)` } : undefined}
        inert={ask !== null} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={() => { drag.current = null; setDragX(0); }}>
        <header className="ph-wt-head">
          <div className="ph-wt-title">
            <h3>Worktrees</h3>
            <p className="ph-context"><span className="ph-context-project">{props.project}</span><span className="ph-context-machine">· {props.machine}</span></p>
          </div>
          <button type="button" className="ph-icon" aria-label="Refresh" onClick={() => void load()}><RefreshCw size={18} /></button>
          <button type="button" className="ph-icon" aria-label="Close Worktrees" onClick={props.onClose}><X size={20} /></button>
        </header>
        <div className="ph-wt-body">
          {error && <p className="ph-wt-error" role="alert">{error}</p>}
          {!listing && !error && <p className="ph-list-note ph-wt-first">Loading worktrees…</p>}
          {copies.length > 0 && <>
            <div className="ph-section"><span>Agent copies</span></div>
            <div className="ph-list">{copies.map(row)}</div>
          </>}
          {listing && <>
            <div className="ph-section">
              <span>Worktrees</span>
              <button type="button" className="ph-section-action ph-wt-add" aria-label="New worktree" onClick={openAdd}><Plus size={16} /><span>New</span></button>
            </div>
            <div className="ph-list">{trees.map(row)}</div>
            {trees.length === 0 && <p className="ph-list-note">No worktrees found.</p>}
            {items.some((item) => item.prunable) && (
              <button type="button" className="ph-list-add ph-wt-clean" disabled={busy} onClick={() => void run(() => props.backend.worktreePrune(props.root))}>Clean up missing</button>
            )}
            {copies.length > 0 && <p className="ph-foot">Agent copies come and go by themselves. Deck folds each one back when its agent finishes.</p>}
          </>}
        </div>
      </aside>
      {ask && <PaneSheet title={sheetTitle(ask)} onClose={close}>
        {ask.kind === "row" && <RowSheet item={ask.item} mounted={mounted} busy={busy} busyTurn={props.busyTurn} threadTitle={props.threadTitle}
          onMount={() => void mount(ask.item)} onCopy={() => void copyPath(ask.item.path)}
          onPrune={() => void run(() => props.backend.worktreeForget(props.root, ask.item.path, false), () => setAsk({ kind: "prune", item: ask.item }))}
          onRemove={() => void run(() => props.backend.worktreeRemove(props.root, ask.item.path, false), () => setAsk({ kind: ask.item.copy ? "discard" : "remove", item: ask.item }))} />}
        {ask.kind === "remove" && <>
          <p className="ph-sheet-text">{ask.item.branch ?? shortPath(ask.item.path)} has <b>{ask.item.changes ? `${ask.item.changes} ${ask.item.changes === 1 ? "change" : "changes"}` : "changes"} nobody has committed</b>. Removing deletes its folder and those changes.</p>
          <div className="ph-wt-sheet-list">
            <SheetRow danger label="Remove anyway" detail={`Delete the folder and the ${ask.item.changes && ask.item.changes !== 1 ? `${ask.item.changes} changes` : "change"}.`} disabled={busy} onClick={() => void run(() => props.backend.worktreeRemove(props.root, ask.item.path, true))} />
            <SheetRow label="Prune instead" detail="Keep the folder and changes; only forget it in git." disabled={busy} onClick={() => void run(() => props.backend.worktreeForget(props.root, ask.item.path, true))} />
          </div>
        </>}
        {ask.kind === "prune" && <>
          <p className="ph-sheet-text">{ask.item.branch ?? shortPath(ask.item.path)} has changes nobody has committed. Pruning keeps the folder and those changes on the Mac; git only forgets it.</p>
          <div className="ph-wt-sheet-list"><SheetRow label="Prune anyway" disabled={busy} onClick={() => void run(() => props.backend.worktreeForget(props.root, ask.item.path, true))} /></div>
        </>}
        {ask.kind === "discard" && <>
          <p className="ph-sheet-text">{ask.item.copy?.bot}’s copy has changes that never folded back. Discarding deletes the copy and all its changes.</p>
          <div className="ph-wt-sheet-list"><SheetRow danger label="Discard copy" disabled={busy} onClick={() => void run(() => props.backend.worktreeRemove(props.root, ask.item.path, true))} /></div>
        </>}
        {ask.kind === "add" && <form className="ph-wt-form" onSubmit={(event) => { event.preventDefault(); if (request.branch.trim()) void run(() => props.backend.worktreeAdd(props.root, { ...request, branch: request.branch.trim(), base: request.newBranch ? request.base || null : null, folder: request.folder || newWorktreeFolder(props.root, request.branch) })); }}>
          <label className="ph-label">Branch<input value={request.branch} autoCapitalize="off" autoCorrect="off" spellCheck={false} enterKeyHint="next"
            onChange={(event) => { const branch = event.target.value; setRequest((now) => ({ ...now, branch })); }} /></label>
          <div className="ph-segment" role="radiogroup" aria-label="Branch source">
            <button type="button" role="radio" aria-checked={request.newBranch} onClick={() => setRequest((now) => ({ ...now, newBranch: true, base: now.base ?? startFrom(items) }))}>New branch</button>
            <button type="button" role="radio" aria-checked={!request.newBranch} onClick={() => setRequest((now) => ({ ...now, newBranch: false }))}>Existing branch</button>
          </div>
          {request.newBranch && <label className="ph-label">Start from<input value={request.base ?? ""} autoCapitalize="off" autoCorrect="off" spellCheck={false} onChange={(event) => { const base = event.target.value; setRequest((now) => ({ ...now, base })); }} /></label>}
          <label className="ph-label">Folder<input className="ph-wt-mono" value={request.folder ?? (request.branch.trim() ? newWorktreeFolder(props.root, request.branch) : "")} placeholder={newWorktreeFolder(props.root, "branch-name")} autoCapitalize="off" autoCorrect="off" spellCheck={false}
            onChange={(event) => { const folder = event.target.value; setRequest((now) => ({ ...now, folder: folder || null })); }} /></label>
          <p className="ph-sheet-text">The folder fills in from the branch name. Change it if you like.</p>
          <button type="submit" className="primary ph-wide" disabled={busy || !request.branch.trim()}>{busy ? "Adding…" : "Add worktree"}</button>
        </form>}
        {problem && <p className="ph-wt-error" role="alert">{problem}</p>}
        {ask.kind !== "add" && <button type="button" className="ph-wide ph-wt-cancel" disabled={busy} onClick={close}>Cancel</button>}
      </PaneSheet>}
    </>
  );
}

function sheetTitle(ask: Ask): string {
  if (ask.kind === "add") return "New worktree";
  if (ask.kind === "remove") return "Remove this worktree?";
  if (ask.kind === "prune") return "Prune this worktree?";
  if (ask.kind === "discard") return "Discard this copy?";
  return ask.item.copy ? `${ask.item.copy.bot}’s copy` : ask.item.branch ?? "Detached worktree";
}

function RowSheet({ item, mounted, busy, busyTurn, threadTitle, onMount, onCopy, onPrune, onRemove }: {
  item: Worktree; mounted: string; busy: boolean; busyTurn: boolean; threadTitle: string;
  onMount(): void; onCopy(): void; onPrune(): void; onRemove(): void;
}) {
  const can = worktreeActions(item, mounted);
  const view = worktreeRow(item, "", mounted);
  const meta = item.copy
    ? [item.copy.threadTitle || item.copy.thread, view.line.split(" · ").slice(-2).join(" · ")].join(" · ")
    : [item.branch ? `Branch ${item.branch}` : "Detached", item.changes ? `${item.changes} changed ${item.changes === 1 ? "file" : "files"}` : null].filter(Boolean).join(" · ");
  return <>
    <p className="ph-sheet-text">{meta}</p>
    {item.copy?.state === "needs_you" && item.copy.reason && <p className="ph-sheet-text ph-wt-warn">{item.copy.reason}</p>}
    <p className="ph-path">{item.path}</p>
    <div className="ph-wt-sheet-list">
      {can.mount && (can.mounted
        ? <SheetRow label="Mounted in this thread" detail="Agents in this thread work in this folder." disabled onClick={() => {}} />
        : <SheetRow label="Mount in this thread" detail={busyTurn ? "Agents are working. Mount it when they finish." : `Agents in ${threadTitle} work in this folder from their next turn.`} disabled={busy || busyTurn} onClick={onMount} />)}
      <SheetRow label="Copy pathname" disabled={busy} onClick={onCopy} />
      {can.discard && <SheetRow danger label="Discard copy…" detail="Delete the copy and the changes that didn't fold back." disabled={busy} onClick={onRemove} />}
      {can.prune && <SheetRow label="Prune" detail="Forget it in git. The folder and its changes stay on the Mac." disabled={busy} onClick={onPrune} />}
      {can.remove && <SheetRow danger label="Remove…" detail="Delete the folder and forget it." disabled={busy} onClick={onRemove} />}
    </div>
  </>;
}

function SheetRow({ label, detail, danger, disabled, onClick }: { label: string; detail?: string; danger?: boolean; disabled?: boolean; onClick(): void }) {
  return (
    <button type="button" className={`ph-srow${danger ? " ph-wt-danger" : ""}`} disabled={disabled} onClick={onClick}>
      <span className="ph-grow"><strong>{label}</strong>{detail && <small>{detail}</small>}</span>
    </button>
  );
}

/** The phone's bottom sheet, over the pane rather than the thread. */
function PaneSheet({ title, onClose, children }: { title: string; onClose(): void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  return (
    <div className="ph-sheet-back ph-wt-over" onClick={onClose}>
      <div className="ph-sheet" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={ref} onClick={(event) => event.stopPropagation()} onKeyDown={(event) => { if (event.key === "Escape") onClose(); }}>
        <div className="ph-handle" />
        <div className="ph-sheet-title"><h3>{title}</h3></div>
        <div className="ph-sheet-body ph-wt-sheet-body">{children}</div>
      </div>
    </div>
  );
}
