import { useState } from "react";
import type { StepStatus, TodoItem, WorkStep } from "./types.ts";
import { stepTree, stepsCountLabel } from "./workSteps.ts";
import type { StepNode, TurnSteps } from "./workSteps.ts";

/** How many top-level rows a folded list shows in the window. */
export const MAX_STEPS_SHOWN = 4;

/** The note Rust's cut_output puts where it removed the middle of an output. */
const CUT_NOTE = / lines cut …/;

const STATUS_WORDS: Record<StepStatus, string> = { running: "Working", done: "Done", failed: "Failed", stopped: "Stopped" };
const TODO_MARKS: Record<TodoItem["status"], string> = { completed: "✔", in_progress: "▸", pending: "□" };

/** "0.4s", "12s", "1m 05s". */
export function formatDuration(ms: number): string {
  if (ms < 9_950) return `${(ms / 1000).toFixed(1).replace(/\.0$/, "")}s`;
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${secs}s`;
  return `${Math.floor(secs / 60)}m ${String(secs % 60).padStart(2, "0")}s`;
}

interface Props {
  turn: TurnSteps;
  live: boolean;
  /** Start with every row shown. Defaults to folded while live. */
  initiallyOpen?: boolean;
  /** Top-level rows a folded list shows; the phone passes more. */
  maxShown?: number;
}

/** A bot's steps for one reply: a to-do list, then the latest rows, each opening to its command and output. */
export function WorkSteps({ turn, live, initiallyOpen, maxShown = MAX_STEPS_SHOWN }: Props) {
  const [expanded, setExpanded] = useState<boolean>(initiallyOpen ?? !live);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const toggle = (key: string) => setOpen((o) => ({ ...o, [key]: !o[key] }));
  const nodes = stepTree(turn.steps);
  const hidden = expanded ? 0 : Math.max(0, nodes.length - maxShown);
  const shown = nodes.slice(hidden);

  const renderStep = (step: WorkStep) => {
    const isOpen = open[step.key] === true;
    const cut = step.output_cut === true || (step.output !== null && CUT_NOTE.test(step.output));
    const meta = [
      step.exit_code !== null ? `Exit code ${step.exit_code}` : null,
      step.duration_ms !== null ? formatDuration(step.duration_ms) : null,
    ].filter(Boolean).join(" · ");
    return (
      <li key={step.key} className="work-steps-item">
        <button type="button" className={`work-steps-step work-steps-${step.status}`} data-kind={step.kind} aria-expanded={isOpen} onClick={() => toggle(step.key)}>
          <span className="work-steps-label">{step.label}</span>
          {step.folder && <span className="work-steps-folder">in {step.folder}</span>}
          {step.status === "running" && <span className="work-steps-spinner" role="img" aria-label="Working" />}
          {step.status === "failed" && <span className="work-steps-fail-mark">✕{step.exit_code !== null ? ` ${step.exit_code}` : ""}</span>}
          {step.status === "stopped" && <span className="work-steps-stop-mark">Stopped</span>}
        </button>
        {isOpen && (
          <div className="work-steps-detail">
            {step.detail && <pre className="work-steps-command">{step.detail}</pre>}
            {step.output && <pre className="work-steps-output" tabIndex={0}>{step.output}</pre>}
            {meta && <div className="work-steps-meta">{meta}</div>}
            {cut && <div className="work-steps-meta">Output was cut to fit</div>}
          </div>
        )}
      </li>
    );
  };

  const renderNode = (node: StepNode) => {
    if (node.step.kind !== "helper") return renderStep(node.step);
    const { step, children } = node;
    const isOpen = open[step.key] === true;
    const latest = step.status === "running" ? children[children.length - 1]?.step.label : undefined;
    return (
      <li key={step.key} className={`work-steps-helper work-steps-${step.status}`}>
        <button type="button" className="work-steps-helper-head" aria-expanded={isOpen} onClick={() => toggle(step.key)}>
          <span className="work-steps-helper-title">{step.label}</span>
          <span className="work-steps-helper-state">
            {step.status === "running" && <span className="work-steps-spinner" aria-hidden="true" />}
            {STATUS_WORDS[step.status]} · {stepsCountLabel(children.length)}
          </span>
          {latest && <span className="work-steps-helper-latest">{latest}</span>}
        </button>
        {isOpen && children.length > 0 && <ul className="work-steps-list">{children.map(renderNode)}</ul>}
      </li>
    );
  };

  return (
    <div className="work-steps">
      {turn.todo.length > 0 && (
        <ul className="work-steps-todo" aria-label="To-do">
          {turn.todo.map((item, i) => (
            <li key={i} className={`work-steps-todo-item work-steps-todo-${item.status}`} aria-current={item.status === "in_progress" ? "step" : undefined}>
              <span className="work-steps-todo-mark" aria-hidden="true">{TODO_MARKS[item.status]}</span>
              {item.text}
            </li>
          ))}
        </ul>
      )}
      {hidden > 0 && (
        <button type="button" className="work-steps-more" onClick={() => setExpanded(true)}>
          {hidden === 1 ? "1 earlier step" : `${hidden} earlier steps`}
        </button>
      )}
      {expanded && nodes.length > maxShown && (
        <button type="button" className="work-steps-more" onClick={() => setExpanded(false)}>Show fewer</button>
      )}
      {shown.length > 0 && <ul className="work-steps-list" aria-label="Steps so far">{shown.map(renderNode)}</ul>}
    </div>
  );
}
