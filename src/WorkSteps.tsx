import { useState } from "react";
import type { ReactNode } from "react";
import type { ReplySteps, StepStatus, TodoItem, TurnTimelineEntry, WorkStep } from "./types.ts";
import { stepTree, stepsCountLabel } from "./workSteps.ts";
import type { StepNode, TurnSteps } from "./workSteps.ts";

/** How many top-level rows a folded list shows in the window. */
export const MAX_STEPS_SHOWN = 4;

/** The note Rust's cut_output puts where it removed the middle of an output. */
const CUT_NOTE = / lines cut …/;

const STATUS_WORDS: Record<StepStatus, string> = { running: "Working", done: "Done", failed: "Failed", stopped: "Stopped" };
const TODO_MARKS: Record<TodoItem["status"], string> = { completed: "✔", in_progress: "▸", pending: "□", cancelled: "⊘" };

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
  /** Render a timeline text segment (for example, as Markdown). */
  renderText?: (text: string) => ReactNode;
}

/** A bot's steps for one reply: a to-do list, then the latest rows, each opening to its command and output. */
export function WorkSteps({ turn, live, initiallyOpen, maxShown = MAX_STEPS_SHOWN, renderText }: Props) {
  const [expanded, setExpanded] = useState<boolean>(initiallyOpen ?? !live);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const toggle = (key: string) => setOpen((o) => ({ ...o, [key]: !o[key] }));
  const nodes = stepTree(turn.steps);
  const hidden = expanded ? 0 : Math.max(0, nodes.length - maxShown);
  const shown = nodes.slice(hidden);
  const referenced = new Set(turn.timeline?.flatMap((entry) => entry.kind === "activity" ? entry.keys : []) ?? []);
  const unreferenced = nodes.filter((node) => !referenced.has(node.step.key));

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

  const activitySummary = (keys: string[]) => {
    const steps = keys.map((key) => turn.steps.find((step) => step.key === key)).filter((step): step is WorkStep => !!step && (step.parent === null || !turn.steps.some((parent) => parent.key === step.parent)));
    const groups: { kind: string; count: number; failed: number }[] = [];
    for (const step of steps) {
      const group = groups.find((item) => item.kind === step.kind);
      if (group) { group.count++; if (step.status === "failed") group.failed++; }
      else groups.push({ kind: step.kind, count: 1, failed: step.status === "failed" ? 1 : 0 });
    }
    const names: Record<string, [string, string, string]> = {
      read: ["Read", "file", "files"], command: ["ran", "command", "commands"], search: ["Searched", "query", "queries"],
      list: ["Listed", "item", "items"], edit: ["Edited", "file", "files"], web: ["Browsed", "page", "pages"],
      tool: ["Used", "tool", "tools"], thinking: ["Thought through", "step", "steps"], other: ["Performed", "action", "actions"], helper: ["Delegated", "task", "tasks"],
    };
    if (!groups.length) return "Activity";
    const summary = groups.map((group) => {
      const [verb, one, many] = names[group.kind] ?? [group.kind, "item", "items"];
      return `${verb} ${group.count} ${group.count === 1 ? one : many}${group.failed ? ` · ${group.failed} failed` : ""}`;
    }).join(", ");
    const running = steps.filter((step) => step.status === "running").length;
    const stopped = steps.filter((step) => step.status === "stopped").length;
    return `${summary}${running ? ` · ${running} working` : ""}${stopped ? ` · ${stopped} stopped` : ""}`;
  };

  const renderTimelineEntry = (entry: TurnTimelineEntry, index: number) => {
    if (entry.kind === "text") return <div className="work-steps-timeline-text" key={`text-${index}`}>{renderText ? renderText(entry.text) : entry.text}</div>;
    const nodesForActivity = entry.keys.map((key) => nodes.find((node) => node.step.key === key)).filter((node): node is StepNode => !!node);
    if (!nodesForActivity.length) return null;
    return <details className="work-steps-activity" key={`activity-${index}`}><summary>{activitySummary(entry.keys)}</summary><ul className="work-steps-list">{nodesForActivity.map(renderNode)}</ul></details>;
  };

  return (
    <div className="work-steps">
      {turn.outcome && <div className={`work-steps-outcome work-steps-outcome-${turn.outcome}`}>{turn.outcome === "passed" ? "No reply" : turn.outcome === "failed" ? "Failed" : "Stopped"}</div>}
      {turn.timeline_cut && <div className="work-steps-note">Earlier progress was omitted to keep this record small.</div>}
      {turn.timeline ? (
        <div className="work-steps-timeline" aria-label="Reply progress">
          {turn.timeline.map(renderTimelineEntry)}
          {unreferenced.length > 0 && <details className="work-steps-activity"><summary>Additional activity · {stepsCountLabel(unreferenced.length)}</summary><ul className="work-steps-list">{unreferenced.map(renderNode)}</ul></details>}
        </div>
      ) : null}
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
      {!turn.timeline && hidden > 0 && (
        <button type="button" className="work-steps-more" onClick={() => setExpanded(true)}>
          {hidden === 1 ? "1 earlier step" : `${hidden} earlier steps`}
        </button>
      )}
      {!turn.timeline && expanded && nodes.length > maxShown && (
        <button type="button" className="work-steps-more" onClick={() => setExpanded(false)}>Show fewer</button>
      )}
      {!turn.timeline && shown.length > 0 && <ul className="work-steps-list" aria-label="Steps so far">{shown.map(renderNode)}</ul>}
    </div>
  );
}

