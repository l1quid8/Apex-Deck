import { useState } from "react";
import { dashboard, GROUP_LABEL, type DashGroup, type DashRow } from "./dashboardModel";

export function RightDashboard({ rows, onOpen }: { rows: DashRow[]; onOpen: (id: string) => void }) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<DashGroup | "all">("all");
  const [by, setBy] = useState<"status" | "project">("status");
  const groups = dashboard(rows, { query, filter, by });
  const waiting = rows.filter((row) => row.status === "needs_input");
  const waitingTitle = waiting.length
    ? `Waiting for you (${waiting.length})\n${waiting.map((row) => `${row.title}${row.project ? ` · ${row.project}` : ""}: ${row.note || "Needs your response"}`).join("\n")}`
    : undefined;
  return <div className="right-dashboard">
    <div className="right-dashboard-tools"><input type="search" placeholder="Search" aria-label="Search threads and terminals" value={query} onChange={(e) => setQuery(e.target.value)} /><select aria-label="Group by" value={by} onChange={(e) => setBy(e.target.value as "status" | "project")}><option value="status">By status</option><option value="project">By project</option></select></div>
    <div className="right-dashboard-filters" role="radiogroup" aria-label="Show">{(["all", "waiting", "working", "done", "idle"] as const).map((key) => <button key={key} role="radio" aria-checked={filter === key} title={key === "waiting" ? waitingTitle : undefined} className={key === "waiting" && filter === key && waiting.length ? "has-attention" : undefined} onClick={() => setFilter(key)}>{key === "all" ? "All" : GROUP_LABEL[key]}</button>)}</div>
    {!groups.length && <p className="muted right-panel-empty">{rows.length ? "Nothing matches." : "No threads or terminals yet."}</p>}
    {groups.map((group) => <section key={group.key}><h3 className="right-dashboard-group">{group.label} <span className="muted">{group.rows.length}</span></h3><ul className="right-dashboard-list">{group.rows.map((row) => <li key={row.id}><button onClick={() => onOpen(row.id)}><span className={`dash-dot dash-${row.status}`} aria-hidden="true"/><span className="dash-title-line"><span className="dash-title">{row.title}</span>{row.needsCount ? <span className="dash-needs" title={row.needsDetails || "Items waiting for your response"}>Needs you · {row.needsCount}</span> : null}{row.ready && <span className="dash-ready" title={row.note || "Completed work is ready to review"}>Ready · {row.readyCount ?? 1}</span>}</span><span className="muted dash-note">{row.note || row.project}</span></button></li>)}</ul></section>)}
  </div>;
}
