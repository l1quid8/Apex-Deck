import type { PlanRun, PlanRunState } from "./types";

export interface PlanView {
  label: string;
  startLabel: string;
  canStart: boolean;
  done: number;
  total: number;
  chipLine: string;
  note: string | null;
}

const LABELS: Record<PlanRunState, string> = {
  waiting: "Needs your decision",
  running: "In progress",
  revising: "Revising",
  done: "Done",
  stopped: "Stopped",
  expired: "No longer waiting",
};

/** What the checklist shows for a run. `unticked` holds ids the person has switched off before starting. */
export function planView(run: PlanRun, unticked: Set<string>): PlanView {
  const counted = run.steps.filter((s) => s.state !== "skipped");
  const total = counted.length;
  const done = counted.filter((s) => s.state === "done").length;
  const off = run.steps.filter((s) => unticked.has(s.id)).length;
  const ticked = run.steps.length - off;
  const waiting = run.state === "waiting";
  let note: string | null = null;
  if (waiting && ticked === 0) note = "Tick at least one step";
  else if (run.state === "stopped") note = `Stopped at ${done} of ${total}`;
  else if (run.state === "expired") note = "This plan was never answered";
  else if (run.state === "running" && !run.reporting) note = "This bot isn't reporting steps";
  return {
    label: LABELS[run.state],
    startLabel: off === 0 ? "Start the work" : `Start ${ticked} of ${run.steps.length} steps`,
    canStart: waiting && ticked > 0,
    done,
    total,
    chipLine: `${done} of ${total} steps done`,
    note,
  };
}

/** The most recent run, or null when there are none. */
export function newestRun(runs: PlanRun[]): PlanRun | null {
  return runs.length ? runs[runs.length - 1] : null;
}
