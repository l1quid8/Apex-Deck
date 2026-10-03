import { useState } from "react";

import type { FileChange, ProposedAction } from "./types";

/** A diff drawn line by line: added lines green, removed lines red. */
export function Diff({ text }: { text: string }) {
  if (!text.trim()) return <p className="diff-none">The tool did not say what changed in this file.</p>;
  return (
    <pre className="diff">
      {text
        .replace(/\n$/, "")
        .split("\n")
        .map((line, i) => {
          const kind = line.startsWith("+++") || line.startsWith("---") || line.startsWith("@@") ? "meta" : line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : "same";
          return (
            <span key={i} className={`diff-line ${kind}`}>
              {line || " "}
              {"\n"}
            </span>
          );
        })}
    </pre>
  );
}

interface CardProps {
  action: ProposedAction;
  /** Called once with the person's answer. */
  onDecide: (approve: boolean) => void;
}

/**
 * Something a bot wants to do, with the whole of it on show and a yes or
 * no to give. The bot's turn waits until one is chosen.
 */
export function ApprovalCard({ action, onDecide }: CardProps) {
  const [answered, setAnswered] = useState<boolean | null>(null);
  const decide = (approve: boolean) => {
    if (answered !== null) return;
    setAnswered(approve);
    onDecide(approve);
  };
  return (
    <div className="approval" role="group" aria-label={`Approve or reject: ${action.title}`}>
      <div className="approval-head">
        <span className="approval-kind">{action.kind === "edit" ? "Wants to change a file" : action.kind === "command" ? "Wants to run a command" : "Wants permission"}</span>
        <strong>{action.title}</strong>
      </div>
      {action.kind === "edit" ? <Diff text={action.detail} /> : <pre className="approval-detail">{action.detail}</pre>}
      <div className="approval-actions">
        <button className="primary" onClick={() => decide(true)} disabled={answered !== null}>
          {answered === true ? "Approved" : "Approve"}
        </button>
        <button className="danger" onClick={() => decide(false)} disabled={answered !== null}>
          {answered === false ? "Rejected" : "Reject"}
        </button>
        <span className="approval-note">Nothing happens until you choose.</span>
      </div>
    </div>
  );
}

export interface MadeChange {
  /** Order in which changes arrived, for a stable key. */
  seq: number;
  /** The participant that made it. */
  by: string;
  change: FileChange;
}

interface PanelProps {
  changes: MadeChange[];
  nameOf: (id: string) => string;
  colorOf: (id: string) => string;
  /** Show a file in the file browser. */
  onReveal: (path: string) => void;
  onClose: () => void;
}

/**
 * Every file the bots changed in this chat, newest first, each with what
 * changed. It covers changes made since the chat was opened; it is not a
 * record of the folder's history.
 */
export function ChangesPanel({ changes, nameOf, colorOf, onReveal, onClose }: PanelProps) {
  const added = changes.reduce((sum, c) => sum + c.change.added, 0);
  const removed = changes.reduce((sum, c) => sum + c.change.removed, 0);
  const files = new Set(changes.map((c) => c.change.path)).size;
  return (
    <aside className="changes" aria-label="Changes made in this chat">
      <div className="changes-head">
        <div>
          <strong>Changes</strong>
          <span className="changes-total">
            {files === 0 ? "None yet" : `${files} file${files === 1 ? "" : "s"}`}
            {files > 0 && (
              <>
                {" "}
                <span className="plus">+{added}</span> <span className="minus">−{removed}</span>
              </>
            )}
          </span>
        </div>
        <button className="icon small" onClick={onClose} aria-label="Hide changes" title="Hide">
          ×
        </button>
      </div>
      {changes.length === 0 && <p className="changes-empty">When a bot edits a file, the change is listed here with what was added and removed.</p>}
      <div className="changes-list">
        {[...changes].reverse().map(({ seq, by, change }) => (
          <details key={seq} className="change" open={changes.length <= 3}>
            <summary>
              <span className="change-path" title={change.path}>
                {change.path}
              </span>
              <span className="change-count">
                <span className="plus">+{change.added}</span> <span className="minus">−{change.removed}</span>
              </span>
            </summary>
            <div className="change-meta">
              <span style={{ color: colorOf(by) }}>{nameOf(by)}</span>
              <button className="ghost" onClick={() => onReveal(change.path)}>
                Show file
              </button>
            </div>
            <Diff text={change.diff} />
          </details>
        ))}
      </div>
    </aside>
  );
}
