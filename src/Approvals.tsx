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
        <span className="approval-kind">{action.kind === "edit" ? "Wants to change a file" : action.kind === "command" ? "Wants to run a command" : action.kind === "tool" ? "Wants to call an MCP tool" : "Wants permission"}</span>
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
