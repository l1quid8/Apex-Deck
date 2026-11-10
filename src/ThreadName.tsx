import { useEffect, useRef, useState } from "react";
/** Inline naming works with the keyboard and saves through the existing session.
 *  `renameRequest` starts editing each time it changes, for a Rename menu item.
 *  `label` names the text box for screen readers; `tooltip` replaces the hover hint. */
export function ThreadName({title, onRename, className, renameRequest, label = "Thread name", tooltip = "Double-click to rename", editOnDoubleClick = true}: {title: string; onRename: (name: string) => void; className?: string; renameRequest?: number; label?: string; tooltip?: string; editOnDoubleClick?: boolean}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const input = useRef<HTMLInputElement>(null);
  const active = useRef(false);
  const begin = () => { active.current = true; setDraft(title); setEditing(true); };
  useEffect(() => { if (renameRequest) begin(); }, [renameRequest]);
  useEffect(() => { if (editing) input.current?.select(); }, [editing]);
  const finish = () => { if (!active.current) return; active.current = false; const name = draft.trim(); if(name) onRename(name); setEditing(false); };
  return editing ? <input ref={input} className="thread-name-input" aria-label={label} autoFocus value={draft}
    onPointerDown={e => e.stopPropagation()} onClick={e => e.stopPropagation()}
    onChange={e => setDraft(e.target.value)} onBlur={finish}
    onKeyDown={e => { e.stopPropagation(); if(e.key === "Enter") {e.preventDefault(); finish();} if(e.key === "Escape") {e.preventDefault(); active.current = false; setDraft(title); setEditing(false);} }} /> :
    <span className={className} role="button" tabIndex={0} aria-label={`Rename ${title}`} title={tooltip}
      onPointerDown={e => { if (editOnDoubleClick) e.stopPropagation(); }}
      onDoubleClick={e => { if (editOnDoubleClick) {e.stopPropagation(); begin();} }}
      onKeyDown={e => { if(e.key === "Enter" || e.key === "F2") {e.preventDefault(); e.stopPropagation(); begin();} }}><span className="thread-name-text">{title}</span></span>;
}
