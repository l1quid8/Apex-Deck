// src/RightPanel.tsx
import { useRef, useState, type ReactNode } from "react";
import { FIXED, KINDS, activate, closeTab, moveTab, openTab, type PanelTab, type RightPanelState, type TabKind } from "./rightPanelModel";
import "./right-panel.css";

export const TAB_LABEL: Record<TabKind, string> = { dashboard: "Dashboard", tasks: "Tasks", details: "Details", browser: "Browser", files: "Files" };
const EMPTY: Partial<Record<TabKind, string>> = { details: "Open a thread to see its details." };

interface Props {
  state: RightPanelState;
  onChange: (next: RightPanelState) => void;
  bodies: Partial<Record<TabKind, (tab: PanelTab, visible: boolean) => ReactNode>>;
  onClose: () => void;
}

/** The right panel: a row of tabs and the tab in front. Hidden tabs stay mounted so pages and trees keep their place. */
export function RightPanel({ state, onChange, bodies, onClose }: Props) {
  const [adding, setAdding] = useState(false);
  const dragging = useRef<string | null>(null);
  const now = () => Date.now();
  return <div className="right-panel">
    <div className="right-panel-tabs" role="tablist" aria-label="Side panel">
      {state.tabs.map((tab, index) => {
        const fixed = FIXED.includes(tab.kind);
        const label = tab.kind === "browser" && tab.url ? hostOf(tab.url) : TAB_LABEL[tab.kind];
        return <div key={tab.id} className={`right-panel-tab${tab.id === state.active ? " active" : ""}`}
          draggable={!fixed}
          onDragStart={() => { dragging.current = tab.id; }}
          onDragOver={(e) => { if (dragging.current) e.preventDefault(); }}
          onDrop={() => { if (dragging.current) onChange(moveTab(state, dragging.current, index)); dragging.current = null; }}>
          <button role="tab" id={`right-tab-${tab.id}`} aria-selected={tab.id === state.active} aria-controls={`right-body-${tab.id}`} title={label} onClick={() => onChange(activate(state, tab.id, now()))}>{label}</button>
          {!fixed && <button className="icon small" aria-label={`Close ${label}`} onClick={() => onChange(closeTab(state, tab.id))}>×</button>}
        </div>;
      })}
      <button className="icon small" aria-label="Add a tab" aria-expanded={adding} onClick={() => setAdding((v) => !v)}>+</button>
      <button className="icon small right-panel-close" aria-label="Hide side panel" onClick={onClose}>×</button>
    </div>
    {adding && <div className="right-panel-add" role="menu">
      {KINDS.filter((k) => !FIXED.includes(k)).map((kind) => <button key={kind} role="menuitem" onClick={() => { setAdding(false); onChange(openTab(state, kind, now())); }}>{TAB_LABEL[kind]}</button>)}
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
