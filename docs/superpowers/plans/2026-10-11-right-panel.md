# Right Panel (tabbed side panel) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Threads-only "thread details" sidebar with one tabbed right panel that holds Dashboard, Tasks, Details, Browser and Files tabs, in every section, with tabs you can add, close, reorder and have remembered.

**Architecture:** A pure model file (`rightPanel.ts`) owns the tab list, its rules (fixed tabs, caps, reorder, save/load). A frame component (`RightPanel.tsx`) draws the tab strip and the active tab, and replaces the `<aside id="thread-details">` in `App.tsx`. The Details tab keeps today's portal design: the frame exposes a slot element and the target `ChatPane` portals `ThreadDetails` into it, exactly as now. Every other tab is a component fed by data `App.tsx` already has (`statusOf`, `attention`, `ApexAgentTasks`, `backend.browser`, `backend.listFolder`, `backend.roomDiff`).

**Tech Stack:** React 18 + TypeScript, Vite, Electron (`desktop/main.mjs`, `desktop/browser.mjs`), tests are `node --experimental-strip-types --test tests/*.test.mjs`, components tested by compiling with `sucrase` (see `tests/assistant-tasks-component.test.mjs`).

**Spec:** This plan is the spec. Source of the requirements: the group chat of 2026-10-11 (BridgeMind `AppBrowserSidebar` read by Jigga; live tours by Luna and Null). Clean-room: BridgeMind's names and layout are reference only. **Do not copy, import or paste any code from the attached BridgeMind build.**

## Global Constraints

- Build only in `~/Downloads/apex-deck`. No `apex-deck-*` folders, no extra worktrees.
- Other bots edit this folder at the same time. Work on branch `feat/right-panel`; `git add` only your own files/hunks; check `git status` before each commit.
- Never touch the real clipboard in tests.
- Tab kinds, in this order in the `+` menu: `dashboard`, `tasks`, `details`, `browser`, `files`.
- `dashboard` and `tasks` are fixed: always present, always first and second, cannot be closed or dragged.
- At most **8** `browser` tabs. Opening a 9th closes the browser tab used longest ago.
- Width keeps using `sidebarWidths.details` (min 260, max 640, default 320) and the existing `SidebarHandle`. Do not add a new width key.
- The existing title-bar toggle (`aria-controls="thread-details"`) stays the single open/close button, and now shows in every section, not only Threads. Keep the element id `thread-details` so existing focus code and tests still work.
- Saved state key: `apex-deck.right-panel.v1` in `localStorage`. Bad or missing data falls back to the default tabs, never throws.
- Narrow windows keep today's overlay behaviour (`detailsOverlay`) and Escape-to-close.
- Wording: plain everyday words. Group names exactly: "Waiting for you", "Working", "Done", "Idle".
- Before installing any new UI, render it offscreen and look at the PNG (see memory "Look before installing UI").

## Review Focus

1. **Saved tabs from an older/damaged save** (unknown kind, duplicate id, fixed tab missing, 12 browsers) → panel opens with valid tabs, fixed tabs first, browsers capped at 8. Test in Task 1.
2. **Details tab with no thread on screen** (Code section, or all threads closed) → the tab shows "Open a thread to see its details." instead of an empty box. Test in Task 2.
3. **Browser tab hidden behind another tab or under a menu** → the native page must step aside (no page drawn over the Dashboard). `visible` must be false when the tab is not active or the panel is closed. Test in Task 5.
4. **Closing the active tab** → the tab to its left becomes active; closing the last closable tab falls back to Dashboard. Test in Task 1.
5. **Files tab on a project whose machine is offline / folder missing** → shows "Can't read this folder." with Retry, not a crash or a spinner forever. Test in Task 6.

---

## File Structure

| File | Responsibility |
|---|---|
| Create `src/rightPanel.ts` | Tab types, default tabs, open/close/activate/move rules, parse/save. No React. |
| Create `src/RightPanel.tsx` | Frame: tab strip, `+` menu, close buttons, drag-reorder, renders the active tab body. |
| Create `src/right-panel.css` | Styles for the frame and tabs (imported from `RightPanel.tsx`). |
| Create `src/dashboardModel.ts` | Groups panes into Waiting for you / Working / Done / Idle; search + filter. |
| Create `src/RightDashboard.tsx` | Dashboard tab UI. |
| Create `src/RightBrowser.tsx` | Browser tab UI: address bar + `BrowserView`. |
| Create `src/RightFiles.tsx` | Files tab: folder tree via `listFolder`, changed-file markers via `roomDiff`. |
| Modify `src/App.tsx` (~lines 326-384, 1960, 2170-2184) | Own right-panel state; mount `RightPanel` in place of the bare `<aside id="thread-details">`. |
| Modify `src/types.ts:222` | Add `rightPanel?: RightPanelState` to `AppSession`. |
| Tests | `tests/right-panel-model.test.mjs`, `tests/right-panel-component.test.mjs`, `tests/dashboard-model.test.mjs`, `tests/right-browser.test.mjs`, `tests/right-files.test.mjs` |

Out of scope (separate plans later): Apps tabs (Scratchpad, timer, games) and a BridgeVerse-style 3D view. Null is inspecting how BridgeVerse is built; that becomes its own plan once there is a design.

---

### Task 1: Tab model

**Files:**
- Create: `src/rightPanel.ts`
- Test: `tests/right-panel-model.test.mjs`

