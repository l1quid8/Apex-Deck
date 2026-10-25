import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { dashboard, GROUP_LABEL, type DashboardDestination, type DashGroup, type DashRow } from "./dashboardModel";
import { MenuList, type MenuAnchor, type MenuEntry } from "./Menu";

const COLLAPSED_KEY = "apex-deck:dashboard-collapsed:v1";
const STATUS_LABEL = { working: "Working", idle: "Idle", exited: "Exited", needs_input: "Needs you", failed: "Failed", done: "Done" };

export function RightDashboard({ rows, onOpen, visible = true }: { rows: DashRow[]; onOpen: (id: string, destination?: DashboardDestination) => void; visible?: boolean }) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<DashGroup | "all">("all");
  const [by, setBy] = useState<"status" | "project">("status");
  const [menu, setMenu] = useState<{ id: string; anchor: MenuAnchor; opener: HTMLElement } | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]");
      return new Set(Array.isArray(saved) ? saved.filter((key): key is string => typeof key === "string") : []);
    } catch { return new Set(); }
  });
  useEffect(() => {
    try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsed])); } catch { /* The panel still works if storage is unavailable. */ }
  }, [collapsed]);
  const toggle = (key: string) => setCollapsed((current) => {
    const next = new Set(current);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });
  const groups = dashboard(rows, { query, filter, by });
  const menuRow = menu ? groups.flatMap((group) => collapsed.has(`${by}:${group.key}`) ? [] : group.rows).find((row) => row.id === menu.id) : undefined;
  useEffect(() => { if (menu && (!menuRow || !visible)) setMenu(null); }, [menu, menuRow, visible]);
  const menuEntries = (row: DashRow): MenuEntry[] => {
    const navigation = row.navigation;
    const externalReason = navigation ? navigation.externalReason : "Pop-outs need the Deck app.";
    const targets = navigation?.targets ?? [];
    return [
      { key: "new", label: "Open in New Pane", disabled: !!navigation?.inDeckReason, reason: navigation?.inDeckReason, onSelect: () => onOpen(row.id, { kind: "new" }) },
      { key: "external", label: "Open in External Pane", disabled: !!externalReason, reason: externalReason, onSelect: () => onOpen(row.id, { kind: "external" }) },
      { key: "pane", label: "Open in Pane…", disabled: !!navigation?.inDeckReason || !targets.length, reason: navigation?.inDeckReason || (!targets.length ? "No other panes are open in this view." : "Swap this item with the selected pane."),
        submenu: targets.map((target) => ({ key: target.id, label: target.title, onSelect: () => onOpen(row.id, { kind: "pane", paneId: target.id }) })) },
    ];
  };
  const waiting = rows.filter((row) => row.status === "needs_input");
  const waitingTitle = waiting.length
    ? `Waiting for you (${waiting.length})\n${waiting.map((row) => `${row.title}${row.project ? ` · ${row.project}` : ""}: ${row.note || "Needs your response"}`).join("\n")}`
    : undefined;
  return <div className="right-dashboard">
    <header className="right-dashboard-heading"><h2>Dashboard</h2><p className="muted">Your workspace at a glance</p></header>
    <div className="right-dashboard-tools"><input type="search" placeholder="Search" aria-label="Search threads and terminals" value={query} onChange={(e) => setQuery(e.target.value)} /><select aria-label="Group by" value={by} onChange={(e) => setBy(e.target.value as "status" | "project")}><option value="status">By status</option><option value="project">By project</option></select></div>
    <div className="right-dashboard-filters" role="radiogroup" aria-label="Show">{(["all", "waiting", "working", "done", "idle"] as const).map((key) => <button key={key} role="radio" aria-checked={filter === key} title={key === "waiting" ? waitingTitle : undefined} className={key === "waiting" && filter === key && waiting.length ? "has-attention" : undefined} onClick={() => setFilter(key)}>{key === "all" ? "All" : GROUP_LABEL[key]}</button>)}</div>
    {!groups.length && <p className="muted right-panel-empty">{rows.length ? "Nothing matches." : "No threads or terminals yet."}</p>}
    {groups.map((group) => {
      const key = `${by}:${group.key}`;
      const expanded = !collapsed.has(key);
      return <section key={key}>
        <h3 className="right-dashboard-group"><button type="button" aria-expanded={expanded} onClick={() => toggle(key)}>
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d={expanded ? "m4 6 4 4 4-4" : "m6 4 4 4-4 4"} /></svg>
          <span>{group.label || "No project"}</span><span className="muted dash-group-count">{group.rows.length}</span>
        </button></h3>
        <ul className="right-dashboard-list" hidden={!expanded}>{group.rows.map((row) => {
          const ready = row.ready && row.status === "done";
          const note = row.status === "working" && row.ready ? "" : row.note;
          return <li key={row.id}><button type="button" onClick={() => onOpen(row.id)} aria-haspopup="menu" aria-expanded={menu?.id === row.id}
            onContextMenu={(event) => {
              event.preventDefault(); event.stopPropagation();
              setMenu({ id: row.id, anchor: { x: event.clientX, y: event.clientY }, opener: event.currentTarget });
            }}
            onKeyDown={(event) => {
              if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
              event.preventDefault(); event.stopPropagation();
              setMenu({ id: row.id, anchor: { rect: event.currentTarget.getBoundingClientRect() }, opener: event.currentTarget });
            }}>
            <span className="dash-row-copy"><strong className="dash-title">{row.title}</strong><span className="muted dash-project">{row.project || (row.kind === "terminal" ? "Terminal" : "Thread")}</span>{note && note !== row.project && <span className="muted dash-note">{note}</span>}</span>
            <span className={`dash-status dash-status-${row.status}${ready ? " dash-ready" : ""}`} title={row.status === "needs_input" ? row.needsDetails || note : ready ? `${row.readyCount ?? 1} ready in this project${note ? `: ${note}` : ""}` : undefined}>{ready ? "Ready" : STATUS_LABEL[row.status]}</span>
          </button></li>;
        })}</ul>
      </section>;
    })}
    {visible && menu && menuRow && createPortal(<MenuList key={menu.id} id={`dashboard:${menu.id}`} label={`Open ${menuRow.title}`} entries={menuEntries(menuRow)} anchor={menu.anchor} opener={menu.opener} onClose={() => setMenu(null)} />, document.body)}
  </div>;
}
