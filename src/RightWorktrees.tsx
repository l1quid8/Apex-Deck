import { useEffect, useRef, useState } from "react";
import type { Backend } from "./backend";
import type { Worktree, WorktreeAdd, WorktreeList } from "./types";

const shorten = (path: string) => path.length > 48 ? `…${path.slice(-47)}` : path;
const initialRequest = (branch = ""): WorktreeAdd => ({ branch, newBranch: true, base: "HEAD", folder: null });

export function RightWorktreesTab({ root, backend, visible, onOpen }: { root: string | null; backend: Backend | null; visible: boolean; onOpen: (path: string) => void }) {
  const [listing, setListing] = useState<WorktreeList | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [adding, setAdding] = useState(false);
  const [request, setRequest] = useState<WorktreeAdd>(initialRequest());
  const [confirm, setConfirm] = useState<string | null>(null);
  const loadId = useRef(0);
  const load = async () => {
    if (!root || !backend) return;
    const id = ++loadId.current; setError("");
    try { const result = await backend.worktreeList(root); if (id === loadId.current) setListing(result); }
    catch (reason) { if (id === loadId.current) { setError(reason instanceof Error ? reason.message : String(reason)); setListing(null); } }
  };
  useEffect(() => { if (visible) void load(); return () => { loadId.current++; }; }, [visible, root, backend]);
  useEffect(() => { setListing(null); setRequest(initialRequest()); setAdding(false); setConfirm(null); setError(""); }, [root]);
  const doAdd = async () => {
    if (!root || !backend) return;
    setBusy("add"); setError("");
    try { await backend.worktreeAdd(root, request); setAdding(false); setRequest(initialRequest()); await load(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(""); }
  };
  const doRemove = async (path: string, force = false) => {
    if (!root || !backend) return;
    setBusy(path); setError(""); setConfirm(null);
    try { await backend.worktreeRemove(root, path, force); await load(); }
    catch (reason) { const message = reason instanceof Error ? reason.message : String(reason); if (message.startsWith("has-changes:")) setConfirm(path); else setError(message); }
    finally { setBusy(""); }
  };
  const doPrune = async () => {
    if (!root || !backend) return;
    setBusy("prune"); setError("");
    try { await backend.worktreePrune(root); await load(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(""); }
  };
  const branchChanged = (branch: string) => {
    const rootPath = (listing?.root ?? root ?? "").replaceAll("\\", "/");
    const parent = rootPath.slice(0, Math.max(0, rootPath.lastIndexOf("/")));
    const name = rootPath.slice(rootPath.lastIndexOf("/") + 1);
    setRequest((current) => ({ ...current, branch, folder: `${parent}/${name}-worktrees/${branch.replaceAll("/", "-")}` }));
  };
  if (!root) return <p className="muted right-panel-empty">This project has no folder.</p>;
  if (!backend) return <p className="muted right-panel-empty">This project machine is unavailable.</p>;
  return <section className="right-worktrees" aria-label="Git worktrees">
    <header className="right-worktrees-toolbar">
      <button type="button" onClick={() => { setAdding((value) => !value); setError(""); }} disabled={!!busy}>{adding ? "Cancel" : "New worktree"}</button>
      <button type="button" aria-label="Refresh worktrees" title="Refresh" onClick={() => void load()} disabled={!!busy}>↻</button>
    </header>
    {adding && <form className="right-worktrees-form" onSubmit={(event) => { event.preventDefault(); void doAdd(); }}>
      <label>Branch<input autoFocus value={request.branch} onChange={(event) => branchChanged(event.target.value)} required /></label>
      <div className="right-worktrees-switch" role="group" aria-label="Branch source">
        <button type="button" aria-pressed={request.newBranch} onClick={() => setRequest((value) => ({ ...value, newBranch: true }))}>New branch</button>
        <button type="button" aria-pressed={!request.newBranch} onClick={() => setRequest((value) => ({ ...value, newBranch: false, base: null }))}>Existing branch</button>
      </div>
      {request.newBranch && <label>New branch from<input value={request.base ?? ""} onChange={(event) => setRequest((value) => ({ ...value, base: event.target.value }))} /></label>}
      <label>Folder<input value={request.folder ?? ""} onChange={(event) => setRequest((value) => ({ ...value, folder: event.target.value || null }))} required /></label>
      <button type="submit" disabled={!!busy || !request.branch.trim()}>{busy === "add" ? "Adding…" : "Add worktree"}</button>
      {error && <p className="right-worktrees-error" role="alert">{error}</p>}
    </form>}
    {!listing && !error && <p className="muted right-worktrees-empty">Loading worktrees…</p>}
    {error && !adding && <p className="right-worktrees-error" role="alert">{error}</p>}
    {listing && listing.items.length === 0 && <p className="muted right-worktrees-empty">No worktrees found.</p>}
    {listing && <ul className="right-worktrees-list">{listing.items.map((item) => <WorktreeRow key={item.path} item={item} busy={busy === item.path} confirm={confirm === item.path} onOpen={onOpen} onRemove={(force) => void doRemove(item.path, force)} onCancel={() => setConfirm(null)} />)}</ul>}
    {listing?.items.some((item) => item.prunable) && <button type="button" className="right-worktrees-prune" onClick={() => void doPrune()} disabled={!!busy}>{busy === "prune" ? "Cleaning…" : "Clean up missing"}</button>}
  </section>;
}
export function WorktreeRow({ item, busy, confirm, onOpen, onRemove, onCancel }: { item: Worktree; busy: boolean; confirm: boolean; onOpen: (path: string) => void; onRemove: (force: boolean) => void; onCancel: () => void }) {
  const branch = item.branch ?? (item.head ? `detached · ${item.head.slice(0, 8)}` : "detached");
  const labels = [item.main && "Main", item.changes != null && item.changes > 0 && `Changes · ${item.changes}`, item.locked && "Locked", item.prunable && "Missing", item.task && "ApexAgent task"].filter(Boolean) as string[];
  return <li className="right-worktrees-row">
    <div className="right-worktrees-heading"><strong>{branch}</strong><span className="right-worktrees-actions">
      {confirm ? <><span className="right-worktrees-confirm">Has uncommitted changes</span><button type="button" onClick={() => onRemove(true)} disabled={busy}>Remove anyway</button><button type="button" onClick={onCancel}>Cancel</button></> : <>
        <button type="button" onClick={() => onOpen(item.path)}>Open folder</button>
        {!item.main && !item.task && !item.prunable && <button type="button" onClick={() => onRemove(false)} disabled={busy}>Remove</button>}
      </>}
    </span></div>
    <div className="right-worktrees-meta"><span title={item.path}>{shorten(item.path)}</span>{labels.map((label) => <span key={label} className="right-worktrees-label">{label}</span>)}</div>
  </li>;
}
