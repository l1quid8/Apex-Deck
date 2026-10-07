import { useId, useRef, useState } from "react";

import { answerLabel, choicesFor, sendApprovalAnswer, kindLabel, scopeLine, type Answer } from "./approvalChoices";
import { Markdown } from "./Markdown";
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
  hostName?: string;
  disabled?: boolean;
  action: ProposedAction;
  /** "Denied automatically in 6m" for a call Codex's hook will deny; null for everything else. */
  deadline?: string | null;
  /** The bot's name, for the line that says what Always allow covers. */
  name: string;
  /** Called once with the person's answer. `always` stops the same thing being asked again. */
  onDecide: (approve: boolean, always: boolean) => void | Promise<void>;
  /** The request id and the bot that asked, put on the card so the thread can find it on screen. */
  request?: string;
  by?: string;
}

/**
 * Something a bot wants to do, with the whole of it on show and a yes or
 * no to give. The bot's turn waits until one is chosen. A risky card always
 * says what Always allow would cover; others say it while Always allow is
 * hovered or focused.
 */
export function ApprovalCard({ action, deadline = null, name, onDecide, request, by, hostName = "This Mac", disabled = false }: CardProps) {
  const [answered, setAnswered] = useState<Answer | null>(null);
  const pending = useRef(false);
  const [error, setError] = useState("");
  /** Always allow is hovered or focused, so its scope line shows. */
  const [previewing, setPreviewing] = useState(false);
  const scopeId = useId();
  const preview = (on: boolean) => () => setPreviewing(on);
  const decide = (answer: Answer) => {
    if (pending.current || answered !== null || disabled || (action.expires_at != null && action.expires_at <= Date.now())) return;
    pending.current = true;
    setError("");
    void sendApprovalAnswer(answer, onDecide, setAnswered).catch(error => setError(`Could not send your answer: ${String(error)}`)).finally(() => { pending.current = false; });
  };
  return (
    <div className="approval" role="group" aria-label={`Allow or deny: ${action.title}`} data-request={request} data-by={by} data-answered={answered !== null ? "" : undefined}>
      <div className="approval-head">
        <span className="approval-host" title={hostName}>Runs on {hostName}</span>
        <span className="approval-kind">{kindLabel(action)}</span>
        <strong>{action.title}</strong>
      </div>
      {action.kind === "edit" ? <Diff text={action.detail} />
        : action.kind === "plan" ? <div className="approval-plan"><Markdown text={action.detail} onOpen={() => {}} /></div>
        : <pre className="approval-detail">{action.detail}</pre>}
      <div className="approval-actions">
        {choicesFor(action).map((answer) => {
          const always = answer === "always";
          return (
            <button
              key={answer}
              data-answer={answer}
              className={answer === "once" ? "primary" : answer === "deny" ? "danger" : "ghost"}
              onClick={() => decide(answer)}
              disabled={answered !== null || disabled || (action.expires_at != null && action.expires_at <= Date.now())}
              aria-describedby={always ? scopeId : undefined}
              onMouseEnter={always ? preview(true) : undefined}
              onMouseLeave={always ? preview(false) : undefined}
              onFocus={always ? preview(true) : undefined}
              onBlur={always ? preview(false) : undefined}
            >
              {answered === answer ? answerLabel(action, answer).done : answerLabel(action, answer).ask}
            </button>
          );
        })}
        {!action.risky && <span className="approval-note">Nothing happens until you choose.</span>}
        {deadline && <span className="approval-deadline">{deadline}</span>}
      </div>
      {/* The line keeps its space while faded out, so hovering Always allow never resizes the card. */}
      {(action.risky || choicesFor(action).includes("always")) && (
        <p id={scopeId} className={`approval-scope${action.risky || previewing ? "" : " faded"}`}>{scopeLine(name, action)}</p>
      )}
      {error && <p role="alert">{error}</p>}
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
