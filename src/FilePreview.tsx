import { useEffect, useMemo, useState } from "react";
import type { FilePreview as Preview, ThreadDiff } from "./types";
import type { Backend } from "./backend";
import { Markdown } from "./Markdown";
import { writeClipboard } from "./threadCopy";
import { FileEditSession } from "./FileEditSession";
import { isEditable } from "./fileEditorModel";
import { pathBase, pathDir, revealInFileManagerLabel } from "./paths";

type View = "file" | "changes";
export function FilePreviewPanel({ root, path, backend, diff, local, paneId, view, onView, onClose, highlightLine = null, onDirtyChange, onSaved }: {
  root: string; path: string; backend: Backend; diff: ThreadDiff | null; local: boolean; paneId: string | null; view: View; onView(view: View): void; onClose(): void;
  highlightLine?: number | null; onDirtyChange?(dirty: boolean): void; onSaved?(): void;
}) {
  const [preview, setPreview] = useState<Preview | null>(null), [error, setError] = useState<string | null>(null), [markdownSource, setMarkdownSource] = useState(false), [copyStatus, setCopyStatus] = useState(""), [editing, setEditing] = useState(false), [dirty, setDirty] = useState(false), [savedSize, setSavedSize] = useState<number | null>(null);
  const relative = path.startsWith(`${root.replace(/\/$/, "")}/`) ? path.slice(root.replace(/\/$/, "").length + 1) : path;
  const file = useMemo(() => diff?.files.find((entry) => (entry.path.startsWith("/") ? entry.path : `${root.replace(/\/$/, "")}/${entry.path}`) === path) ?? null, [diff, path, root]);
  const deleted = !!file?.patch.includes("\n+++ /dev/null");
  const editable = isEditable(preview, view, deleted);
  useEffect(() => { if (view === "changes") { setEditing(false); setDirty(false); } }, [view]);
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty]);
  useEffect(() => {
    if (editing) return;
    if (view === "changes") { setPreview(null); setError(null); return; }
    if (file?.patch.includes("\n+++ /dev/null")) { setPreview(null); setError("This file was deleted in the current thread."); return; }
    let live = true; setPreview(null); setError(null); setSavedSize(null);
    void backend.fileRead(root, path).then((value) => { if (live) setPreview(value); }, (reason) => { if (live) setError(String(reason)); });
    return () => { live = false; };
  }, [backend, file, path, root, view, editing]);
  useEffect(() => {
    if (!highlightLine || view !== "file") return;
    requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-file-line="${highlightLine}"]`)?.scrollIntoView({ block: "center" }));
  }, [highlightLine, preview, view]);
  const copyPath = async () => { const ok = await writeClipboard(relative, navigator.clipboard); setCopyStatus(ok ? "Copied" : "Clipboard unavailable"); window.setTimeout(() => setCopyStatus(""), 1500); };
  const addToChat = () => { if (paneId) window.dispatchEvent(new CustomEvent("deck:insert-composer", { detail: { paneId, text: `\`${relative}\`` } })); };
  const size = savedSize ?? (preview && "size" in preview ? preview.size : null);
  const sizeLabel = (value: number | null) => value === null ? "" : value < 1024 ? `${value} B` : value < 1024 * 1024 ? `${(value / 1024).toFixed(1)} KB` : `${(value / 1024 / 1024).toFixed(1)} MB`;
  const revealLabel = revealInFileManagerLabel();
  const relDir = pathDir(relative);
  return <section className="right-files-preview" aria-label={`Preview ${relative}`}>
    <div className="right-files-preview-header"><div className="right-files-preview-title"><strong>{pathBase(path)}{dirty && <span className="file-edit-dirty" title="Unsaved changes" aria-hidden="true"> ●</span>}</strong><span className="muted">{relDir || "Project root"}{size !== null && ` · ${sizeLabel(size)}`}</span></div><div className="right-files-preview-actions">{editable && !editing && <button title="Edit this file" aria-label="Edit file" onClick={() => setEditing(true)}>Edit</button>}<button title="Copy relative path" aria-label="Copy path" onClick={() => void copyPath()}>Copy path</button>{copyStatus && <span className="muted" role="status">{copyStatus}</span>}{local && <><button title="Open in default app" aria-label="Open in default app" onClick={() => void backend.openTarget(path, root, false).catch(() => {})}>Open</button><button title={revealLabel} aria-label={revealLabel} onClick={() => void backend.openTarget(path, root, true).catch(() => {})}>Reveal</button></>}{paneId && <button title="Add path to chat" aria-label="Add to chat" onClick={addToChat}>Add to chat</button>}<button title="Close preview" aria-label="Close preview" onClick={onClose}>×</button></div></div>
    {file && <div className="right-files-view-switch" role="group" aria-label="Preview view"><button aria-pressed={view === "file"} onClick={() => onView("file")}>File</button><button aria-pressed={view === "changes"} onClick={() => onView("changes")}>Changes</button></div>}
    <div className={`right-files-preview-content${editing ? " editing" : ""}`}>
      {editing && preview?.kind === "text" ? <FileEditSession root={root} path={path} backend={backend} initial={preview} onDirty={setDirty} onDone={() => setEditing(false)} onSaved={(text) => { setSavedSize(new TextEncoder().encode(text).length); onSaved?.(); }} />
        : view === "changes" ? file ? <PatchView patch={file.patch} /> : <p className="muted">This file has no changes in the current thread.</p>
        : error ? <p className="muted">Couldn&apos;t preview this file. {error}</p>
        : !preview ? <p className="muted">Loading preview…</p>
        : preview.kind === "text" ? <><div className="right-files-preview-text-toolbar">{path.toLowerCase().endsWith(".md") && <button aria-pressed={!markdownSource} onClick={() => setMarkdownSource(false)}>Preview</button>}{path.toLowerCase().endsWith(".md") && <button aria-pressed={markdownSource} onClick={() => setMarkdownSource(true)}>Source</button>}</div>{path.toLowerCase().endsWith(".md") && !markdownSource ? <div className="right-files-markdown"><Markdown text={preview.text} onOpen={(target) => void backend.openTarget(target, root, false).catch(() => {})} /></div> : <Lines text={preview.text} highlightLine={highlightLine} />}{preview.truncated && <p className="right-files-truncated muted">Truncated — showing the first 512 KB</p>}</>
        : preview.kind === "image" ? <img className="right-files-image" src={`data:${preview.mime};base64,${preview.data}`} alt={pathBase(path) || "Project image"} />
        : <p className="muted">{preview.kind === "binary" ? `Binary file · ${sizeLabel(preview.size)}` : `File is too large to preview · ${sizeLabel(preview.size)}`}{local && <button onClick={() => void backend.openTarget(path, root, false).catch(() => {})}> Open in default app</button>}</p>}
    </div>
  </section>;
}

function Lines({ text, highlightLine = null }: { text: string; highlightLine?: number | null }) {
  const lines = text.split("\n");
  return <pre className="right-files-code" aria-label="File contents">{lines.map((line, index) => <span className={`right-files-code-line${highlightLine === index + 1 ? " search-hit" : ""}`} data-file-line={index + 1} key={index}><span className="right-files-line-number">{index + 1}</span><code>{line || " "}</code></span>)}</pre>;
}

function PatchView({ patch }: { patch: string }) {
  return <pre className="right-files-patch" aria-label="File changes">{patch.split("\n").map((line, index) => <span className={`right-files-patch-line${line.startsWith("+") ? " added" : line.startsWith("-") ? " removed" : ""}`} key={index}>{line || " "}</span>)}</pre>;
}