interface SavedProps {
  /** Step count from the index, helpers' steps included. */
  count: number;
  /** Steps this pane already loaded for the reply. */
  cached?: ReplySteps | null;
  /** Fetch the reply's saved steps; null or a rejection means they can't be shown. */
  load: () => Promise<ReplySteps | null>;
  renderText?: (text: string) => ReactNode;
  /** Final message text, shown immediately and deduplicated from a loaded ordered timeline. */
  finalText?: string;
  todoCount?: number;
  todoCompleted?: number;
}

type Saved = { open: boolean; status: "idle" | "loading" | "ready" | "failed"; reply: ReplySteps | null };

/** The quiet "83 steps" line under a finished reply; opens that reply's saved steps. */
export function SavedSteps({ count, cached, load, renderText, finalText, todoCount, todoCompleted }: SavedProps) {
  const [saved, setSaved] = useState<Saved>(() => ({ open: false, status: cached ? "ready" : "idle", reply: cached ?? null }));
  const click = () => {
    if (saved.open) { setSaved((s) => ({ ...s, open: false })); return; }
    if (saved.status === "ready") { setSaved((s) => ({ ...s, open: true })); return; }
    if (saved.status === "loading") return;
    setSaved((s) => ({ ...s, open: true, status: "loading" }));
    load().then(
      (reply) => setSaved((s) => ({ ...s, status: reply ? "ready" : "failed", reply })),
      () => setSaved((s) => ({ ...s, status: "failed", reply: null })),
    );
  };
  const reply = saved.open && saved.status === "ready" ? saved.reply : null;
  const textEntries = reply?.timeline?.filter((entry): entry is Extract<TurnTimelineEntry, { kind: "text" }> => entry.kind === "text") ?? [];
  const timelineText = textEntries.map((entry) => entry.text).join("");
  let timelineForDisplay = reply?.timeline;
  let displayFinal = finalText;
  if (timelineForDisplay && finalText !== undefined) {
    if (textEntries.length && textEntries[textEntries.length - 1].text === finalText) {
      let skipped = false;
      timelineForDisplay = timelineForDisplay.filter((entry) => {
        if (!skipped && entry.kind === "text" && entry.text === finalText) { skipped = true; return false; }
        return true;
      });
    } else if (timelineText === finalText && textEntries.length) {
      let lastTextIndex = -1;
      timelineForDisplay.forEach((entry, index) => { if (entry.kind === "text") lastTextIndex = index; });
      displayFinal = textEntries[textEntries.length - 1].text;
      timelineForDisplay = timelineForDisplay.filter((_, index) => index !== lastTextIndex);
    } else {
      // A damaged/mismatched snapshot cannot be safely reconciled with the final answer.
      timelineForDisplay = timelineForDisplay.filter((entry) => entry.kind !== "text");
    }
  }
  const label = todoCount !== undefined && todoCount > 0
    ? `${todoCompleted ?? 0} of ${todoCount} steps completed`
    : stepsCountLabel(count);
  return (
    <div className="work-steps-saved">
      {finalText !== undefined && <div className="work-steps-saved-final">{renderText ? renderText(displayFinal ?? finalText) : displayFinal}</div>}
      <button type="button" className="work-steps-toggle" aria-expanded={saved.open} onClick={click}>{label}</button>
      {saved.open && saved.status === "loading" && <p className="work-steps-note">Loading steps…</p>}
      {saved.open && saved.status === "failed" && <p className="work-steps-note">Steps aren't available for this reply.</p>}
      {reply && (reply.todo.length > 0 || reply.steps.length > 0 || reply.timeline?.length) && <WorkSteps turn={{ steps: reply.steps, todo: reply.todo, structured: true, ...(timelineForDisplay ? { timeline: timelineForDisplay } : {}), ...(reply.timeline_cut ? { timeline_cut: true } : {}), ...(reply.outcome ? { outcome: reply.outcome } : {}) }} live={false} initiallyOpen maxShown={Infinity} renderText={renderText} />}
      {reply && reply.dropped > 0 && <p className="work-steps-note">{reply.dropped} more steps weren't kept</p>}
    </div>
  );
}

/** A turn that ended without a final reply keeps its actual progress available. */
export function InterruptedSteps({ turn, name, renderText }: { turn: TurnSteps; name: string; renderText?: (text: string) => ReactNode }) {
  if (!turn.outcome || (!turn.todo.length && !turn.steps.length && !turn.timeline?.length)) return null;
  const completed = turn.todo.filter(item => item.status === 'completed').length;
  const status = turn.outcome === 'failed' ? 'Failed' : turn.outcome === 'passed' ? 'No reply' : 'Stopped';
  return <details className="work-steps-interrupted"><summary>{name} · {status}{turn.todo.length ? ` · ${completed} of ${turn.todo.length} steps completed` : ''}</summary><WorkSteps turn={turn} live={false} renderText={renderText} /></details>;
}
