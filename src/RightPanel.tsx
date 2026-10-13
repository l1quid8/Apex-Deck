// src/RightPanel.tsx
import { useRef, useState, type ReactNode } from "react";
import { FIXED, KINDS, activate, closeTab, moveTab, openTab, type PanelTab, type RightPanelState, type TabKind } from "./rightPanelModel";
import "./right-panel.css";

export const TAB_LABEL: Record<TabKind, string> = { dashboard: "Dashboard", tasks: "Tasks", details: "Details", browser: "Browser", files: "Files", worktrees: "Worktrees" };

/** Tab-strip line icons, drawn on the same 24-unit grid / 1.7 stroke as SidebarIcons. Kept local so the tab strip has no extra imports. */
const TAB_PATHS: Record<TabKind, ReactNode> = {
  dashboard: <><rect x="3" y="3" width="8" height="8" rx="1.5" /><rect x="13" y="3" width="8" height="8" rx="1.5" /><rect x="3" y="13" width="8" height="8" rx="1.5" /><rect x="13" y="13" width="8" height="8" rx="1.5" /></>,
  tasks: <><rect x="4" y="4" width="16" height="16" rx="3" /><path d="m8.5 12.5 2.5 2.5 5-5.5" /></>,
  details: <><circle cx="12" cy="12" r="9" /><path d="M12 7.5v5.5M12 16.5v.01" /></>,
  browser: <><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3Z" /></>,
  files: <path d="M3 7a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v9H3V7Z" />,
  worktrees: <><circle cx="18" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="M6 3v12" /><path d="M18 9a9 9 0 0 1-9 9" /></>,
};

function TabIcon({ kind }: { kind: TabKind }) {
  return <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{TAB_PATHS[kind]}</svg>;
}
const EMPTY: Partial<Record<TabKind, string>> = { details: "Open a thread to see its details." };

interface Props {
  state: RightPanelState;
  onChange: (next: RightPanelState) => void;
  bodies: Partial<Record<TabKind, (tab: PanelTab, visible: boolean) => ReactNode>>;
  onClose: () => void;
  onFull: (full: boolean) => void;
  taskAttention?: { count: number; details: string };
}

/** The right panel: a row of tabs and the tab in front. Hidden tabs stay mounted so pages and trees keep their place. */
export function RightPanel({ state, onChange, bodies, onClose, onFull, taskAttention }: Props) {
  const [adding, setAdding] = useState(false);
  const dragging = useRef<string | null>(null);
  const now = () => Date.now();
  return <div className="right-panel">
    <div className="right-panel-tabs" role="tablist" aria-label="Side panel">
      {state.tabs.map((tab, index) => {
        const fixed = FIXED.includes(tab.kind);
        const label = tab.kind === "browser" && tab.url ? hostOf(tab.url) : TAB_LABEL[tab.kind];
        const flaggedTasks = tab.kind === "tasks" && !!taskAttention?.count;
        return <div key={tab.id} className={`right-panel-tab${tab.id === state.active ? " active" : ""}${flaggedTasks && tab.id === state.active ? " has-attention" : ""}`}
          draggable={!fixed}
          onDragStart={() => { dragging.current = tab.id; }}
          onDragOver={(e) => { if (dragging.current) e.preventDefault(); }}
          onDrop={() => { if (dragging.current) onChange(moveTab(state, dragging.current, index)); dragging.current = null; }}>
          <button role="tab" id={`right-tab-${tab.id}`} aria-selected={tab.id === state.active} aria-controls={`right-body-${tab.id}`} aria-label={flaggedTasks ? taskAttention?.details : label} title={flaggedTasks ? taskAttention?.details : label} onClick={() => onChange(activate(state, tab.id, now()))}><TabIcon kind={tab.kind} /><span className="right-panel-tab-label" aria-hidden="true">{label}</span></button>
          {!fixed && <button className="icon small" aria-label={`Close ${label}`} onClick={() => onChange(closeTab(state, tab.id))}>×</button>}
        </div>;
      })}
      <button className="icon small" aria-label="Add a tab" aria-expanded={adding} onClick={() => setAdding((v) => !v)}>+</button>
      <button className="icon small right-panel-full" aria-label={state.full ? "Collapse side panel" : "Expand side panel"} aria-pressed={state.full} title={state.full ? "Collapse" : "Expand"} onClick={() => onFull(!state.full)}>{state.full ? "⤡" : "⤢"}</button>
      <button className="icon small right-panel-close" aria-label="Hide side panel" onClick={onClose}>×</button>
    </div>
    {adding && <div className="right-panel-add" role="menu">
      {KINDS.filter((k) => !FIXED.includes(k)).map((kind) => <button key={kind} role="menuitem" onClick={() => { setAdding(false); onChange(openTab(state, kind, now())); }}><TabIcon kind={kind} />{TAB_LABEL[kind]}</button>)}
    </div>}
    {state.tabs.map((tab) => {
      const visible = state.open && tab.id === state.active;
      const body = bodies[tab.kind];
      return <section key={tab.id} id={`right-body-${tab.id}`} role="tabpanel" aria-labelledby={`right-tab-${tab.id}`} className="right-panel-body" hidden={!visible}>
        {body ? body(tab, visible) : <p className="muted right-panel-empty">{EMPTY[tab.kind] ?? ""}</p>}
      </section>;
    })}
  </div>;
}

function hostOf(url: string): string {
  try { return new URL(url).host || "Browser"; } catch { return "Browser"; }
}
