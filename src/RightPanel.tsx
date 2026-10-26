// src/RightPanel.tsx
import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { isWindows } from "./paths";
import { FIXED, KINDS, TAB_GAP, activate, closeTab, fitTabs, moveTab, openTab, outsideViewport, tabIndexAt, tabReleaseAction, type PanelTab, type RightPanelState, type TabFit, type TabKind } from "./rightPanelModel";
import "./right-panel.css";

export const TAB_LABEL: Record<TabKind, string> = { dashboard: "Dashboard", tasks: "Tasks", details: "Details", artifacts: "Artifacts", browser: "Browser", assistantbrowser: "Browser", files: "Files", worktrees: "Worktrees", phone: "Phone", terminal: "Terminal" };

/** Tab-strip line icons, drawn on the same 24-unit grid / 1.7 stroke as SidebarIcons. Kept local so the tab strip has no extra imports. */
const TAB_PATHS: Record<TabKind, ReactNode> = {
  dashboard: <><rect x="3" y="3" width="8" height="8" rx="1.5" /><rect x="13" y="3" width="8" height="8" rx="1.5" /><rect x="3" y="13" width="8" height="8" rx="1.5" /><rect x="13" y="13" width="8" height="8" rx="1.5" /></>,
  tasks: <><rect x="4" y="4" width="16" height="16" rx="3" /><path d="m8.5 12.5 2.5 2.5 5-5.5" /></>,
  details: <><circle cx="12" cy="12" r="9" /><path d="M12 7.5v5.5M12 16.5v.01" /></>,
  artifacts: <><path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z" /><path d="M14 3v5h5" /><path d="M8 13h8" /><path d="M8 17h6" /></>,
  browser: <><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3Z" /></>,
  assistantbrowser: <><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3Z" /></>,
  files: <path d="M3 7a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v9H3V7Z" />,
  worktrees: <><circle cx="18" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="M6 3v12" /><path d="M18 9a9 9 0 0 1-9 9" /></>,
  phone: <><rect x="6.5" y="2.5" width="11" height="19" rx="2.5" /><path d="M10.5 18.5h3" /></>,
  terminal: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M7 9l3 3-3 3" /><path d="M12 15h5" /></>,
};

