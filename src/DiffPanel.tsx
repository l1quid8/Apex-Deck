import { useState } from "react";
import { Diff } from "./Approvals";
import { groupDiff } from "./diffGroups";
import type { ThreadDiff } from "./types";

interface Props {
  diff: ThreadDiff | null;
  loading: boolean;
  order: string[];
  nameOf: (id: string) => string;
  colorOf: (id: string) => string;
  onReveal: (path: string) => void;
  onRefresh: () => void;
  onClose: () => void;
}

/** Everything that changed in the folder since this thread started, under
 *  the agent that changed it. */
export function DiffPanel({ diff, loading, order, nameOf, colorOf, onReveal, onRefresh, onClose }: Props) {
  const [open, setOpen] = useState<string | null>(null);
  const files = diff?.files ?? [];
  const added = files.reduce((n, f) => n + f.added, 0);
  const removed = files.reduce((n, f) => n + f.removed, 0);
  return (
    <aside className="changes" aria-label="Changes since this thread started">
      <header className="changes-head">
        <strong>Since this thread started</strong>
        <span className="muted">{loading ? "Reading…" : `${files.length} files · +${added} −${removed}`}</span>
        <button className="ghost small" onClick={onRefresh} disabled={loading}>Refresh</button>
        <button className="icon small" aria-label="Close changes" onClick={onClose}>×</button>
      </header>
      {diff?.note && <p className="changes-note">{diff.note}</p>}
      {!loading && files.length === 0 && <p className="muted changes-empty">Nothing has changed yet.</p>}
      {groupDiff(files, order).map((group) => (
        <section key={group.by ?? "none"} className="diff-group">
          <h4 style={group.by ? { color: colorOf(group.by) } : undefined}>{group.by ? nameOf(group.by) : "Not reported by a model"}</h4>
          {group.files.map((file) => {
            const key = `${group.by}:${file.path}`;
            return (
              <div key={key} className="diff-file">
                <button className="diff-file-row" aria-expanded={open === key} onClick={() => setOpen(open === key ? null : key)}>
                  <span className="path">{file.path}</span>
                  <span className="plus">+{file.added}</span> <span className="minus">−{file.removed}</span>
                </button>
                <button className="ghost small" onClick={() => onReveal(file.path)}>Show in folder</button>
                {open === key && (file.patch ? <Diff text={file.patch} /> : <p className="diff-none">Only the reported edit is available for this file.</p>)}
              </div>
            );
          })}
        </section>
      ))}
    </aside>
  );
}
