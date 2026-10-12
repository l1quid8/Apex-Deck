// tests/right-panel-model.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultPanel, openTab, closeTab, activate, moveTab, parsePanel, BROWSER_CAP } from '../src/rightPanelModel.ts';

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
