import { useEffect, useRef, useState } from "react";
import type { FolderListing, ThreadDiff } from "./types";
import type { Backend } from "./backend";

const join = (dir: string, name: string) => `${dir.replace(/\/$/, "")}/${name}`;
export function changedSet(diff: ThreadDiff | null, root: string): Set<string> {
  if (!diff) return new Set();
  return new Set(diff.files.map((file) => file.path.startsWith("/") ? file.path : join(root, file.path)));
}
export function FilesError({ onRetry }: { onRetry: () => void }) { return <div className="right-panel-empty"><p className="muted">Can&apos;t read this folder.</p><button onClick={onRetry}>Retry</button></div>; }
export function RightFiles({ root, list, diff, onOpen }: { root: string | null; list: (path: string) => Promise<FolderListing>; diff: ThreadDiff | null; onOpen: (path: string) => void }) {
  if (!root) return <p className="muted right-panel-empty">This project has no folder.</p>;
  return <ul className="right-files" role="tree" aria-label="Files"><Folder key={root} path={root} list={list} changed={changedSet(diff, root)} onOpen={onOpen}/></ul>;
}

export function RightFilesTab({ root, backend, threadId, visible, onOpen }: { root: string | null; backend: Backend | null; threadId: string | null; visible: boolean; onOpen: (path: string) => void }) {
  const [diff, setDiff] = useState<ThreadDiff | null>(null);
  useEffect(() => {
    if (!visible || !threadId || !backend) { setDiff(null); return; }
    let live = true;
    void backend.roomDiff(threadId).then((value) => { if (live) setDiff(value); }, () => { if (live) setDiff(null); });
    return () => { live = false; };
  }, [visible, threadId, backend]);
  if (!backend) return <p className="muted right-panel-empty">This project machine is unavailable.</p>;
  return <RightFiles root={root} list={(path) => backend.listFolder(path)} diff={diff} onOpen={onOpen} />;
}
function Folder({ path, list, changed, onOpen }: { path: string; list: (path: string) => Promise<FolderListing>; changed: Set<string>; onOpen: (path: string) => void }) {
  const [listing, setListing] = useState<FolderListing | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const listRef = useRef(list);
  listRef.current = list;
  const load = () => { setFailed(false); setListing(null); void listRef.current(path).then(setListing, () => setFailed(true)); };
  useEffect(load, [path]);
  if (failed) return <li><FilesError onRetry={load}/></li>;
  if (!listing) return <li className="muted right-files-loading">Loading…</li>;
  return <>{listing.folders.map((name) => { const full = join(path, name); return <li key={full} role="treeitem" aria-expanded={!!open[full]}><button className="right-files-item" onClick={() => setOpen((state) => ({ ...state, [full]: !state[full] }))}>{open[full] ? "▾" : "▸"} {name}</button>{open[full] && <ul role="group"><Folder path={full} list={list} changed={changed} onOpen={onOpen}/></ul>}</li>; })}{listing.files.map((name) => { const full = join(path, name); return <li key={full} role="treeitem"><button className={`right-files-item${changed.has(full) ? " changed" : ""}`} onClick={() => onOpen(full)} title={changed.has(full) ? "Changed in this thread" : undefined}>{name}{changed.has(full) && <span className="right-files-mark" aria-label="changed">M</span>}</button></li>; })}{listing.truncated && <li className="muted">More files not shown.</li>}</>;
}
