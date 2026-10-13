import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Backend } from "./backend";
import { ConfirmDialog, type Question } from "./ConfirmDialog";
import { FileEditor } from "./FileEditor";
import { isDirty, saveErrorKind, saveErrorMessage, type EditablePreview } from "./fileEditorModel";
import { writeClipboard } from "./threadCopy";

/** One editing run for one file: the toolbar, the conflict bar and the editor. It owns the draft text. */
export function FileEditSession({ root, path, backend, initial, onDirty, onDone, onSaved }: {
  root: string; path: string; backend: Backend; initial: EditablePreview; onDirty(dirty: boolean): void; onDone(): void; onSaved(): void;
}) {
  const name = path.split("/").pop() ?? path;
  const [loaded, setLoaded] = useState(initial.text), [generation, setGeneration] = useState(0), [draft, setDraft] = useState(initial.text), [savedText, setSavedText] = useState(initial.text), [version, setVersion] = useState(initial.version);
  const [saving, setSaving] = useState(false), [conflict, setConflict] = useState(false), [problem, setProblem] = useState(""), [status, setStatus] = useState(""), [asking, setAsking] = useState<Question | null>(null);
  const dirty = isDirty(draft, savedText);
  const latest = useRef({ draft, version, saving }); latest.current = { draft, version, saving };
  useEffect(() => { onDirty(dirty); }, [dirty]);
  useEffect(() => () => onDirty(false), []);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  const save = useCallback(async (force = false) => {
    const { draft: text, version: expected, saving: busy } = latest.current;
    if (busy) return;
    setSaving(true); setProblem(""); setConflict(false);
    try {
      const next = await backend.fileWrite(root, path, text, force ? null : expected);
      setVersion(next); setSavedText(text); setStatus("Saved"); onSaved();
      window.setTimeout(() => setStatus(""), 1500);
    } catch (error) {
      if (saveErrorKind(error) === "conflict") setConflict(true); else setProblem(saveErrorMessage(error));
    } finally { setSaving(false); }
  }, [backend, root, path, onSaved]);
  const reload = async () => {
    try {
      const fresh = await backend.fileRead(root, path);
      if (fresh.kind !== "text" || fresh.truncated) { setProblem("This file can't be edited any more."); return; }
      setLoaded(fresh.text); setGeneration((value) => value + 1); setDraft(fresh.text); setSavedText(fresh.text); setVersion(fresh.version); setConflict(false); setProblem("");
    } catch (error) { setProblem(String(error)); }
  };
  const copyMine = async () => { const ok = await writeClipboard(draft, navigator.clipboard); setStatus(ok ? "Copied your version" : "Clipboard unavailable"); window.setTimeout(() => setStatus(""), 1500); };
  const done = () => {
    if (!dirty) { onDone(); return; }
    setAsking({ title: `Discard unsaved changes to ${name}?`, body: "Your edits to this file haven't been saved.", action: "Discard", onConfirm: onDone });
  };
  return <div className="file-edit-session">
    <div className="file-edit-toolbar">
      <button type="button" className="file-edit-save" disabled={!dirty || saving} onClick={() => void save()}>{saving ? "Saving…" : "Save"}</button>
      <button type="button" onClick={done}>Done</button>
      {dirty && <span className="file-edit-dirty" title="Unsaved changes" aria-label="Unsaved changes">●</span>}
      <span className="muted" role="status">{status}</span>
    </div>
    {conflict && <div className="file-edit-conflict" role="alert">
      <span>This file changed on disk since you opened it.</span>
      <button type="button" onClick={() => void reload()}>Reload</button>
      <button type="button" onClick={() => void save(true)}>Save anyway</button>
      <button type="button" onClick={() => void copyMine()}>Copy my version</button>
    </div>}
    {problem && <div className="file-edit-problem" role="alert">{problem}<button type="button" onClick={() => setProblem("")}>Dismiss</button></div>}
    <FileEditor key={generation} fileName={name} initialText={loaded} onChange={setDraft} onSave={() => void save()} />
    {asking && createPortal(<ConfirmDialog question={asking} onCancel={() => setAsking(null)} />, document.body)}
  </div>;
}
