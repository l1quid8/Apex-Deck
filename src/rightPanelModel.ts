// src/rightPanel.ts
// The right panel's tabs: which are open, which is in front, and the rules
// for adding, closing and reordering them. No interface code, so it can be
// tested on its own. Dashboard and Tasks are always there, first and second.

export type TabKind = "dashboard" | "tasks" | "details" | "browser" | "files" | "worktrees";
export interface PanelTab { id: string; kind: TabKind; url?: string; usedAt: number }
/** `full` fills the work area; it only means anything while `open`. */
export interface RightPanelState { open: boolean; full: boolean; tabs: PanelTab[]; active: string }

export const FIXED: TabKind[] = ["dashboard", "tasks"];
export const KINDS: TabKind[] = ["dashboard", "tasks", "details", "browser", "files", "worktrees"];
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
export function parsePanel(raw: string | null): RightPanelState {
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
  const browsers = kept.filter((t) => t.kind === "browser").sort((a, b) => b.usedAt - a.usedAt).slice(0, BROWSER_CAP).map((t) => t.id);
  const tabs = [fixedTab("dashboard"), fixedTab("tasks"), ...kept.filter((t) => t.kind !== "browser" || browsers.includes(t.id))];
  const active = typeof p.active === "string" && tabs.some((t) => t.id === p.active) ? p.active : "dashboard";
  return { open: p.open === true, full: p.full === true, tabs, active };
}

export function loadPanel(): RightPanelState {
  try { return parsePanel(localStorage.getItem(STORAGE_KEY)); } catch { return defaultPanel(); }
}

export function savePanel(s: RightPanelState) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); } catch { /* Storage can be unavailable; tabs then last this session only. */ }
}
