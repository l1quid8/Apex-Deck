import type { PaneStatus } from "./types";

export type DashGroup = "waiting" | "working" | "done" | "idle";
const ORDER: DashGroup[] = ["waiting", "working", "done", "idle"];
export const GROUP_LABEL: Record<DashGroup, string> = { waiting: "Waiting for you", working: "Working", done: "Done", idle: "Idle" };
export interface DashRow { id: string; title: string; project: string; kind: "chat" | "terminal"; status: PaneStatus; note: string; ready?: boolean; readyCount?: number; needsCount?: number; needsDetails?: string }
export function groupOf(status: PaneStatus): DashGroup {
  if (status === "needs_input" || status === "failed") return "waiting";
  if (status === "working") return "working";
  if (status === "done") return "done";
  return "idle";
}
export function dashboard(rows: DashRow[], opts: { query: string; filter: DashGroup | "all"; by: "status" | "project" }) {
  const query = opts.query.trim().toLowerCase();
  const kept = rows.filter((row) => (opts.filter === "all" || groupOf(row.status) === opts.filter)
    && (!query || `${row.title} ${row.project} ${row.note}`.toLowerCase().includes(query)));
  const rank = (row: DashRow) => ORDER.indexOf(groupOf(row.status));
  if (opts.by === "status") return ORDER.map((key) => ({ key, label: GROUP_LABEL[key], rows: kept.filter((row) => groupOf(row.status) === key) })).filter((group) => group.rows.length);
  return [...new Set(kept.map((row) => row.project))].sort((a, b) => a.localeCompare(b)).map((project) => ({ key: project, label: project, rows: kept.filter((row) => row.project === project).sort((a, b) => rank(a) - rank(b)) }));
}
