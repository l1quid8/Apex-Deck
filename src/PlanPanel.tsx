import { useRef, useState } from "react";

import { Markdown } from "./Markdown";
import { frontRun, planTitle, planView } from "./planRunModel";
import type { PlanRun, PlanRunStep } from "./types";
import "./plan-panel.css";

const SIZES = [14, 16, 18];
const WORD: Partial<Record<PlanRunStep["state"], string>> = { active: "In progress", skipped: "Skipped", cancelled: "Cancelled" };
const MARK: Partial<Record<PlanRunStep["state"], string>> = { done: "✓", skipped: "–", cancelled: "–" };

interface PanelProps {
  run: PlanRun;
  others: PlanRun[];
  onDecide: (request: string, approve: boolean, skip: string[]) => void | Promise<void>;
  onStop: (who: string) => void | Promise<void>;
  onClose: () => void;
  onExpand?: () => void;
  expanded?: boolean;
  onPick?: (request: string) => void;
}

/** One plan: review it with tick boxes, then follow its real progress. */
export function PlanPanel({ run, others, onDecide, onStop, onClose, onExpand, expanded = false, onPick }: PanelProps) {
  const [unticked, setUnticked] = useState<Set<string>>(() => new Set());
  const [size, setSize] = useState(0);
  const [source, setSource] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const sending = useRef(false);
  const view = planView(run, unticked);
  const waiting = run.state === "waiting";
  const ticks = waiting && run.steps.length > 0;
  const send = async (action: () => void | Promise<void>) => {
    if (sending.current) return;
    sending.current = true; setBusy(true); setError("");
    try { await action(); } catch (failure) { setError(String(failure)); } finally { sending.current = false; setBusy(false); }
  };
  const toggle = (id: string) => setUnticked((old) => { const next = new Set(old); if (!next.delete(id)) next.add(id); return next; });
  const activeAt = run.steps.findIndex((step) => step.state === "active");
  return <div className="plan-panel" role="region" aria-label="Plan">
    <header className="plan-panel-head">
      <strong>Plan</strong>
      <span className="plan-panel-tag">{view.label}</span>
      <button type="button" className="plan-panel-tool" title="Text size" aria-label="Change text size" onClick={() => setSize((at) => (at + 1) % SIZES.length)}>Tt</button>
      <button type="button" className="plan-panel-tool" title="Show source" aria-label="Show source" aria-pressed={source} onClick={() => setSource((on) => !on)}>{"</>"}</button>
      {onExpand && <button type="button" className="plan-panel-tool" title="Expand" aria-label="Expand panel" aria-pressed={expanded} onClick={onExpand}>⤢</button>}
      <button type="button" className="plan-panel-tool" title="Close" aria-label="Close panel" onClick={onClose}>✕</button>
    </header>
    <div className="plan-panel-scroll" style={{ fontSize: SIZES[size] }}>
      {others.length > 0 && <ul className="plan-panel-others" aria-label="Other plans in this thread">
        {others.map((other) => <li key={other.request}><button type="button" onClick={() => onPick?.(other.request)}>{planTitle(other.detail)} · {planView(other, new Set()).label}</button></li>)}
      </ul>}
      {source ? <pre className="plan-panel-source">{run.detail}</pre> : run.steps.length === 0 ? <div className="plan-panel-doc"><Markdown text={run.detail} onOpen={() => {}} /></div> : <>
        <h2 className="plan-panel-title">{planTitle(run.detail)}</h2>
        {run.state === "running" && view.total > 0 && <span className="plan-run-meter" aria-hidden="true"><i style={{ width: `${Math.round(view.done / view.total * 100)}%` }} /></span>}
        <p role="status" className="plan-panel-status">{waiting ? `${run.steps.length - unticked.size} of ${run.steps.length} steps picked. Untick any you don't want.` : view.chipLine}</p>
        <ol className="plan-panel-steps">
          {run.steps.map((step, at) => <li key={step.id} data-state={step.state}>
            <span className="plan-panel-mark" aria-hidden="true">{MARK[step.state] ?? at + 1}</span>
            <div>
              {ticks
                ? <label><input type="checkbox" checked={!unticked.has(step.id)} aria-label={`Include step ${at + 1}`} onChange={() => toggle(step.id)} /> <b>{step.text}</b></label>
                : <b>{step.text}</b>}
              {WORD[step.state] && <small>{WORD[step.state]}</small>}
              {step.off_plan && <small>Added during the work</small>}
            </div>
          </li>)}
        </ol>
        <details className="plan-panel-full"><summary>Full plan</summary><div className="plan-panel-doc"><Markdown text={run.detail} onOpen={() => {}} /></div></details>
      </>}
    </div>
    <footer className="plan-panel-foot">
      {error && <p role="alert" className="plan-panel-note">{error}</p>}
      {view.note && <p className="plan-panel-note">{view.note}</p>}
      {waiting && <>
        <button type="button" className="plan-panel-go" disabled={!view.canStart || busy} onClick={() => send(() => onDecide(run.request, true, [...unticked]))}>{view.startLabel}</button>
        <button type="button" className="plan-panel-plain" disabled={busy} onClick={() => send(() => onDecide(run.request, false, []))}>Keep planning</button>
      </>}
      {run.state === "running" && <>
        <span className="plan-panel-line">{activeAt >= 0 ? `Working on step ${activeAt + 1}.` : "Working."}</span>
        <button type="button" className="plan-panel-plain" disabled={busy} onClick={() => send(() => onStop(run.by))}>Stop</button>
      </>}
      {run.state === "revising" && <span className="plan-panel-line">Plan is being revised. A new version will open here.</span>}
      {run.state === "done" && <span className="plan-panel-line">Finished. This plan stays here for reference.</span>}
    </footer>
  </div>;
}

interface TabProps extends Omit<PanelProps, "run" | "others" | "onPick"> { runs: PlanRun[] }

/** The Plan tab for the focused thread. Leads with the run that needs you; other runs stay one click away. */
export function PlanTab({ runs, ...rest }: TabProps) {
  const [picked, setPicked] = useState<string | null>(null);
  const run = runs.find((item) => item.request === picked) ?? frontRun(runs);
  if (!run) return <p className="muted right-panel-empty">No plan in this thread yet.</p>;
  return <PlanPanel key={`${run.request}:${run.version}`} run={run} others={runs.filter((item) => item !== run)} onPick={setPicked} {...rest} />;
}
