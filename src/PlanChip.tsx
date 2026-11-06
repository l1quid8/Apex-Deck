import { planTitle, planView } from "./planRunModel";
import type { PlanRun } from "./types";

/** The chat's pointer to a plan. The decision itself lives in the Plan tab. */
export function PlanChip({ run, onOpen }: { run: PlanRun; onOpen: () => void }) {
  const view = planView(run, new Set());
  const line = run.state === "waiting" || !view.total ? view.label : view.chipLine;
  return <button type="button" className="plan-run-chip" onClick={onOpen} aria-label={`Open plan: ${planTitle(run.detail)}. ${line}`}>
    <span className="plan-run-chip-icon" aria-hidden="true">≡</span>
    <span className="plan-run-chip-text">
      <b>{planTitle(run.detail)}</b>
      <small>{line}</small>
      {run.state === "running" && view.total > 0 && <span className="plan-run-meter" aria-hidden="true"><i style={{ width: `${Math.round(view.done / view.total * 100)}%` }} /></span>}
    </span>
  </button>;
}
