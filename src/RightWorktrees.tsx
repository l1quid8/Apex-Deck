import { useEffect, useRef, useState } from "react";
import type { Backend } from "./backend";
import type { Worktree, WorktreeAdd, WorktreeList } from "./types";
import { writeClipboard } from "./threadCopy";

const shorten = (path: string) => path.length > 48 ? `…${path.slice(-47)}` : path;
const initialRequest = (branch = ""): WorktreeAdd => ({ branch, newBranch: true, base: "HEAD", folder: null });
const OLD_SERVICE = "This machine's Deck service is out of date. Update Deck to manage worktrees.";
const GENERIC_ERROR = "Couldn't manage worktrees. Check the service and try again.";

export function worktreeErrorMessage(reason: unknown): string {
  const message = String((reason as Error)?.message ?? reason);
  return /unknown variant [`'\"]?worktree_(?:list|add|remove|forget|prune)|unknown command.*worktree_(?:list|add|remove|forget|prune)|unsupported.*worktree_(?:list|add|remove|forget|prune)/i.test(message)
    ? OLD_SERVICE
    : GENERIC_ERROR;
}

export function RightWorktreesTab({ root, backend, visible, onOpen }: { root: string | null; backend: Backend | null; visible: boolean; onOpen: (path: string) => void }) {
  const [listing, setListing] = useState<WorktreeList | null>(null);
  const [error, setError] = useState("");
  const [copyStatus, setCopyStatus] = useState("");
  const [busy, setBusy] = useState("");
  const [adding, setAdding] = useState(false);
  const [request, setRequest] = useState<WorktreeAdd>(initialRequest());
  const [confirm, setConfirm] = useState<{ path: string; action: "prune" | "remove" } | null>(null);
  const loadId = useRef(0);
  const copyTimer = useRef<number | undefined>(undefined);
  const load = async () => {
    if (!root || !backend) return;
    const id = ++loadId.current; setError("");
    try { const result = await backend.worktreeList(root); if (id === loadId.current) setListing(result); }
    catch (reason) { if (id === loadId.current) { setError(worktreeErrorMessage(reason)); setListing(null); } }
  };
  useEffect(() => { if (visible) void load(); return () => { loadId.current++; }; }, [visible, root, backend]);
  useEffect(() => {
    setListing(null); setRequest(initialRequest()); setAdding(false); setConfirm(null); setError(""); setCopyStatus("");
    return () => window.clearTimeout(copyTimer.current);
  }, [root]);
  const copyPathname = async (path: string) => {
    window.clearTimeout(copyTimer.current);
    setCopyStatus("");
    const ok = await writeClipboard(path, navigator.clipboard);
    setCopyStatus(ok ? "Pathname copied" : "Clipboard unavailable");
    copyTimer.current = window.setTimeout(() => setCopyStatus(""), 1500);
  };
  const doAdd = async () => {
    if (!root || !backend) return;
    setBusy("add"); setError("");
    try { await backend.worktreeAdd(root, request); setAdding(false); setRequest(initialRequest()); await load(); }
    catch (reason) { const message = worktreeErrorMessage(reason); setError(message); if (message === OLD_SERVICE) setAdding(false); }
    finally { setBusy(""); }
  };
  const doPruneOne = async (path: string, force = false) => {
    if (!root || !backend) return;
    setBusy(path); setError(""); setConfirm(null);
    try { await backend.worktreeForget(root, path, force); await load(); }
    catch (reason) { const message = String((reason as Error)?.message ?? reason); if (message.startsWith("has-changes:")) setConfirm({ path, action: "prune" }); else { const safe = worktreeErrorMessage(reason); setError(safe); if (safe === OLD_SERVICE) setAdding(false); } }
    finally { setBusy(""); }
  };
  const doRemove = async (path: string, force = false) => {
    if (!root || !backend) return;
    setBusy(path); setError(""); setConfirm(null);
    try { await backend.worktreeRemove(root, path, force); await load(); }
    catch (reason) { const message = String((reason as Error)?.message ?? reason); if (message.startsWith("has-changes:")) setConfirm({ path, action: "remove" }); else { const safe = worktreeErrorMessage(reason); setError(safe); if (safe === OLD_SERVICE) setAdding(false); } }
    finally { setBusy(""); }
  };
  const doPrune = async () => {
    if (!root || !backend) return;
    setBusy("prune"); setError("");
    try { await backend.worktreePrune(root); await load(); }
    catch (reason) { const message = worktreeErrorMessage(reason); setError(message); if (message === OLD_SERVICE) setAdding(false); }
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
      {error !== OLD_SERVICE && <button type="button" onClick={() => { setAdding((value) => !value); setError(""); }} disabled={!!busy}>{adding ? "Cancel" : "New worktree"}</button>}
      <span className="muted right-worktrees-copy-status" role="status">{copyStatus}</span>
      <button type="button" aria-label="Refresh worktrees" title="Refresh" onClick={() => void load()} disabled={!!busy}>↻</button>
    </header>
    {adding && error !== OLD_SERVICE && <form className="right-worktrees-form" onSubmit={(event) => { event.preventDefault(); void doAdd(); }}>
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
    {listing && <ul className="right-worktrees-list">{listing.items.map((item) => <WorktreeRow key={item.path} item={item} busy={busy === item.path} confirm={confirm?.path === item.path && confirm.action === "remove"} pruneConfirm={confirm?.path === item.path && confirm.action === "prune"} onOpen={onOpen} onCopy={(path) => void copyPathname(path)} onRemove={(force) => void doRemove(item.path, force)} onPrune={(force) => { void doPruneOne(item.path, force); }} onCancel={() => setConfirm(null)} />)}</ul>}
    {listing?.items.some((item) => item.prunable) && <button type="button" className="right-worktrees-prune" onClick={() => void doPrune()} disabled={!!busy}>{busy === "prune" ? "Cleaning…" : "Clean up missing"}</button>}
  </section>;
}
export function WorktreeRow({ item, busy, confirm, pruneConfirm, onOpen, onCopy, onRemove, onPrune, onCancel }: { item: Worktree; busy: boolean; confirm: boolean; pruneConfirm?: boolean; onOpen: (path: string) => void; onCopy: (path: string) => void; onRemove: (force: boolean) => void; onPrune?: (force: boolean) => void; onCancel: () => void }) {
  const branch = item.branch ?? (item.head ? `detached · ${item.head.slice(0, 8)}` : "detached");
  const labels = [item.main && "Main", item.changes != null && item.changes > 0 && `Changes · ${item.changes}`, item.locked && "Locked", item.prunable && "Missing", item.task && "ApexAgent task"].filter(Boolean) as string[];
  const actionable = !item.main && !item.task;
  return <li className="right-worktrees-row">
    <div className="right-worktrees-heading"><strong>{branch}</strong><div className="right-worktrees-actions">
      {confirm ? <><span className="right-worktrees-confirm">Delete folder and uncommitted changes?</span><button type="button" onClick={() => onRemove(true)} disabled={busy}>Remove anyway</button><button type="button" onClick={onCancel}>Cancel</button></>
      : pruneConfirm && onPrune ? <><span className="right-worktrees-confirm">Unregister worktree; keep files and changes?</span><button type="button" onClick={() => onPrune(true)} disabled={busy}>Prune anyway</button><button type="button" onClick={onCancel}>Cancel</button></> : <>
        <details className="right-worktrees-menu" onKeyDown={(event) => { if (event.key === "Escape") { event.currentTarget.open = false; event.currentTarget.querySelector("summary")?.focus(); } }} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) event.currentTarget.open = false; }}>
          <summary aria-label="Worktree actions" title="Worktree actions">⋯</summary>
          <div className="right-worktrees-menu-items">
            <button type="button" onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); onOpen(item.path); }}>Open folder</button>
            <button type="button" onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); onCopy(item.path); }}>Copy pathname</button>
            {actionable && <>
              <hr />
            {!item.prunable && <button type="button" title="Delete folder and unregister worktree" disabled={busy || item.locked} onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); onRemove(false); }}>Remove</button>}
            {onPrune && <button type="button" title="Unregister worktree and keep files on disk" disabled={busy || item.locked} onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); onPrune(false); }}>Prune</button>}
            </>}
          </div>
        </details>
      </>}
    </div></div>
    <div className="right-worktrees-meta"><span title={item.path}>{shorten(item.path)}</span>{labels.map((label) => <span key={label} className="right-worktrees-label">{label}</span>)}</div>
  </li>;
}
