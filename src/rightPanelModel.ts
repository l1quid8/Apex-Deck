// src/rightPanel.ts
// The right panel's tabs: which are open, which is in front, and the rules
// for adding, closing and reordering them. No interface code, so it can be
// tested on its own. Dashboard and Tasks are always there, first and second.

export type TabKind = "dashboard" | "tasks" | "details" | "artifacts" | "browser" | "assistantbrowser" | "files" | "worktrees" | "phone";
export interface PanelTab { id: string; kind: TabKind; url?: string; usedAt: number }
/** `full` fills the work area; it only means anything while `open`. */
export interface RightPanelState { open: boolean; full: boolean; tabs: PanelTab[]; active: string }

export const FIXED: TabKind[] = ["dashboard", "tasks"];
export const KINDS: TabKind[] = ["dashboard", "tasks", "details", "artifacts", "browser", "assistantbrowser", "files", "worktrees", "phone"];
export const BROWSER_CAP = 8;
const STORAGE_KEY = "apex-deck.right-panel.v1";

const fixedTab = (kind: TabKind): PanelTab => ({ id: kind, kind, usedAt: 0 });

export function defaultPanel(): RightPanelState {
  return { open: false, full: false, tabs: [fixedTab("dashboard"), fixedTab("tasks"), fixedTab("details")], active: "dashboard" };
}

let seq = 0;
const newId = (kind: TabKind, now: number) => `${kind}-${now.toString(36)}-${(seq++).toString(36)}`;

export function openTab(s: RightPanelState, kind: TabKind, now: number, url?: string): RightPanelState {
  if (kind !== "browser") {
    const found = s.tabs.find((t) => t.kind === kind);
    if (found) return activate(s, found.id, now);
  }
  let tabs = s.tabs;
  if (kind === "browser") {
    const browsers = tabs.filter((t) => t.kind === "browser");
    if (browsers.length >= BROWSER_CAP) {
      const oldest = browsers.reduce((a, b) => (b.usedAt < a.usedAt ? b : a));
      tabs = tabs.filter((t) => t.id !== oldest.id);
    }
  }
  const tab: PanelTab = { id: kind === "browser" ? newId(kind, now) : kind, kind, usedAt: now, ...(url !== undefined ? { url } : {}) };
  return { ...s, open: true, tabs: [...tabs, tab], active: tab.id };
}

/** Fill the work area, or go back to docked. Filling also opens a closed panel. */
export function setFull(s: RightPanelState, full: boolean): RightPanelState {
  return { ...s, full, open: full ? true : s.open };
}

/** Hide the panel. It comes back docked, so full screen is cleared too. */
export function closePanel(s: RightPanelState): RightPanelState {
  return { ...s, open: false, full: false };
}

export function closeTab(s: RightPanelState, id: string): RightPanelState {
  const at = s.tabs.findIndex((t) => t.id === id);
  if (at < 0 || FIXED.includes(s.tabs[at].kind)) return s;
  const tabs = s.tabs.filter((t) => t.id !== id);
  const closable = tabs.filter((tab) => !FIXED.includes(tab.kind));
  const left = [...tabs.slice(0, at)].reverse().find((tab) => !FIXED.includes(tab.kind));
  const active = s.active === id ? (closable.length ? (left ?? tabs[at - 1] ?? tabs[0]).id : "dashboard") : s.active;
  return { ...s, tabs, active };
}

export function activate(s: RightPanelState, id: string, now: number): RightPanelState {
  if (!s.tabs.some((t) => t.id === id)) return s;
  return { ...s, open: true, active: id, tabs: s.tabs.map((t) => (t.id === id ? { ...t, usedAt: now } : t)) };
}

export function moveTab(s: RightPanelState, id: string, toIndex: number): RightPanelState {
  const from = s.tabs.findIndex((t) => t.id === id);
  if (from < 0 || FIXED.includes(s.tabs[from].kind)) return s;
  const rest = s.tabs.filter((t) => t.id !== id);
  const to = Math.max(FIXED.length, Math.min(rest.length, toIndex));
  return { ...s, tabs: [...rest.slice(0, to), s.tabs[from], ...rest.slice(to)] };
}