**Interfaces:**
- Produces:
  ```ts
  export type TabKind = "dashboard" | "tasks" | "details" | "browser" | "files";
  export interface PanelTab { id: string; kind: TabKind; url?: string; usedAt: number }
  export interface RightPanelState { open: boolean; tabs: PanelTab[]; active: string }
  export const FIXED: TabKind[];            // ["dashboard","tasks"]
  export const BROWSER_CAP = 8;
  export function defaultPanel(): RightPanelState;
  export function openTab(s: RightPanelState, kind: TabKind, now: number, url?: string): RightPanelState;
  export function closeTab(s: RightPanelState, id: string): RightPanelState;
  export function activate(s: RightPanelState, id: string, now: number): RightPanelState;
  export function moveTab(s: RightPanelState, id: string, toIndex: number): RightPanelState;
  export function parsePanel(raw: string | null): RightPanelState;
  export function loadPanel(): RightPanelState;
  export function savePanel(s: RightPanelState): void;
  ```

- [ ] **Step 1: Write the failing test**

```js
// tests/right-panel-model.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultPanel, openTab, closeTab, activate, moveTab, parsePanel, BROWSER_CAP } from '../src/rightPanel.ts';

const kinds = (s) => s.tabs.map((t) => t.kind);

test('default panel is closed with Dashboard, Tasks and Details, Dashboard active', () => {
  const s = defaultPanel();
  assert.equal(s.open, false);
  assert.deepEqual(kinds(s), ['dashboard', 'tasks', 'details']);
  assert.equal(s.active, 'dashboard');
});

test('opening a single-instance tab that exists just activates it', () => {
  const s = openTab(defaultPanel(), 'details', 5);
  assert.deepEqual(kinds(s), ['dashboard', 'tasks', 'details']);
  assert.equal(s.tabs.find((t) => t.id === s.active).kind, 'details');
});

test('browsers are added, and the 9th closes the one used longest ago', () => {
  let s = defaultPanel();
  for (let i = 1; i <= BROWSER_CAP; i++) s = openTab(s, 'browser', i, `https://site${i}.test`);
  const first = s.tabs.find((t) => t.url === 'https://site1.test');
  s = activate(s, first.id, 100); // site1 is now the most recent; site2 is oldest
  s = openTab(s, 'browser', 101, 'https://site9.test');
  const urls = s.tabs.filter((t) => t.kind === 'browser').map((t) => t.url);
  assert.equal(urls.length, BROWSER_CAP);
  assert.ok(urls.includes('https://site1.test'));
  assert.ok(!urls.includes('https://site2.test'));
});

test('fixed tabs cannot be closed or moved', () => {
  const s = defaultPanel();
  assert.deepEqual(closeTab(s, 'dashboard'), s);
  assert.deepEqual(moveTab(s, 'tasks', 2), s);
});

test('nothing can be moved in front of the fixed tabs', () => {
  let s = openTab(defaultPanel(), 'files', 1);
  const files = s.tabs.find((t) => t.kind === 'files');
  s = moveTab(s, files.id, 0);
  assert.deepEqual(kinds(s), ['dashboard', 'tasks', 'files', 'details']);
});

test('closing the active tab activates its left neighbour', () => {
  let s = openTab(defaultPanel(), 'files', 1);
  const files = s.tabs.find((t) => t.kind === 'files');
  s = closeTab(s, files.id);
  assert.equal(s.tabs.find((t) => t.id === s.active).kind, 'details');
});

