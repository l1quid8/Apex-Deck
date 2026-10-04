import { useEffect, useState } from "react";
/** Inline naming works with the keyboard and saves through the existing session.
 *  `renameRequest` starts editing each time it changes, for a Rename menu item. */
export function ThreadName({title, onRename, className, renameRequest}: {title: string; onRename: (name: string) => void; className?: string; renameRequest?: number}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  useEffect(() => { if (renameRequest) { setDraft(title); setEditing(true); } }, [renameRequest]);
  const finish = () => { const name = draft.trim(); if(name) onRename(name); setEditing(false); };
  return editing ? <input className="thread-name-input" aria-label="Thread name" autoFocus value={draft}
    onPointerDown={e => e.stopPropagation()} onClick={e => e.stopPropagation()}
    onChange={e => setDraft(e.target.value)} onBlur={finish}
    onKeyDown={e => { e.stopPropagation(); if(e.key === "Enter") finish(); if(e.key === "Escape") {setDraft(title); setEditing(false);} }} /> :
    <span className={className} role="button" tabIndex={0} aria-label={`Rename ${title}`} title="Double-click to rename"
      onPointerDown={e => e.stopPropagation()}
      onDoubleClick={e => {e.stopPropagation(); setDraft(title); setEditing(true);}}
      onKeyDown={e => { if(e.key === "Enter" || e.key === "F2") {e.preventDefault(); e.stopPropagation(); setDraft(title); setEditing(true);} }}>{title}</span>;
}