/** Read a saved panel, repairing anything missing, unknown, repeated or over the cap. */
export function parsePanel(raw: string | null, externalTabIds: readonly string[] = []): RightPanelState {
  const base = defaultPanel();
  let parsed: unknown;
  try { parsed = raw ? JSON.parse(raw) : null; } catch { return base; }
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as RightPanelState).tabs)) return base;
  const p = parsed as Partial<RightPanelState>;
  // Fixed IDs are reserved even if a damaged save mislabels one as a closable tab.
  const seen = new Set<string>(FIXED);
  const kept: PanelTab[] = [];
  for (const t of p.tabs as unknown[]) {
    const tab = t as Partial<PanelTab>;
    if (!tab || typeof tab.id !== "string" || !KINDS.includes(tab.kind as TabKind) || FIXED.includes(tab.kind as TabKind) || seen.has(tab.id)) continue;
    if (tab.kind !== "browser" && kept.some((k) => k.kind === tab.kind)) continue;
    seen.add(tab.id);
    kept.push({ id: tab.id, kind: tab.kind as TabKind, usedAt: typeof tab.usedAt === "number" ? tab.usedAt : 0, ...(typeof tab.url === "string" ? { url: tab.url } : {}) });
  }
  // External browsers have their own windows and do not use the docked slots.
  const external = new Set(externalTabIds);
  const browsers = kept.filter((t) => t.kind === "browser" && !external.has(t.id)).sort((a, b) => b.usedAt - a.usedAt).slice(0, BROWSER_CAP).map((t) => t.id);
  const tabs = [fixedTab("dashboard"), fixedTab("tasks"), ...kept.filter((t) => t.kind !== "browser" || external.has(t.id) || browsers.includes(t.id))];
  const active = typeof p.active === "string" && tabs.some((t) => t.id === p.active) ? p.active : "dashboard";
  return { open: p.open === true, full: p.full === true, tabs, active };
}

export function loadPanel(): RightPanelState {
  try { return parsePanel(localStorage.getItem(STORAGE_KEY)); } catch { return defaultPanel(); }
}

export function savePanel(s: RightPanelState) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); } catch { /* Storage can be unavailable; tabs then last this session only. */ }
}

/** Whether a point in window coordinates fell outside the window: a tab released there pops out. */
export function outsideViewport(x: number, y: number, width: number, height: number): boolean {
  return x < 0 || y < 0 || x > width || y > height;
}

/** What letting go of a pressed tab does: a plain press clicks, a drag out of the
 *  window pops out, and any other drag reorders. Fixed tabs pop out like the rest;
 *  only `moveTab` refuses to reorder them. */
export function tabReleaseAction(moved: boolean, outside: boolean): "click" | "popout" | "reorder" {
  if (!moved) return "click";
  return outside ? "popout" : "reorder";
}

/** The tab a release at `x` lands on, by tab centers: the first tab whose center is
 *  past `x`, or the last one. -1 when there are no tabs. */
export function tabIndexAt(rects: { left: number; right: number }[], x: number): number {
  if (rects.length === 0) return -1;
  const at = rects.findIndex((r) => x <= (r.left + r.right) / 2);
  return at >= 0 ? at : rects.length - 1;
}

/** How the tab strip shows names: every name, only the open tab's, or none. */
export type TabFit = "all" | "mid" | "icons";
/** Tab sizes around a name, in px: a 14 px icon, the 6 px gap and 16 px of padding; an icon-only tab; the space between tabs. */
export const TAB_LABEL_CHROME = 36;
export const TAB_ICON_WIDTH = 28;
export const TAB_GAP = 2;
/** Names come back only once this much spare room is free, so dragging the edge doesn't flicker. */
export const TAB_FIT_BUFFER = 20;
const FIT_RANK: Record<TabFit, number> = { icons: 0, mid: 1, all: 2 };

/** Which stage the tab strip uses and which tabs stay in it. A name is never cut off: it shows
 *  in full or its tab becomes an icon. The middle stage is sized for the longest name, so
 *  clicking another tab never changes the stage. When even icons don't fit, the tabs past the
 *  room go to the ⋯ menu; the active tab always stays. */
export function fitTabs(labelWidths: number[], activeIndex: number, avail: number, prev: TabFit): { fit: TabFit; shown: boolean[] } {
  const n = labelWidths.length;
  if (n === 0) return { fit: prev, shown: [] };
  const need: Record<TabFit, number> = {
    all: labelWidths.reduce((sum, w) => sum + w + TAB_LABEL_CHROME, 0) + TAB_GAP * (n - 1),
    mid: (TAB_ICON_WIDTH + TAB_GAP) * (n - 1) + Math.max(...labelWidths) + TAB_LABEL_CHROME,
    icons: 0,
  };
  let fit: TabFit = "icons";
  for (const stage of ["all", "mid"] as const) {
    const slack = FIT_RANK[stage] > FIT_RANK[prev] ? TAB_FIT_BUFFER : 0;
    if (avail >= need[stage] + slack) { fit = stage; break; }
  }
  const slots = fit === "icons" ? Math.max(1, Math.floor((avail + TAB_GAP) / (TAB_ICON_WIDTH + TAB_GAP))) : n;
  const shown = labelWidths.map((_, i) => i < slots);
  if (activeIndex >= slots && activeIndex < n) { shown[slots - 1] = false; shown[activeIndex] = true; }
  return { fit, shown };
}