function TabIcon({ kind }: { kind: TabKind }) {
  return <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{TAB_PATHS[kind]}</svg>;
}
const EMPTY: Partial<Record<TabKind, string>> = { details: "Open a thread to see its details.", artifacts: "Open a thread to see its artifacts." };

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
  const [menuOpen, setMenuOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [layout, setLayout] = useState<{ fit: TabFit; hidden: string[] }>({ fit: "all", hidden: [] });
  const [tip, setTip] = useState<{ text: string; x: number } | null>(null);
  const [context, setContext] = useState<{ id: string; x: number; y: number } | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const strip = useRef<HTMLDivElement | null>(null);
  const panel = useRef<HTMLDivElement | null>(null);
  const controls = useRef<HTMLDivElement | null>(null);
  const meter = useRef<HTMLSpanElement | null>(null);
  const tipBox = useRef<HTMLDivElement | null>(null);
  const moreButton = useRef<HTMLButtonElement | null>(null);
  const menu = useRef<HTMLDivElement | null>(null);
  // Name widths, measured once per name rather than on every resize.
  const widths = useRef(new Map<string, number>());
  const suppressClick = useRef(false);
  const now = () => Date.now();
  const tabs = isWindows ? state.tabs.filter((t) => t.kind !== "phone") : state.tabs;
  const selectedTab = tabs.find((tab) => tab.id === state.active);
  const canRemove = !!selectedTab && !FIXED.includes(selectedTab.kind);
  // The window listeners below outlive the render that attached them.
  const live = useRef({ state, onChange, onPopoutDragOut });
  live.current = { state, onChange, onPopoutDragOut };
  const labelOf = (tab: PanelTab) => tab.kind === "browser" && tab.url ? hostOf(tab.url) : TAB_LABEL[tab.kind];
  const labels = tabs.map(labelOf);
  const fitKey = `${labels.join("\n")}\n${state.active}`;
  const fitRef = useRef<() => void>(() => {});
  fitRef.current = () => {
    const bar = strip.current, ctl = controls.current, ruler = meter.current;
    if (!bar || !ctl || !ruler || !bar.clientWidth) return;
    const ws = labels.map((text) => {
      let w = widths.current.get(text);
      if (w === undefined) {
        ruler.textContent = text;
        w = ruler.getBoundingClientRect().width;
        // A zero width means the ruler wasn't laid out; caching it would fit a real name into no room.
        if (w > 0) widths.current.set(text, w);
      }
      return w;
    });
    const pad = getComputedStyle(bar);
    const avail = bar.clientWidth - parseFloat(pad.paddingLeft) - parseFloat(pad.paddingRight) - ctl.getBoundingClientRect().width - TAB_GAP;
    setLayout((prev) => {
      const next = fitTabs(ws, tabs.findIndex((t) => t.id === state.active), avail, prev.fit);
      const hidden = tabs.filter((_, i) => !next.shown[i]).map((t) => t.id);
      return next.fit === prev.fit && hidden.join() === prev.hidden.join() ? prev : { fit: next.fit, hidden };
    });
  };
  useLayoutEffect(() => { fitRef.current(); }, [fitKey]);
  // Centre the bubble under its icon, then pull it back inside the panel's edges.
  useLayoutEffect(() => {
    const el = tipBox.current, box = panel.current;
    if (!tip || !el || !box) return;
    const w = el.getBoundingClientRect().width;
    el.style.left = `${Math.max(6, Math.min(tip.x - w / 2, box.clientWidth - w - 6))}px`;
  }, [tip]);
  useEffect(() => {
    const el = panel.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const watch = new ResizeObserver(() => fitRef.current());
    watch.observe(el);
    return () => watch.disconnect();
  }, []);
  useEffect(() => {
    if (!menuOpen) return;
    const away = (e: PointerEvent) => { const t = e.target as Node; if (!menu.current?.contains(t) && !moreButton.current?.contains(t)) setMenuOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { setMenuOpen(false); moreButton.current?.focus(); } };
    window.addEventListener("pointerdown", away);
    window.addEventListener("keydown", key);
    return () => { window.removeEventListener("pointerdown", away); window.removeEventListener("keydown", key); };
  }, [menuOpen]);
  useEffect(() => { if (menuOpen) menu.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus(); }, [menuOpen]);
  const toggleMenu = () => { setAddOpen(false); setMenuOpen((v) => !v); };
  const showTip = (button: HTMLElement, text: string, labelled: boolean) => {
    const box = panel.current?.getBoundingClientRect();
    if (labelled || !box) return;
    const b = button.getBoundingClientRect();
    setTip({ text, x: b.left - box.left + b.width / 2 });
  };
  const overflow = tabs.filter((t) => layout.hidden.includes(t.id));
  // Already-open tools are left out; Browser can open more than one. Phone is hidden on Windows.
  const addable = KINDS.filter((k) => !FIXED.includes(k) && !(isWindows && k === "phone") && (k === "browser" || !tabs.some((t) => t.kind === k)));

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
  return <div className="right-panel" data-fit={layout.fit} ref={panel}>
    <div className="right-panel-tabs" role="tablist" aria-label="Side panel" ref={strip}>
      {tabs.map((tab, i) => {
        const label = labels[i];
        const active = tab.id === state.active;
        // The flag belongs to the Tasks tab, not to being in front: it shows while tasks wait,
        // so you can see them waiting from another tab.
        const flaggedTasks = tab.kind === "tasks" && !!taskAttention?.count;
        const name = flaggedTasks ? taskAttention!.details : label;
        const labelled = layout.fit === "all" || (layout.fit === "mid" && active);
        return <div key={tab.id} data-tab-id={tab.id} hidden={layout.hidden.includes(tab.id)} className={`right-panel-tab${active ? " active" : ""}${flaggedTasks ? " has-attention" : ""}${dragId === tab.id ? " dragging" : ""}`}
          // Every tab can drag out into a window; reordering fixed tabs is refused by moveTab.
          onPointerDown={(e) => beginTabDrag(tab.id, e)}
          onContextMenu={onPopout ? (e) => { e.preventDefault(); setContext({ id: tab.id, x: e.clientX, y: e.clientY }); } : undefined}>
          <button role="tab" id={`right-tab-${tab.id}`} aria-selected={active} aria-controls={`right-body-${tab.id}`} aria-label={name}
            onPointerEnter={(e) => showTip(e.currentTarget, name, labelled && !flaggedTasks)} onFocus={(e) => showTip(e.currentTarget, name, labelled && !flaggedTasks)} onPointerLeave={() => setTip(null)} onBlur={() => setTip(null)}
            onClick={() => { if (suppressClick.current) { suppressClick.current = false; return; } setTip(null); onChange(activate(state, tab.id, now())); }}><TabIcon kind={tab.kind} /><span className="right-panel-tab-label" aria-hidden="true">{label}</span></button>
        </div>;
      })}
      <div className="right-panel-ctl" ref={controls}>
        <button ref={moreButton} className="icon small" aria-label="Sidebar options" title="Sidebar options" aria-haspopup="menu" aria-expanded={menuOpen} onClick={toggleMenu}>⋯</button>
        <button className="icon small" aria-label="Hide side panel" title="Close sidebar" onClick={() => { setMenuOpen(false); onClose(); }}>×</button>
      </div>
    </div>
    <div className="right-panel-name" aria-hidden="true">{selectedTab ? labels[tabs.indexOf(selectedTab)] : ""}</div>
    <span className="right-panel-tab-label right-panel-meter" ref={meter} aria-hidden="true" />
    {tip && <div className="right-panel-tip" ref={tipBox} aria-hidden="true">{tip.text}</div>}
    {menuOpen && <div className="right-panel-menu" role="menu" ref={menu}>
      {overflow.length > 0 && <>
        <div className="right-panel-menu-sub">More tabs</div>
        {overflow.map((tab) => <button key={tab.id} role="menuitem" onClick={() => { setMenuOpen(false); onChange(activate(state, tab.id, now())); }}><span className="right-panel-menu-glyph"><TabIcon kind={tab.kind} /></span>{labelOf(tab)}</button>)}
        <hr />
      </>}
      <button role="menuitem" aria-expanded={addOpen} onClick={() => setAddOpen((v) => !v)}><span className="right-panel-menu-glyph">+</span>Add tool<span className="right-panel-menu-key" aria-hidden="true">{addOpen ? "⌄" : "›"}</span></button>
      {addOpen && addable.map((kind) => <button key={kind} role="menuitem" className="indent" onClick={() => { setMenuOpen(false); onChange(openTab(state, kind, now())); }}><span className="right-panel-menu-glyph"><TabIcon kind={kind} /></span>{TAB_LABEL[kind]}</button>)}
      <hr />
      <button role="menuitem" disabled={!canRemove} title={!canRemove && selectedTab ? `${TAB_LABEL[selectedTab.kind]} is a permanent tool` : undefined} onClick={() => { if (!canRemove) return; setMenuOpen(false); onChange(closeTab(state, state.active)); }}><span className="right-panel-menu-glyph">−</span>{selectedTab ? `Remove ${labelOf(selectedTab)}` : "Remove tool"}</button>
      <button role="menuitem" aria-pressed={state.full} onClick={() => { setMenuOpen(false); onFull(!state.full); }}><span className="right-panel-menu-glyph">{state.full ? "⤡" : "⤢"}</span>{state.full ? "Collapse" : "Expand"}</button>
    </div>}
    {context && <div className="right-panel-context-backdrop" onClick={() => setContext(null)} onContextMenu={(e) => { e.preventDefault(); setContext(null); }}>
      <div className="right-panel-context" role="menu" style={{ left: context.x, top: context.y }}>
        <button role="menuitem" onClick={() => { const id = context.id; setContext(null); onPopout?.(id); }}>Open in new window</button>
      </div>
    </div>}
    {tabs.map((tab) => {
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