test('damaged saves fall back safely', () => {
  assert.deepEqual(kinds(parsePanel(null)), ['dashboard', 'tasks', 'details']);
  assert.deepEqual(kinds(parsePanel('nope')), ['dashboard', 'tasks', 'details']);
  const many = Array.from({ length: 12 }, (_, i) => ({ id: `b${i}`, kind: 'browser', url: 'https://x.test', usedAt: i }));
  const raw = JSON.stringify({ open: true, active: 'gone', tabs: [{ id: 'z', kind: 'weird', usedAt: 0 }, { id: 'b0', kind: 'browser', usedAt: 0 }, ...many] });
  const s = parsePanel(raw);
  assert.deepEqual(kinds(s).slice(0, 2), ['dashboard', 'tasks']);
  assert.equal(s.tabs.filter((t) => t.kind === 'browser').length, BROWSER_CAP);
  assert.equal(new Set(s.tabs.map((t) => t.id)).size, s.tabs.length);
  assert.equal(s.active, 'dashboard');
  assert.equal(s.open, true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test tests/right-panel-model.test.mjs`
Expected: FAIL, cannot find module `../src/rightPanel.ts`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/rightPanel.ts
// The right panel's tabs: which are open, which is in front, and the rules
// for adding, closing and reordering them. No interface code, so it can be
// tested on its own. Dashboard and Tasks are always there, first and second.

export type TabKind = "dashboard" | "tasks" | "details" | "browser" | "files";
export interface PanelTab { id: string; kind: TabKind; url?: string; usedAt: number }
export interface RightPanelState { open: boolean; tabs: PanelTab[]; active: string }

export const FIXED: TabKind[] = ["dashboard", "tasks"];
export const KINDS: TabKind[] = ["dashboard", "tasks", "details", "browser", "files"];
export const BROWSER_CAP = 8;
const STORAGE_KEY = "apex-deck.right-panel.v1";

const fixedTab = (kind: TabKind): PanelTab => ({ id: kind, kind, usedAt: 0 });

export function defaultPanel(): RightPanelState {
  return { open: false, tabs: [fixedTab("dashboard"), fixedTab("tasks"), fixedTab("details")], active: "dashboard" };
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

export function closeTab(s: RightPanelState, id: string): RightPanelState {
  const at = s.tabs.findIndex((t) => t.id === id);
  if (at < 0 || FIXED.includes(s.tabs[at].kind)) return s;
  const tabs = s.tabs.filter((t) => t.id !== id);
  const active = s.active === id ? (tabs[at - 1] ?? tabs[0]).id : s.active;
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
  const seen = new Set<string>();
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
  return { open: p.open === true, tabs, active };
}

export function loadPanel(): RightPanelState {
  try { return parsePanel(localStorage.getItem(STORAGE_KEY)); } catch { return defaultPanel(); }
}

export function savePanel(s: RightPanelState) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); } catch { /* Storage can be unavailable; tabs then last this session only. */ }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --test tests/right-panel-model.test.mjs`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git switch -c feat/right-panel
git add src/rightPanel.ts tests/right-panel-model.test.mjs
git commit -m "Add the right panel's tab model"
```

---

### Task 2: Panel frame + Details tab (no visible change for Threads)

**Files:**
- Create: `src/RightPanel.tsx`, `src/right-panel.css`
- Modify: `src/App.tsx` (state near line 326; toggle at line 1960; aside at lines 2170-2184)
- Modify: `src/types.ts:222` (add `rightPanel?: import("./rightPanel").RightPanelState;`)
- Test: `tests/right-panel-component.test.mjs`

**Interfaces:**
- Consumes: everything from Task 1.
- Produces:
  ```ts
  export interface TabBody { kind: TabKind; render: (tab: PanelTab, visible: boolean) => ReactNode }
  export function RightPanel(props: {
    state: RightPanelState;
    onChange: (next: RightPanelState) => void;
    bodies: Partial<Record<TabKind, (tab: PanelTab, visible: boolean) => ReactNode>>;
    onClose: () => void;
  }): JSX.Element;
  export const TAB_LABEL: Record<TabKind, string>; // Dashboard, Tasks, Details, Browser, Files
  ```
  `visible` is `state.open && tab.id === state.active`. Inactive tab bodies stay **mounted but hidden** (`hidden` attribute) so a browser page and file tree keep their state while you switch tabs.

- [ ] **Step 1: Write the failing test**

Follow the compile-with-sucrase pattern in `tests/assistant-tasks-component.test.mjs` (strip imports, pass `React`, model functions and a fake `DeckIcon` in). Test:

```js
// tests/right-panel-component.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transform } from 'sucrase';
import * as model from '../src/rightPanel.ts';

const source = await fs.readFile(new URL('../src/RightPanel.tsx', import.meta.url), 'utf8');
const code = transform(source.replace(/^import .*;\n/gm, '').replace(/export (function|const)/g, '$1'), { transforms: ['typescript', 'jsx'], jsxRuntime: 'classic' }).code;
const { RightPanel } = new Function('React', 'model', 'useRef', 'useState', `const {FIXED, KINDS, openTab, closeTab, activate, moveTab} = model; ${code}; return { RightPanel };`)(React, model, React.useRef, React.useState);

const render = (state, bodies = {}) => renderToStaticMarkup(React.createElement(RightPanel, { state, onChange() {}, onClose() {}, bodies }));

test('tab strip lists every tab; only non-fixed tabs have a close button', () => {
  const html = render({ ...model.defaultPanel(), open: true });
  assert.match(html, /role="tablist"/);
  for (const label of ['Dashboard', 'Tasks', 'Details']) assert.match(html, new RegExp(`>${label}<`));
  assert.equal((html.match(/aria-label="Close /g) ?? []).length, 1);
});

test('only the active tab body is shown, others stay mounted but hidden', () => {
  const s = { ...model.defaultPanel(), open: true, active: 'tasks' };
  const html = render(s, { dashboard: (_t, v) => `dash:${v}`, tasks: (_t, v) => `tasks:${v}` });
  assert.match(html, /dash:false/);
  assert.match(html, /tasks:true/);
});
```

Details-with-no-thread (Review Focus 2) is tested in Step 1b:

```js
test('details tab without a thread says so', () => {
  const s = { ...model.defaultPanel(), open: true, active: 'details' };
  const html = render(s, {});
  assert.match(html, /Open a thread to see its details\./);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test tests/right-panel-component.test.mjs`
Expected: FAIL, `RightPanel.tsx` not found.

- [ ] **Step 3: Write the frame**

```tsx
// src/RightPanel.tsx
import { useRef, useState, type ReactNode } from "react";
import { FIXED, KINDS, activate, closeTab, moveTab, openTab, type PanelTab, type RightPanelState, type TabKind } from "./rightPanel";
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
      <button className="icon small right-panel-close" aria-label="Close side panel" onClick={onClose}>×</button>
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
```

```css
/* src/right-panel.css */
.right-panel { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.right-panel-tabs { display: flex; align-items: center; gap: 2px; padding: 4px 6px; border-bottom: 1px solid var(--line, rgba(127,127,127,.2)); overflow-x: auto; }
.right-panel-tab { display: flex; align-items: center; flex: 0 1 auto; min-width: 0; border-radius: 6px; }
.right-panel-tab > button[role="tab"] { max-width: 120px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; background: none; border: 0; padding: 4px 8px; color: var(--muted, inherit); }
.right-panel-tab.active { background: var(--hover, rgba(127,127,127,.14)); }
.right-panel-tab.active > button[role="tab"] { color: inherit; }
.right-panel-close { margin-left: auto; }
.right-panel-add { display: flex; flex-direction: column; padding: 4px; border-bottom: 1px solid var(--line, rgba(127,127,127,.2)); }
.right-panel-add button { text-align: left; background: none; border: 0; padding: 6px 8px; border-radius: 6px; }
.right-panel-add button:hover { background: var(--hover, rgba(127,127,127,.14)); }
.right-panel-body { flex: 1; min-height: 0; overflow: auto; }
.right-panel-empty { padding: 16px; }
```

(Avoid the class names `.badge`, `.picker`, `.row`; they collide with existing styles.)

- [ ] **Step 4: Wire it into `App.tsx`**

1. Next to `detailsOpen` (line 326) add:
   ```ts
   const [panel, setPanel] = useState<RightPanelState>(loadPanel);
   useEffect(() => savePanel(panel), [panel]);
   const [detailsTabSlot, setDetailsTabSlot] = useState<HTMLElement | null>(null);
   ```
2. Make `detailsOpen` derive from the panel: replace `useState(false)` for `detailsOpen` with
   `const detailsOpen = panel.open;` and `const setDetailsOpen = (open: boolean) => setPanel((p) => ({ ...p, open }));`.
   `showDetails(target)` must also bring the Details tab to the front: `setPanel((p) => openTab({ ...p, open: true }, "details", Date.now()));`.
3. Point `detailsHostBase.slot` at `detailsTabSlot` and set `open: panel.open && panel.tabs.find(t => t.id === panel.active)?.kind === "details"`. `ChatPane.tsx:2724` stays unchanged: it still portals `ThreadDetails` into `details.slot`.
4. Toggle button (line 1960): drop the `section === "threads" &&` guard so it shows in every section. Change labels to "Show side panel" / "Hide side panel".
5. Replace the block at lines 2170-2184 so it renders when `panel.open` in any section (drop `section === "threads"` and `detailsTarget` from the condition), keeping the backdrop, `SidebarHandle`, width and overlay logic exactly as they are. Inside the `<aside id="thread-details" ...>` (remove `ref={setDetailsSlot}` from the aside; keep id, class, style, role) render:
   ```tsx
   <RightPanel state={panel} onChange={setPanel} onClose={closeDetails} bodies={{
     details: (_tab, visible) => detailsTarget
       ? <div ref={setDetailsTabSlot} tabIndex={-1} className="right-details-slot" hidden={!visible} />
       : <p className="muted right-panel-empty">Open a thread to see its details.</p>,
   }} />
   ```
   Keep `detailsSlot` state as an alias of `detailsTabSlot` (`const detailsSlot = detailsTabSlot;`) so the focus effect at lines 370-378 still works.
6. Session: in `currentSession` (line 464) add `rightPanel: panel`; keep writing `threadDetailsOpen: panel.open` for older builds. When loading a session that has `threadDetailsOpen` but no `rightPanel`, start with `{ ...defaultPanel(), open: threadDetailsOpen, active: threadDetailsOpen ? "details" : "dashboard" }`.

- [ ] **Step 5: Run all tests**

Run: `npm test`
Expected: all pass, including `thread-details.test.mjs`, `sidebars.test.mjs` and the two new files. If an existing test asserts the toggle only shows in Threads, update that assertion to the new behaviour and say so in the commit message.

- [ ] **Step 6: Look before installing**

Run `npm run desktop:dev` **with its own data folder** (`APEX_DECK_DATA_DIR=/tmp/apex-right-panel npm run desktop:dev`) so it does not attach to the installed Deck's daemon. Open the panel in Threads with a sample thread: Details must look exactly as before, under a tab row. Screenshot it and compare with today's details panel.

- [ ] **Step 7: Commit**

```bash
git add src/RightPanel.tsx src/right-panel.css tests/right-panel-component.test.mjs src/types.ts
git add -p src/App.tsx   # only the right-panel hunks
git commit -m "Turn the thread details sidebar into a tabbed right panel"
```

---

### Task 3: Dashboard tab

**Files:**
- Create: `src/dashboardModel.ts`, `src/RightDashboard.tsx`
- Modify: `src/App.tsx` (add `dashboard` body)
- Test: `tests/dashboard-model.test.mjs`

**Interfaces:**
- Consumes: `PaneStatus` from `src/types.ts` (`"working" | "idle" | "exited" | "needs_input" | "failed" | "done"`), `statusOf(pane)` and `focusPane(pane)` from `App.tsx`, `Signal.note` from `attention`.
- Produces:
  ```ts
  export type DashGroup = "waiting" | "working" | "done" | "idle";
  export const GROUP_LABEL: Record<DashGroup, string>; // "Waiting for you","Working","Done","Idle"
  export interface DashRow { id: string; title: string; project: string; kind: "chat" | "terminal"; status: PaneStatus; note: string }
  export function groupOf(status: PaneStatus): DashGroup;
  export function dashboard(rows: DashRow[], opts: { query: string; filter: DashGroup | "all"; by: "status" | "project" }): { key: string; label: string; rows: DashRow[] }[];
  ```

- [ ] **Step 1: Write the failing test**

```js
// tests/dashboard-model.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { groupOf, dashboard } from '../src/dashboardModel.ts';

const row = (id, status, project = 'Deck', title = id) => ({ id, title, project, kind: 'chat', status, note: '' });

test('statuses map to the four groups', () => {
  assert.equal(groupOf('needs_input'), 'waiting');
  assert.equal(groupOf('failed'), 'waiting');
  assert.equal(groupOf('working'), 'working');
  assert.equal(groupOf('done'), 'done');
  assert.equal(groupOf('idle'), 'idle');
  assert.equal(groupOf('exited'), 'idle');
});

test('by status: Waiting for you first, empty groups dropped', () => {
  const out = dashboard([row('a', 'idle'), row('b', 'needs_input'), row('c', 'working')], { query: '', filter: 'all', by: 'status' });
  assert.deepEqual(out.map((g) => g.label), ['Waiting for you', 'Working', 'Idle']);
});

test('filter and search narrow the rows', () => {
  const rows = [row('a', 'idle', 'Deck', 'Parser fix'), row('b', 'idle', 'Site', 'Landing page'), row('c', 'working')];
  assert.deepEqual(dashboard(rows, { query: '', filter: 'working', by: 'status' }).flatMap((g) => g.rows.map((r) => r.id)), ['c']);
  assert.deepEqual(dashboard(rows, { query: 'land', filter: 'all', by: 'status' }).flatMap((g) => g.rows.map((r) => r.id)), ['b']);
});

test('by project groups alphabetically, waiting rows first inside each', () => {
  const out = dashboard([row('a', 'idle', 'Site'), row('b', 'idle', 'Deck'), row('c', 'needs_input', 'Deck')], { query: '', filter: 'all', by: 'project' });
  assert.deepEqual(out.map((g) => g.label), ['Deck', 'Site']);
  assert.deepEqual(out[0].rows.map((r) => r.id), ['c', 'b']);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --experimental-strip-types --test tests/dashboard-model.test.mjs`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement the model**

```ts
// src/dashboardModel.ts
// The Dashboard tab's list: every thread and terminal, grouped by what it is
// doing. Waiting for you comes first because that is where the person is needed.
import type { PaneStatus } from "./types";

export type DashGroup = "waiting" | "working" | "done" | "idle";
const ORDER: DashGroup[] = ["waiting", "working", "done", "idle"];
export const GROUP_LABEL: Record<DashGroup, string> = { waiting: "Waiting for you", working: "Working", done: "Done", idle: "Idle" };
export interface DashRow { id: string; title: string; project: string; kind: "chat" | "terminal"; status: PaneStatus; note: string }

export function groupOf(status: PaneStatus): DashGroup {
  if (status === "needs_input" || status === "failed") return "waiting";
  if (status === "working") return "working";
  if (status === "done") return "done";
  return "idle";
}

export function dashboard(rows: DashRow[], opts: { query: string; filter: DashGroup | "all"; by: "status" | "project" }) {
  const q = opts.query.trim().toLowerCase();
  const kept = rows.filter((r) => (opts.filter === "all" || groupOf(r.status) === opts.filter)
    && (!q || r.title.toLowerCase().includes(q) || r.project.toLowerCase().includes(q)));
  const rank = (r: DashRow) => ORDER.indexOf(groupOf(r.status));
  if (opts.by === "status") {
    return ORDER.map((g) => ({ key: g, label: GROUP_LABEL[g], rows: kept.filter((r) => groupOf(r.status) === g) })).filter((g) => g.rows.length > 0);
  }
  const projects = [...new Set(kept.map((r) => r.project))].sort((a, b) => a.localeCompare(b));
  return projects.map((p) => ({ key: p, label: p, rows: kept.filter((r) => r.project === p).sort((a, b) => rank(a) - rank(b)) }));
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --experimental-strip-types --test tests/dashboard-model.test.mjs` → PASS (4 tests).

- [ ] **Step 5: Build the tab UI**

```tsx
// src/RightDashboard.tsx
import { useState } from "react";
import { dashboard, GROUP_LABEL, type DashGroup, type DashRow } from "./dashboardModel";

interface Props { rows: DashRow[]; onOpen: (id: string) => void }

/** Every thread and terminal by what it's doing. Clicking one brings it to the front. */
export function RightDashboard({ rows, onOpen }: Props) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<DashGroup | "all">("all");
  const [by, setBy] = useState<"status" | "project">("status");
  const groups = dashboard(rows, { query, filter, by });
  return <div className="right-dashboard">
    <div className="right-dashboard-tools">
      <input type="search" placeholder="Search" aria-label="Search threads and terminals" value={query} onChange={(e) => setQuery(e.target.value)} />
      <select aria-label="Group by" value={by} onChange={(e) => setBy(e.target.value as "status" | "project")}><option value="status">By status</option><option value="project">By project</option></select>
    </div>
    <div className="right-dashboard-filters" role="radiogroup" aria-label="Show">
      {(["all", "waiting", "working", "done", "idle"] as const).map((f) => <button key={f} role="radio" aria-checked={filter === f} onClick={() => setFilter(f)}>{f === "all" ? "All" : GROUP_LABEL[f]}</button>)}
    </div>
    {groups.length === 0 && <p className="muted right-panel-empty">{rows.length === 0 ? "No threads or terminals yet." : "Nothing matches."}</p>}
    {groups.map((g) => <section key={g.key}><h3 className="right-dashboard-group">{g.label} <span className="muted">{g.rows.length}</span></h3>
      <ul className="right-dashboard-list">{g.rows.map((r) => <li key={r.id}><button onClick={() => onOpen(r.id)}>
        <span className={`dash-dot dash-${r.status}`} aria-hidden="true" /><span className="dash-title">{r.title}</span><span className="muted dash-note">{r.note || r.project}</span>
      </button></li>)}</ul></section>)}
  </div>;
}
```

Add to `right-panel.css` (plain rows, one state dot, quiet labels; no bordered cards):

```css
.right-dashboard { padding: 8px; display: flex; flex-direction: column; gap: 8px; }
.right-dashboard-tools { display: flex; gap: 6px; }
.right-dashboard-tools input { flex: 1; min-width: 0; }
.right-dashboard-filters { display: flex; flex-wrap: wrap; gap: 4px; }
.right-dashboard-filters button { background: none; border: 0; padding: 2px 8px; border-radius: 999px; color: var(--muted, inherit); }
.right-dashboard-filters button[aria-checked="true"] { background: var(--hover, rgba(127,127,127,.14)); color: inherit; }
.right-dashboard-group { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; margin: 8px 4px 2px; font-weight: 600; }
.right-dashboard-list { list-style: none; margin: 0; padding: 0; }
.right-dashboard-list button { display: grid; grid-template-columns: 10px 1fr; column-gap: 8px; width: 100%; text-align: left; background: none; border: 0; padding: 6px 4px; border-radius: 6px; }
.right-dashboard-list button:hover { background: var(--hover, rgba(127,127,127,.14)); }
.dash-dot { width: 8px; height: 8px; border-radius: 50%; margin-top: 5px; grid-row: span 2; background: var(--muted, #888); }
.dash-working { background: var(--accent, #4a8cff); } .dash-needs_input, .dash-failed { background: var(--warn, #e0a030); } .dash-done { background: var(--ok, #3cb371); }
.dash-title, .dash-note { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dash-note { font-size: 12px; }
```

Wire it in `App.tsx` `bodies`:

```tsx
dashboard: () => <RightDashboard
  rows={listed.filter((p) => p.kind === "chat" || p.kind === "terminal").map((p) => ({
    id: p.id, title: p.title, project: workspaces.find((w) => w.id === p.workspaceId)?.name ?? "",
    kind: p.kind as "chat" | "terminal", status: statusOf(p), note: attention[p.id]?.note ?? "" }))}
  onOpen={(id) => { const p = listed.find((x) => x.id === id); if (p) focusPane(p); }} />,
```

Because `statusOf` reads `Date.now()`, the dashboard re-renders on the existing `tick` state, which is enough.

- [ ] **Step 6: Run all tests, look, commit**

Run: `npm test` → all pass. Render offscreen in the dev build (own data folder), check the PNG.

```bash
git add src/dashboardModel.ts src/RightDashboard.tsx tests/dashboard-model.test.mjs src/right-panel.css
git add -p src/App.tsx
git commit -m "Add the Dashboard tab to the right panel"
```

---

### Task 4: Tasks tab

**Files:**
- Modify: `src/App.tsx` (add `tasks` body)
- Test: extend `tests/right-panel-component.test.mjs`

**Interfaces:**
- Consumes: `ApexAgentTasks` as already rendered at `App.tsx:2160` (same props), and the `monitor` for the focused pane's workspace.

- [ ] **Step 1: Pull the `ApexAgentTasks` element at `App.tsx:2160` into a helper** `const projectTasks = (monitor: ProjectMonitor) => <ApexAgentTasks ... />` with the exact props it has today, and call the helper in its current spot. Run `npm test` → still all pass (pure move). Commit: `git commit -m "Pull the project Tasks element into a helper"`.

- [ ] **Step 2: Add the body**

```tsx
tasks: () => {
  const monitor = focusedMonitor; // the ProjectMonitor of the focused pane's workspace; already derived near the ApexAgent dock
  return monitor ? projectTasks(monitor) : <p className="muted right-panel-empty">Pick a project to see its tasks.</p>;
},
```

If no `focusedMonitor` value exists yet, derive it next to the other ApexAgent monitor code: the monitor whose `workspaceId` equals the focused pane's `workspaceId`, else `activeWorkspace`'s monitor, else `null`.

- [ ] **Step 3: Test the empty state** in `tests/right-panel-component.test.mjs`:

```js
test('tasks tab without a project says so', () => {
  const s = { ...model.defaultPanel(), open: true, active: 'tasks' };
  const html = render(s, { tasks: () => React.createElement('p', null, 'Pick a project to see its tasks.') });
  assert.match(html, /Pick a project to see its tasks\./);
});
```

- [ ] **Step 4: Run all tests, look, commit**

`npm test` → PASS. `git add -p src/App.tsx tests/right-panel-component.test.mjs && git commit -m "Add the Tasks tab to the right panel"`

---

### Task 5: Browser tab

**Files:**
- Create: `src/RightBrowser.tsx`
- Modify: `src/App.tsx` (add `browser` body), `src/right-panel.css`
- Test: `tests/right-browser.test.mjs`

**Interfaces:**
- Consumes: `BrowserView` (`src/BrowserView.tsx`; props `pane`, `url`, `browser`, `visible`, `onState`), `BrowserApi`/`BrowserState` from `src/backend.ts` (`navigate`, `back`, `forward`, `reload`), and `previewAddress` normalising from `src/PreviewPane.tsx` if it is exported (otherwise the local `normalise` below).
- The native page id is `side:${tab.id}` so it never collides with a Preview pane's id.
- Produces: `export function normalise(input: string): string`.

The Electron docked browser already exists (`desktop/browser.mjs`, `browser:*` IPC). This tab reuses it; no new Electron code. In the plain web build (`backend.browser` undefined) the tab shows "The browser tab needs the Deck app."

- [ ] **Step 1: Write the failing test**

```js
// tests/right-browser.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { transform } from 'sucrase';

const source = await fs.readFile(new URL('../src/RightBrowser.tsx', import.meta.url), 'utf8');
const code = transform(source.replace(/^import .*;\n/gm, '').replace(/export function/g, 'function'), { transforms: ['typescript', 'jsx'], jsxRuntime: 'classic' }).code;
const { normalise } = new Function('React', `${code}; return { normalise };`)({});

test('addresses get a scheme; words become a search', () => {
  assert.equal(normalise('localhost:5173'), 'http://localhost:5173');
  assert.equal(normalise('example.com'), 'https://example.com');
  assert.equal(normalise('https://a.test/x'), 'https://a.test/x');
  assert.equal(normalise('react hooks'), 'https://duckduckgo.com/?q=react%20hooks');
  assert.equal(normalise('  '), '');
});
```

Review Focus 3 (page must step aside when not visible) is covered by passing `visible` straight through. Add this check to the same file:

```js
test('the native page is only visible when the tab is', () => {
  assert.match(source, /<BrowserView[^>]*visible=\{visible && !!url\}/);
});
```

- [ ] **Step 2: Run to verify it fails**

`node --experimental-strip-types --test tests/right-browser.test.mjs` → FAIL, file missing.

- [ ] **Step 3: Implement**

```tsx
// src/RightBrowser.tsx
import { useState } from "react";
import type { BrowserApi, BrowserState } from "./backend";
import { BrowserView } from "./BrowserView";

interface Props { id: string; url: string; browser: BrowserApi | undefined; visible: boolean; onUrl: (url: string) => void }

/** Turn what was typed into an address: a scheme for hosts, a search for words. */
export function normalise(input: string): string {
  const text = input.trim();
  if (!text) return "";
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return text;
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(text)) return `http://${text}`;
  if (!/\s/.test(text) && /\.[a-z]{2,}(:\d+)?(\/|$)/i.test(text)) return `https://${text}`;
  return `https://duckduckgo.com/?q=${encodeURIComponent(text)}`;
}

/** A browser tab in the right panel. The page is the app's docked browser, keyed "side:<tab id>". */
export function RightBrowser({ id, url, browser, visible, onUrl }: Props) {
  const pane = `side:${id}`;
  const [typed, setTyped] = useState(url);
  const [page, setPage] = useState<BrowserState | null>(null);
  if (!browser) return <p className="muted right-panel-empty">The browser tab needs the Deck app.</p>;
  const go = (next: string) => { const address = normalise(next); if (!address) return; setTyped(address); onUrl(address); if (address === url) void browser.navigate(pane, address); };
  return <div className="right-browser">
    <form className="right-browser-bar" onSubmit={(e) => { e.preventDefault(); go(typed); }}>
      <button type="button" className="icon small" disabled={!page?.canGoBack} onClick={() => void browser.back(pane)} aria-label="Back">‹</button>
      <button type="button" className="icon small" disabled={!page?.canGoForward} onClick={() => void browser.forward(pane)} aria-label="Forward">›</button>
      <button type="button" className="icon small" disabled={!url} onClick={() => void browser.reload(pane)} aria-label="Reload">↻</button>
      <input aria-label="Address" placeholder="Search or type an address" value={typed} onChange={(e) => setTyped(e.target.value)} />
    </form>
    {!url && <div className="right-browser-start">
      <button onClick={() => go("localhost:3000")}>localhost:3000</button>
      <button onClick={() => go("localhost:5173")}>localhost:5173</button>
    </div>}
    {url && <BrowserView pane={pane} url={url} browser={browser} visible={visible && !!url} onState={(state) => { setPage(state); if (state.url && state.url !== typed) setTyped(state.url); }} />}
  </div>;
}
```

CSS (append to `right-panel.css`):

```css
.right-browser { display: flex; flex-direction: column; height: 100%; }
.right-browser-bar { display: flex; gap: 4px; padding: 6px; align-items: center; }
.right-browser-bar input { flex: 1; min-width: 0; }
.right-browser-start { display: flex; flex-direction: column; gap: 4px; padding: 8px; }
.right-browser .browser-place { flex: 1; min-height: 0; }
```

Wire in `App.tsx` `bodies`:

```tsx
browser: (tab, visible) => <RightBrowser id={tab.id} url={tab.url ?? ""} browser={backend.browser} visible={visible}
  onUrl={(url) => setPanel((p) => ({ ...p, tabs: p.tabs.map((t) => t.id === tab.id ? { ...t, url } : t) }))} />,
```

When a browser tab is closed, `BrowserView`'s cleanup already calls `browser.close(pane)`; confirm in the dev build that closing the tab removes the page.

- [ ] **Step 4: Run tests** → `npm test` PASS.

- [ ] **Step 5: Look in the real app** (dev build, own data folder): open a Browser tab, load `localhost:5173` or `example.com`, then (a) switch to Dashboard: page must disappear; (b) open the `+` menu over it: page must show its snapshot, not draw over the menu; (c) drag the panel edge: page must follow; (d) close the tab: page must go. Screenshot (a) and (b).

- [ ] **Step 6: Commit**

```bash
git add src/RightBrowser.tsx tests/right-browser.test.mjs src/right-panel.css
git add -p src/App.tsx
git commit -m "Add Browser tabs to the right panel"
```

Not in this task (later plan): phone/tablet preview sizes, rotate, Select element. They need main-process work in `desktop/browser.mjs`.

---

### Task 6: Files tab

**Files:**
- Create: `src/RightFiles.tsx`
- Modify: `src/App.tsx` (add `files` body), `src/right-panel.css`
- Test: `tests/right-files.test.mjs`

**Interfaces:**
- Consumes: `backend.listFolder(path): Promise<FolderListing>` (`{ path, parent, folders, files, truncated }`), `backend.roomDiff(roomId): Promise<ThreadDiff>`, and `openTarget(path, reveal)` as `ChatPane` uses it.
- Produces: `export function changedSet(diff: ThreadDiff | null, root: string): Set<string>` (absolute paths of changed files; `DiffFile.path` is relative to the thread's folder, which is the workspace `root`).

The folder is the focused pane's workspace folder (`workspace.path`). Changed markers come from the focused thread's `roomDiff`, if a thread is focused.

- [ ] **Step 1: Write the failing test**

```js
// tests/right-files.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transform } from 'sucrase';

const source = await fs.readFile(new URL('../src/RightFiles.tsx', import.meta.url), 'utf8');
const code = transform(source.replace(/^import .*;\n/gm, '').replace(/export function/g, 'function'), { transforms: ['typescript', 'jsx'], jsxRuntime: 'classic' }).code;
const { changedSet, FilesError } = new Function('React', 'useEffect', 'useState', `${code}; return { changedSet, FilesError };`)(React, React.useEffect, React.useState);

test('changed files are collected from a thread diff', () => {
  const set = changedSet({ note: null, files: [{ path: 'src/a.ts', added: 1, removed: 0, patch: '', by: [] }, { path: '/w/b.ts', added: 1, removed: 0, patch: '', by: [] }] }, '/w');
  assert.ok(set.has('/w/src/a.ts'));
  assert.ok(set.has('/w/b.ts'));
  assert.equal(changedSet(null, '/w').size, 0);
});

test('an unreadable folder shows a retry, not a spinner', () => {
  const html = renderToStaticMarkup(React.createElement(FilesError, { onRetry() {} }));
  assert.match(html, /Can&#x27;t read this folder\./);
  assert.match(html, />Retry</);
});
```

- [ ] **Step 2: Run to verify it fails** → FAIL, file missing.

- [ ] **Step 3: Implement**

```tsx
// src/RightFiles.tsx
import { useEffect, useState } from "react";
import type { FolderListing, ThreadDiff } from "./types";

interface Props {
  root: string | null;
  list: (path: string) => Promise<FolderListing>;
  diff: ThreadDiff | null;
  onOpen: (path: string) => void;
}

const join = (dir: string, name: string) => `${dir.replace(/\/$/, "")}/${name}`;

/** Absolute paths of the files a thread changed. */
export function changedSet(diff: ThreadDiff | null, root: string): Set<string> {
  if (!diff) return new Set();
  return new Set(diff.files.map((f) => (f.path.startsWith("/") ? f.path : join(root, f.path))));
}

export function FilesError({ onRetry }: { onRetry: () => void }) {
  return <div className="right-panel-empty"><p className="muted">Can't read this folder.</p><button onClick={onRetry}>Retry</button></div>;
}

/** The project's folders and files, with the focused thread's changes marked. Folders open in place. */
export function RightFiles({ root, list, diff, onOpen }: Props) {
  if (!root) return <p className="muted right-panel-empty">This project has no folder.</p>;
  const changed = changedSet(diff, root);
  return <ul className="right-files" role="tree" aria-label="Files"><Folder path={root} list={list} changed={changed} onOpen={onOpen} /></ul>;
}

function Folder({ path, list, changed, onOpen }: { path: string; list: Props["list"]; changed: Set<string>; onOpen: (p: string) => void }) {
  const [listing, setListing] = useState<FolderListing | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const load = () => { setFailed(false); list(path).then(setListing, () => setFailed(true)); };
  useEffect(load, [path]);
  if (failed) return <li><FilesError onRetry={load} /></li>;
  if (!listing) return <li className="muted right-files-loading">Loading…</li>;
  return <>
    {listing.folders.map((name) => { const full = join(path, name); return <li key={full} role="treeitem" aria-expanded={!!open[full]}>
      <button className="right-files-item" onClick={() => setOpen((o) => ({ ...o, [full]: !o[full] }))}>{open[full] ? "▾" : "▸"} {name}</button>
      {open[full] && <ul role="group"><Folder path={full} list={list} changed={changed} onOpen={onOpen} /></ul>}
    </li>; })}
    {listing.files.map((name) => { const full = join(path, name); return <li key={full} role="treeitem">
      <button className={`right-files-item${changed.has(full) ? " changed" : ""}`} onClick={() => onOpen(full)} title={changed.has(full) ? "Changed in this thread" : undefined}>{name}{changed.has(full) && <span className="right-files-mark" aria-label="changed">M</span>}</button>
    </li>; })}
    {listing.truncated && <li className="muted">More files not shown.</li>}
  </>;
}
```

CSS:

```css
.right-files, .right-files ul { list-style: none; margin: 0; padding: 0 0 0 12px; }
.right-files { padding: 6px; }
.right-files-item { display: flex; gap: 6px; width: 100%; text-align: left; background: none; border: 0; padding: 3px 4px; border-radius: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.right-files-item:hover { background: var(--hover, rgba(127,127,127,.14)); }
.right-files-item.changed { color: var(--warn, #e0a030); }
.right-files-mark { margin-left: auto; font-size: 11px; font-weight: 600; }
```

Wire in `App.tsx` `bodies`. The diff loads when the Files tab becomes visible and the focused pane is a chat:

```tsx
files: (_tab, visible) => <FilesTab visible={visible} />,
```

where `FilesTab` is a small inline component in `App.tsx` (or `RightFiles.tsx`) that picks `root` = the focused pane's workspace `path`, calls `hostBackend(workspaceHost(workspace)).listFolder` for `list` (so remote projects read from their own machine), loads `roomDiff(focusedPane)` when `visible` and the focused pane is a chat, and calls `backend.openTarget(path, workspace.path, false)` for `onOpen`.

- [ ] **Step 4: Run all tests** → `npm test` PASS.

- [ ] **Step 5: Look** in the dev build: open Files on a project with a thread that has changed a file; the file shows the M mark. Point a workspace at a missing folder: you see "Can't read this folder." and Retry.

- [ ] **Step 6: Commit**

```bash
git add src/RightFiles.tsx tests/right-files.test.mjs src/right-panel.css
git add -p src/App.tsx
git commit -m "Add the Files tab to the right panel"
```

---

## After all tasks

- Run `npm test` and `npm run build`. Both must pass.
- Hand the branch to Null for review before anything is merged or installed.
- Human OK before merging to `main`, pushing or installing.

## Later plans (not this one)

1. Browser extras: phone/tablet sizes, rotate, Select element (main-process work in `desktop/browser.mjs`).
2. A single-file tab (open a file from Files into its own tab, up to 8, oldest closed first).
3. Apps tabs (Scratchpad and similar).
4. A BridgeVerse-style spatial view of projects and bots, after Null's write-up on how BridgeVerse is built.
