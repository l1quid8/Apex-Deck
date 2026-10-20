// src/RightPanel.tsx
import { useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { FIXED, KINDS, activate, closeTab, moveTab, openTab, outsideViewport, tabIndexAt, tabReleaseAction, type PanelTab, type RightPanelState, type TabKind } from "./rightPanelModel";
import "./right-panel.css";

export const TAB_LABEL: Record<TabKind, string> = { dashboard: "Dashboard", tasks: "Tasks", details: "Details", browser: "Browser", files: "Files", worktrees: "Worktrees", phone: "Phone" };

/** Tab-strip line icons, drawn on the same 24-unit grid / 1.7 stroke as SidebarIcons. Kept local so the tab strip has no extra imports. */
const TAB_PATHS: Record<TabKind, ReactNode> = {
  dashboard: <><rect x="3" y="3" width="8" height="8" rx="1.5" /><rect x="13" y="3" width="8" height="8" rx="1.5" /><rect x="3" y="13" width="8" height="8" rx="1.5" /><rect x="13" y="13" width="8" height="8" rx="1.5" /></>,
  tasks: <><rect x="4" y="4" width="16" height="16" rx="3" /><path d="m8.5 12.5 2.5 2.5 5-5.5" /></>,
  details: <><circle cx="12" cy="12" r="9" /><path d="M12 7.5v5.5M12 16.5v.01" /></>,
  browser: <><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3Z" /></>,
  files: <path d="M3 7a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v9H3V7Z" />,
  worktrees: <><circle cx="18" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="M6 3v12" /><path d="M18 9a9 9 0 0 1-9 9" /></>,
  phone: <><rect x="6.5" y="2.5" width="11" height="19" rx="2.5" /><path d="M10.5 18.5h3" /></>,
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
  /** Pop a tab out into its own window, from its right-click menu. */
  onPopout?: (tabId: string) => void;
  /** A tab dragged out past the window's edge, with where it was dropped. */
  onPopoutDragOut?: (tabId: string, x: number, y: number) => void;
}

/** The right panel: a row of tabs and the tab in front. Hidden tabs stay mounted so pages and trees keep their place. */
export function RightPanel({ state, onChange, bodies, onClose, onFull, taskAttention, onPopout, onPopoutDragOut }: Props) {
  const [adding, setAdding] = useState(false);
  const [context, setContext] = useState<{ id: string; x: number; y: number } | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const strip = useRef<HTMLDivElement | null>(null);
  const suppressClick = useRef(false);
  const now = () => Date.now();
  const selectedTab = state.tabs.find((tab) => tab.id === state.active);
  const canRemove = !!selectedTab && !FIXED.includes(selectedTab.kind);
  // The window listeners below outlive the render that attached them.
  const live = useRef({ state, onChange, onPopoutDragOut });
  live.current = { state, onChange, onPopoutDragOut };

  /** Press a tab: past a small travel it is a drag — reorder inside, pop out past the
   *  window's edge — and without the travel it stays a plain click. Pointer capture
   *  keeps the release coming while off-window, which HTML5 drag never delivered. */
  const beginTabDrag = (tabId: string, event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    const button = (event.target as HTMLElement).closest("button");
    if (button && button.getAttribute("role") !== "tab") return;
    suppressClick.current = false;
    const press = { id: tabId, x: event.clientX, y: event.clientY, active: false, el: event.currentTarget as HTMLElement, pid: event.pointerId };
    const move = (e: PointerEvent) => {
      if (press.active) return;
      if (Math.hypot(e.clientX - press.x, e.clientY - press.y) < 6) return;
      press.active = true;
      setDragId(press.id);
      try { press.el.setPointerCapture(press.pid); } catch { /* Capture can fail as the press ends; the drag still works inside. */ }
    };
    const finish = (e: PointerEvent | null) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", key);
      try { if (press.el.hasPointerCapture?.(press.pid)) press.el.releasePointerCapture(press.pid); } catch { /* The element may be gone. */ }
      setDragId(null);
      if (!press.active) return;
      suppressClick.current = true;
      if (!e) return;
      const current = live.current;
      const action = tabReleaseAction(true, outsideViewport(e.clientX, e.clientY, window.innerWidth, window.innerHeight));
      if (action === "popout") { current.onPopoutDragOut?.(press.id, e.screenX, e.screenY); return; }
      const bar = strip.current;
      if (!bar) return;
      const rects = current.state.tabs.map((t) => {
        const box = bar.querySelector(`[data-tab-id="${t.id}"]`)?.getBoundingClientRect();
        return box ? { left: box.left, right: box.right } : { left: 0, right: 0 };
      });
      const to = tabIndexAt(rects, e.clientX);
      if (to >= 0) current.onChange(moveTab(current.state, press.id, to));
    };
    const up = (e: PointerEvent) => finish(e);
    const cancel = () => finish(null);
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") finish(null); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", key);
  };
  return <div className="right-panel">
    <div className="right-panel-tabs" role="tablist" aria-label="Side panel" ref={strip}>
      {state.tabs.map((tab) => {
        const label = tab.kind === "browser" && tab.url ? hostOf(tab.url) : TAB_LABEL[tab.kind];
        const flaggedTasks = tab.kind === "tasks" && !!taskAttention?.count;
        return <div key={tab.id} data-tab-id={tab.id} className={`right-panel-tab${tab.id === state.active ? " active" : ""}${flaggedTasks && tab.id === state.active ? " has-attention" : ""}${dragId === tab.id ? " dragging" : ""}`}
          // Every tab can drag out into a window; reordering fixed tabs is refused by moveTab.
          onPointerDown={(e) => beginTabDrag(tab.id, e)}
          onContextMenu={onPopout ? (e) => { e.preventDefault(); setContext({ id: tab.id, x: e.clientX, y: e.clientY }); } : undefined}>
          <button role="tab" id={`right-tab-${tab.id}`} aria-selected={tab.id === state.active} aria-controls={`right-body-${tab.id}`} aria-label={flaggedTasks ? taskAttention?.details : label} title={flaggedTasks ? taskAttention?.details : label} onClick={() => { if (suppressClick.current) { suppressClick.current = false; return; } onChange(activate(state, tab.id, now())); }}><TabIcon kind={tab.kind} /><span className="right-panel-tab-label" aria-hidden="true">{label}</span></button>
        </div>;
      })}
      <button className="icon small" aria-label="Add a tab" title="Add sidebar tool" aria-expanded={adding} onClick={() => setAdding((v) => !v)}>+</button>
      <button className="icon small" aria-label="Remove selected tool" title={canRemove ? `Remove ${TAB_LABEL[selectedTab.kind]}` : selectedTab ? `${TAB_LABEL[selectedTab.kind]} is a permanent tool` : "No tool selected"} disabled={!canRemove} onClick={() => { if (!canRemove) return; setAdding(false); onChange(closeTab(state, state.active)); }}>−</button>
      <button className="icon small right-panel-full" aria-label={state.full ? "Collapse side panel" : "Expand side panel"} aria-pressed={state.full} title={state.full ? "Collapse" : "Expand"} onClick={() => onFull(!state.full)}>{state.full ? "⤡" : "⤢"}</button>
      <button className="icon small right-panel-close" aria-label="Hide side panel" title="Close sidebar" onClick={() => { setAdding(false); onClose(); }}>×</button>
    </div>
    {adding && <div className="right-panel-add" role="menu">
      {KINDS.filter((k) => !FIXED.includes(k)).map((kind) => <button key={kind} role="menuitem" onClick={() => { setAdding(false); onChange(openTab(state, kind, now())); }}><TabIcon kind={kind} />{TAB_LABEL[kind]}</button>)}
    </div>}
    {context && <div className="right-panel-context-backdrop" onClick={() => setContext(null)} onContextMenu={(e) => { e.preventDefault(); setContext(null); }}>
      <div className="right-panel-context" role="menu" style={{ left: context.x, top: context.y }}>
        <button role="menuitem" onClick={() => { const id = context.id; setContext(null); onPopout?.(id); }}>Open in new window</button>
      </div>
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
