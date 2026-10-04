import { useEffect, useRef, useState } from "react";
import { Diff } from "./ApprovalCard";
import { Avatar } from "./Avatar";
import { groupDiff } from "./diffGroups";
import { filesLine, offersSplit, patchLines, reviewPatch, reviewScope, sizeLine, type Reviewer } from "./review";
import type { ThreadDiff } from "./types";

interface Props {
  diff: ThreadDiff | null;
  loading: boolean;
  order: string[];
  nameOf: (id: string) => string;
  colorOf: (id: string) => string;
  /** Each bot's saved look, for its avatar in Ask for review. */
  appearanceOf: (id: string) => { seed: string; color: string };
  onReveal: (path: string) => void;
  onRefresh: () => void;
  onClose?: () => void;
  /** The thread's bots for Ask for review, read-only ones first (`reviewerRows`). */
  reviewers: Reviewer[];
  /** Attach the change for bot `id` to review: one file, or one file per patch. It never sends. */
  onReview: (id: string, split: boolean) => void;
}

/** Everything that changed in the folder since this thread started, under
 *  the agent that changed it, and a way to hand it to a reviewer. */
export function DiffPanel({ diff, loading, order, nameOf, colorOf, appearanceOf, onReveal, onRefresh, onClose, reviewers, onReview }: Props) {
  const [open, setOpen] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [split, setSplit] = useState(false);
  const askButton = useRef<HTMLButtonElement>(null);
  const askMenu = useRef<HTMLDivElement>(null);
  const files = diff?.files ?? [];
  const patch = reviewPatch(files);
  const lines = patch ? patchLines(patch) : 0;
  const large = offersSplit(lines);
  useEffect(() => {
    if (!asking) return;
    askMenu.current?.querySelector<HTMLElement>("input, button:not(:disabled)")?.focus();
    const away = (event: MouseEvent) => { if (!(event.target as Element).closest?.(".review-menu, .review-ask")) setAsking(false); };
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // Close only this menu, not the overlaid sidebar behind it.
      event.stopPropagation();
      setAsking(false);
      askButton.current?.focus();
    };
    window.addEventListener("mousedown", away);
    window.addEventListener("keydown", key, true);
    return () => { window.removeEventListener("mousedown", away); window.removeEventListener("keydown", key, true); };
  }, [asking]);
  const pick = (id: string) => {
    setAsking(false);
    onReview(id, large && split);
  };
  return (
    <aside className="changes" aria-label="Changes since this thread started">
      <header className="changes-head">
        <strong>Since this thread started</strong>
        <span className="muted">{loading ? "Reading…" : filesLine(files)}</span>
        <button className="ghost small" onClick={onRefresh} disabled={loading}>Refresh</button>
        <button
          ref={askButton}
          className="ghost small review-ask"
          aria-haspopup="dialog"
          aria-expanded={asking}
          disabled={loading || files.length === 0 || reviewers.length === 0}
          title={reviewers.length === 0 ? "Add a bot to ask for a review" : undefined}
          onClick={() => setAsking((now) => !now)}
        >
          Ask for review <span aria-hidden="true">▾</span>
        </button>
        {onClose && <button className="icon small" aria-label="Close changes" onClick={onClose}>×</button>}
      </header>
      {asking && (
        <div ref={askMenu} className="review-menu" role="dialog" aria-label="Ask for review">
          <p className="review-line">{reviewScope(files)}</p>
          {!patch && <p className="review-line">There's no patch to send: this thread only knows the edits the models reported.</p>}
          {large && <p className="review-line">{sizeLine(lines)}</p>}
          {large && <label className="review-split"><input type="checkbox" checked={split} onChange={(e) => setSplit(e.target.checked)} /> One file per patch</label>}
          <span className="pane-menu-sep" role="separator" />
          {reviewers.map((r) => {
            const look = appearanceOf(r.id);
            return (
              <button key={r.id} className="review-bot" disabled={!patch} onClick={() => pick(r.id)}>
                <Avatar seed={look.seed} color={look.color} size="sm" />
                <span className="review-bot-name"><strong>{r.name}</strong> · {r.label}</span>
                {r.note && <span className="review-bot-note">{r.note}</span>}
              </button>
            );
          })}
        </div>
      )}
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
