// tests/right-panel-model.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultPanel, openTab, closeTab, activate, moveTab, parsePanel, setFull, closePanel, BROWSER_CAP, fitTabs } from '../src/rightPanelModel.ts';

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

test('worktrees is a single-instance tab and survives saved-panel parsing', () => {
  let s = openTab(defaultPanel(), 'worktrees', 1);
  s = openTab(s, 'worktrees', 2);
  assert.equal(s.tabs.filter((tab) => tab.kind === 'worktrees').length, 1);
  const restored = parsePanel(JSON.stringify(s));
  assert.deepEqual(kinds(restored), ['dashboard', 'tasks', 'details', 'worktrees']);
});

test('a saved Phone tab is kept', () => {
  assert.deepEqual(parsePanel(JSON.stringify({ open: true, tabs: [{ id: 'phone', kind: 'phone', usedAt: 1 }], active: 'phone' })).active, 'phone');
  let s = openTab(defaultPanel(), 'phone', 1);
  s = openTab(s, 'phone', 2);
  assert.equal(s.tabs.filter((tab) => tab.kind === 'phone').length, 1);
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

test('a saved panel with no full field reads as docked', () => {
  const s = parsePanel(JSON.stringify({ open: true, tabs: [], active: 'dashboard' }));
  assert.equal(s.full, false);
  assert.equal(s.open, true);
});

test('only a real true reads as full screen', () => {
  assert.equal(parsePanel(JSON.stringify({ open: true, full: 'yes', tabs: [], active: 'dashboard' })).full, false);
  assert.equal(parsePanel(JSON.stringify({ open: true, full: 1, tabs: [], active: 'dashboard' })).full, false);
  assert.equal(parsePanel(JSON.stringify({ open: true, full: true, tabs: [], active: 'dashboard' })).full, true);
});

test('the default panel is docked', () => {
  assert.equal(defaultPanel().full, false);
});

test('setFull(true) also opens a closed panel', () => {
  const s = setFull(defaultPanel(), true);
  assert.equal(s.full, true);
  assert.equal(s.open, true);
});

test('setFull(false) leaves the panel open and docked', () => {
  const s = setFull({ ...defaultPanel(), open: true, full: true }, false);
  assert.equal(s.full, false);
  assert.equal(s.open, true);
});

test('closing the panel clears full screen, so a reopen is docked', () => {
  const full = setFull(defaultPanel(), true);
  const closed = closePanel(full);
  assert.equal(closed.open, false);
  assert.equal(closed.full, false);
  assert.equal(openTab(closed, 'files', 1).full, false);
});


test('Artifacts is a singleton, survives saves, and closes like Details', () => {
  const state = openTab(openTab(defaultPanel(), 'artifacts', 1), 'artifacts', 2);
  assert.equal(state.tabs.filter(t => t.kind === 'artifacts').length, 1);
  assert.deepEqual(parsePanel(JSON.stringify(state)), state);
  assert.equal(closeTab(state, state.active).tabs.some(t => t.kind === 'artifacts'), false);
});

test('saved panels from before Artifacts retain their tabs and selection', () => {
  const old = openTab(defaultPanel(), 'files', 1);
  assert.deepEqual(parsePanel(JSON.stringify(old)), old);
  assert.equal(openTab(parsePanel(JSON.stringify(old)), 'artifacts', 2).active, 'artifacts');
});

test('fitTabs shows every name when they fit, and never cuts one off', () => {
  // Five 60 px names need 5 * (60 + 36) + 4 * 2 = 488 px.
  const ws = [60, 60, 60, 60, 60];
  assert.equal(fitTabs(ws, 0, 488, 'all').fit, 'all');
  assert.equal(fitTabs(ws, 0, 487, 'all').fit, 'mid');
  // Middle stage: four icons plus the longest name, 4 * 30 + 60 + 36 = 216.
  assert.equal(fitTabs(ws, 0, 216, 'mid').fit, 'mid');
  assert.equal(fitTabs(ws, 0, 215, 'mid').fit, 'icons');
});

test('fitTabs sizes the middle stage for the longest name, so switching tabs never changes it', () => {
  const ws = [70, 35, 75, 60, 55];
  for (let active = 0; active < ws.length; active++) assert.equal(fitTabs(ws, active, 240, 'mid').fit, 'mid');
});

test('fitTabs brings names back only with 20 px to spare', () => {
  const ws = [60, 60, 60, 60, 60];
  assert.equal(fitTabs(ws, 0, 500, 'mid').fit, 'mid');
  assert.equal(fitTabs(ws, 0, 508, 'mid').fit, 'all');
  assert.equal(fitTabs(ws, 0, 230, 'icons').fit, 'icons');
  assert.equal(fitTabs(ws, 0, 236, 'icons').fit, 'mid');
});

test('fitTabs moves icons that still do not fit into the menu, never the open tab', () => {
  const ws = [70, 35, 75, 60, 55, 40, 45];
  // 150 px holds five 30 px icon slots.
  const { fit, shown } = fitTabs(ws, 6, 150, 'icons');
  assert.equal(fit, 'icons');
  assert.deepEqual(shown, [true, true, true, true, false, false, true]);
  assert.deepEqual(fitTabs(ws, 1, 150, 'icons').shown, [true, true, true, true, true, false, false]);
  assert.deepEqual(fitTabs(ws, 0, 1000, 'all').shown, ws.map(() => true));
});

test('the assistant browser is one tab of its own, not the URL browser', () => {
  const first = openTab(defaultPanel(), 'assistantbrowser', 100);
  assert.deepEqual(kinds(first), ['dashboard', 'tasks', 'details', 'assistantbrowser'], 'it sits beside the fixed tabs');
  assert.equal(first.active, 'assistantbrowser');
  const twice = openTab(first, 'assistantbrowser', 200);
  assert.equal(kinds(twice).filter((kind) => kind === 'assistantbrowser').length, 1, 'opening it again reuses the one tab');
  assert.equal(twice.tabs.length, first.tabs.length);
  const url = openTab(first, 'browser', 300, 'https://example.com');
  assert.deepEqual(kinds(url).filter((kind) => kind === 'browser' || kind === 'assistantbrowser'), ['assistantbrowser', 'browser'], 'it never replaces or merges with the URL browser');
  const closed = closeTab(first, first.active);
  assert.equal(kinds(closed).includes('assistantbrowser'), false, 'its x closes only that tab');
  assert.deepEqual(kinds(closed), ['dashboard', 'tasks', 'details'], 'the fixed tabs stay');
  assert.equal(parsePanel(JSON.stringify(first)).tabs.some((tab) => tab.kind === 'assistantbrowser'), true, 'a saved panel keeps it');
});

test('terminal is a single-instance right sidebar tool that survives saves', () => {
  const first = openTab(defaultPanel(), 'terminal', 100);
  assert.deepEqual(kinds(first), ['dashboard', 'tasks', 'details', 'terminal']);
  assert.equal(first.active, 'terminal');
  const twice = openTab(first, 'terminal', 200);
  assert.equal(kinds(twice).filter((k) => k === 'terminal').length, 1, 'opening it again reuses the one tab');
  assert.equal(twice.tabs.length, first.tabs.length);
  const closed = closeTab(first, first.active);
  assert.equal(kinds(closed).includes('terminal'), false, 'its x closes only that tab');
  assert.equal(parsePanel(JSON.stringify(first)).tabs.some((t) => t.kind === 'terminal'), true, 'a saved panel keeps it');
  const restored = parsePanel(JSON.stringify(openTab(openTab(defaultPanel(), 'files', 1), 'terminal', 2)));
  assert.ok(restored.tabs.some((t) => t.kind === 'terminal'), 'terminal survives parsing alongside other tools');
});
