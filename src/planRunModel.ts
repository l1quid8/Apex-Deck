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
  if (waiting && run.steps.length > 0 && ticked === 0) note = "Tick at least one step";
  else if (run.state === "stopped") note = total === 0 ? "Stopped" : `Stopped at ${done} of ${total}`;
  else if (run.state === "expired") note = "This plan was never answered";
  else if (run.state === "running" && !run.reporting) note = "This bot isn't reporting steps";
  return {
    label: LABELS[run.state],
    startLabel: off === 0 ? "Start the work" : `Start ${ticked} of ${run.steps.length} steps`,
    canStart: waiting && (run.steps.length === 0 || ticked > 0),
    done,
    total,
    chipLine: total === 0 ? LABELS[run.state] : `${done} of ${total} steps done`,
    note,
  };
}

/** The most recent run, or null when there are none. */
export function newestRun(runs: PlanRun[]): PlanRun | null {
  return runs.length ? runs[runs.length - 1] : null;
}

/** The run the chip and the tab lead with: the newest still waiting, else the newest. */
export function frontRun(runs: PlanRun[]): PlanRun | null {
  return [...runs].reverse().find((run) => run.state === "waiting") ?? newestRun(runs);
}

/** Add a run, or replace the one with the same request where it stands. */
export function upsertRun(runs: PlanRun[], run: PlanRun): PlanRun[] {
  return runs.some((old) => old.request === run.request)
    ? runs.map((old) => (old.request === run.request ? run : old))
    : [...runs, run];
}

/** The plan's first heading, or "Plan" when it has none. */
export function planTitle(detail: string): string {
  return /^#{1,6}\s+(.+?)\s*#*\s*$/m.exec(detail)?.[1] ?? "Plan";
}

/** A plan approval moves to the chip only when the host tracks runs and this request has one. */
export function planShowsChip(action: { kind: string }, request: string, runs: PlanRun[], supported: boolean): boolean {
  return supported && action.kind === "plan" && runs.some((run) => run.request === request && run.state === "waiting");
}

/** The Plan tab sits below the chat when it would otherwise crowd or float over it. */
export function planStacks(workWidth: number, sidebar: number): boolean {
  return workWidth < 700 || workWidth - sidebar < 560;
}
