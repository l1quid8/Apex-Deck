import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

import type { Backend } from "./backend";
import { useHostConnection } from "./useHostConnection";
import { hostCanMutate } from "./hostAvailability";
import type { PathRequest } from "./typedPath";
import { folderRows, listingUnsupported, pathPrompt } from "./typedPath";
import type { FolderListing } from "./types";

const FOLDER_ICON = <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 4.5v8a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1v-6.5a1 1 0 0 0-1-1H8L6.5 3h-4a1 1 0 0 0-1 1.5z" /></svg>;
const FILE_ICON = <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 1.5h5.5L12.5 4.5v9.5a.5.5 0 0 1-.5.5H4a.5.5 0 0 1-.5-.5v-12a.5.5 0 0 1 .5-.5zM9.5 1.5v3h3" /></svg>;

/** Picks a folder or file on a host on another machine by looking through its folders. */
export function PathPrompt({ backend }: { backend: Backend }) {
  const request = useSyncExternalStore(pathPrompt.subscribe, pathPrompt.get);
  if (!request) return null;
  let target: Backend;
  try { target = backend.machines?.get(request.hostId) ?? backend; }
  catch (error) { return <div className="confirm-backdrop"><div role="alert">{String(error)}<button onClick={() => pathPrompt.answer(null)}>Cancel</button></div></div>; }
  return <HostPathPrompt key={request.hostId ?? "local"} backend={target} request={request} />;
}
function HostPathPrompt({ backend, request }: { backend: Backend; request: PathRequest }) {
  const { name: host, status } = useHostConnection(backend);
  const [listing, setListing] = useState<FolderListing | null>(null);
  const [typed, setTyped] = useState("");
  const [file, setFile] = useState<string | null>(null);
  const [hidden, setHidden] = useState(false);
  const [problem, setProblem] = useState("");
  const [loading, setLoading] = useState(false);
  /** The host's apex-daemon can't list folders, so the path is typed. */
  const [typeOnly, setTypeOnly] = useState(false);
  const asked = useRef(0);
  const list = useRef<HTMLUListElement>(null);

  /** Show the folder at `path` (null is home). False when it can't be opened. */
  const open = useCallback(async (path: string | null) => {
    const ask = ++asked.current;
    setLoading(true);
    setProblem("");
    try {
      const next = await backend.listFolder(path);
      if (ask !== asked.current) return true;
      setListing(next);
      setTyped(next.path);
      setFile(null);
      list.current?.scrollTo?.({ top: 0 });
      return true;
    } catch (error) {
      if (ask !== asked.current) return true;
      if (listingUnsupported(error)) {
        setTypeOnly(true);
        return true;
      }
      setProblem(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      if (ask === asked.current) setLoading(false);
    }
  }, [backend]);

  useEffect(() => {
    setListing(null);
    setTyped("");
    setFile(null);
    setHidden(false);
    setProblem("");
    setTypeOnly(false);
    const start = pathPrompt.startAt(request.hostId);
    // The last folder may be gone; home is always there.
    void open(start).then((ok) => { if (!ok && start && pathPrompt.get() === request) void open(null); });
    return () => { asked.current++; };
  }, [request, open]);

  const what = request.kind === "directory" ? "Folder" : "File";
  const rows = listing ? folderRows(listing, request.kind, hidden) : [];
  const chosen = typeOnly ? typed.trim() || null : request.kind === "directory" ? listing?.path ?? null : file;
  const cancel = () => pathPrompt.answer(null);
  const choose = async () => {
    if (!chosen || loading || !hostCanMutate(status)) return;
    const token = asked.current;
    if (typeOnly) {
      if (!chosen.startsWith("/")) return setProblem("Use a full path, starting with /.");
      setLoading(true);
      const [there] = await backend.pathsExist([chosen], null).catch(() => [false]);
      if (token !== asked.current || pathPrompt.get() !== request) return;
      setLoading(false);
      if (!there) return setProblem(`Nothing is at ${chosen} on ${host}.`);
    }
    if (pathPrompt.get() === request) pathPrompt.answer(chosen);
  };
  return (
    <div className="confirm-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) cancel(); }}>
      <form className="confirm path-prompt" role="dialog" aria-modal="true" aria-labelledby="path-prompt-title"
        onSubmit={(event) => { event.preventDefault(); void choose(); }}
        onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); cancel(); } }}>
        <strong id="path-prompt-title">{what} on {host}</strong>
        <p className="muted">{request.title}. {typeOnly ? `The apex-daemon on ${host} is too old to list its folders, so type the full path, or update apex-daemon there.`
          : request.kind === "directory" ? "Open the folder you want, then choose it." : "Pick a file, then choose it."}</p>
        <div className="folder-bar">
          {!typeOnly && <>
            <button type="button" title="Enclosing folder" aria-label="Enclosing folder" disabled={!listing?.parent || loading}
              onClick={() => listing?.parent && void open(listing.parent)}>↑</button>
            <button type="button" title="Home folder" aria-label="Home folder" disabled={loading} onClick={() => void open(null)}>~</button>
          </>}
          <input autoFocus className="mono" value={typed} spellCheck={false} autoCapitalize="off" autoCorrect="off"
            placeholder="/home/me/project" aria-label={`Go to a folder on ${host}`}
            aria-invalid={problem ? true : undefined} aria-describedby={problem ? "path-prompt-problem" : undefined}
            onChange={(event) => { setTyped(event.target.value); setProblem(""); }}
            onKeyDown={(event) => {
              // Enter on a changed path goes there; on the folder shown, it chooses.
              if (event.key === "Enter" && !typeOnly && typed.trim() !== listing?.path) { event.preventDefault(); void open(typed); }
            }} />
        </div>
        {!typeOnly && <>
          <ul ref={list} className="folder-list" aria-label={listing ? `In ${listing.path}` : "Loading"} aria-busy={loading}>
            {rows.map((row) => (
              <li key={row.path}>
                <button type="button" className={row.path === file ? "selected" : undefined} aria-pressed={row.folder ? undefined : row.path === file}
                  title={row.folder ? `Open ${row.name}` : row.name}
                  onClick={() => row.folder ? void open(row.path) : setFile(row.path)}
                  onDoubleClick={() => { if (!row.folder && hostCanMutate(status) && pathPrompt.get() === request) pathPrompt.answer(row.path); }}>
                  {row.folder ? FOLDER_ICON : FILE_ICON}
                  <span>{row.name}</span>
                </button>
              </li>
            ))}
            {listing && !rows.length && <li className="muted folder-empty">{request.kind === "directory" ? "No folders in here." : "Nothing in here."}</li>}
          </ul>
          <div className="folder-foot">
            <label><input type="checkbox" checked={hidden} onChange={(event) => setHidden(event.target.checked)} /> Show hidden</label>
            {listing?.truncated && <span className="muted">Only the first {(listing.folders.length + listing.files.length).toLocaleString()} are shown.</span>}
          </div>
        </>}
        {problem && <span id="path-prompt-problem" className="error" role="alert">{problem}</span>}
        <div className="confirm-actions">
          <button type="button" onClick={cancel}>Cancel</button>
          <button type="submit" className="primary" disabled={!chosen || loading || !hostCanMutate(status)}>{typeOnly ? (loading ? "Checking…" : "Choose") : request.kind === "directory" ? "Choose this folder" : "Choose"}</button>
        </div>
      </form>
    </div>
  );
}
