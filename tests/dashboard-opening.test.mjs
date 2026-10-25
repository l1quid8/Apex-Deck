import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transform } from 'sucrase';
import { paneSection } from '../src/closing.ts';
import { placeDashboardPane } from '../src/dashboardNavigation.ts';
import { leafIds } from '../src/layout.ts';

const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const declaration = app.match(/const openDashboard = \(id: string,[\s\S]*?\n  \};/)[0];
const code = transform(declaration, { transforms: ['typescript'], disableESTransforms: true }).code;
const pane = (id, kind = 'chat', extra = {}) => ({ id, kind, workspaceId: 'remote-project', title: id, ...extra });
const leaf = id => ({ kind: 'leaf', id });

function harness(listed, extra = {}) {
  const calls = [], layouts = { ':threads': leaf('target'), ':code': leaf('terminal-target') };
  const bindings = {
    listed, deleting: new Set(), poppedIds: new Set(),
    toast: message => calls.push(['toast', message]),
    focusPane: value => calls.push(['focus', value]),
    popOutPane: id => calls.push(['external', id]),
    paneSection, placeDashboardPane, leafIds,
    dashboardTree: section => layouts[`:${section}`],
    layoutKey: (_workspace, section) => `:${section}`,
    setLayouts: update => Object.assign(layouts, update(layouts)),
    setMaximized: value => calls.push(['maximized', value]),
    ...extra,
  };
  const open = new Function(...Object.keys(bindings), `${code}; return openDashboard;`)(...Object.values(bindings));
  return { open, calls, layouts };
}

test('Dashboard owner opens the existing source in its own section, preserving its remote/task identity', () => {
  const task = pane('task', 'chat', { assistantTaskId: 'owned-task', hostId: 'remote-host', closed: true });
  const h = harness([task, pane('target')]);
  h.open(task.id, { kind: 'pane', paneId: 'target' });
  assert.deepEqual(h.calls[0], ['focus', task]);
  assert.deepEqual(leafIds(h.layouts[':threads']).sort(), ['target', 'task']);
  assert.deepEqual(h.layouts[':code'], leaf('terminal-target'));
  const terminal = pane('shell', 'terminal');
  const t = harness([terminal, pane('terminal-target', 'terminal')]);
  t.open('shell', { kind: 'new' });
  assert.deepEqual(leafIds(t.layouts[':code']).sort(), ['shell', 'terminal-target']);
  assert.deepEqual(t.layouts[':threads'], leaf('target'));
});

test('Dashboard owner rejects stale, cross-section, deleting and popped-out destinations', () => {
  const h = harness([pane('source')]);
  for (const paneId of ['gone', 'terminal-target', '']) h.open('source', { kind: 'pane', paneId });
  assert.equal(h.calls.filter(([action]) => action === 'focus').length, 0);
  assert.deepEqual(h.layouts[':threads'], leaf('target'));
  const popped = harness([pane('source')], { poppedIds: new Set(['source']) });
  popped.open('source', { kind: 'external' });
  assert.equal(popped.calls[0][0], 'toast');
  const deleting = harness([pane('source')], { deleting: new Set(['source']) });
  deleting.open('source', { kind: 'new' });
  deleting.open('missing', { kind: 'new' });
  assert.deepEqual(deleting.calls, []);
});

test('Dashboard external action uses the existing popout route and normal clicks keep their focus behavior', () => {
  const source = pane('source'); const h = harness([source]);
  h.open('source', { kind: 'external' });
  h.open('source');
  assert.deepEqual(h.calls, [['external', 'source'], ['focus', source]]);
});

test('external panes use their source section layout even if another screen is active', async () => {
  const declaration = app.match(/const popOutPane = \(paneId: string,[\s\S]*?\n  \};/)[0];
  const code = transform(declaration, { transforms: ['typescript'], disableESTransforms: true }).code;
  const { takePaneOut, popoutRefusal } = await import('../src/popoutModel.ts');
  const source = pane('shell', 'terminal');
  const layouts = { ':threads': leaf('chat'), ':code': { kind: 'split', dir: 'row', children: [leaf('shell'), leaf('other')], sizes: [0.3, 0.7] } };
  let records = []; const snapshots = [];
  const bindings = {
    window: { apexDeck: { popout: { open: async snapshot => { snapshots.push(snapshot); return { token: 'token' }; } } } },
    poppedIds: new Set(), listed: [source], toast: message => assert.fail(message),
    hostOfPane: () => ({ workspace: { id: source.workspaceId, path: '/remote/project' }, hostId: 'remote-host' }),
    runs: {}, appearance: {}, chatFolder: (_pane, workspace) => workspace.path,
    layoutKey: (_workspace, section) => `:${section}`, paneSection,
    dashboardTree: section => layouts[`:${section}`], takePaneOut, popoutRefusal,
    setLayouts: update => Object.assign(layouts, update(layouts)),
    setPoppedOut: update => { records = update(records); },
    key: ':threads',
  };
  const open = new Function(...Object.keys(bindings), `${code}; return popOutPane;`)(...Object.values(bindings));
  open(source.id); await Promise.resolve();
  assert.deepEqual(layouts[':threads'], leaf('chat'));
  assert.deepEqual(layouts[':code'], leaf('other'));
  assert.equal(records[0].layoutKey, ':code');
  assert.equal(snapshots[0].hostId, 'remote-host');
  assert.equal(snapshots[0].id, source.id);
});
