import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transform } from 'sucrase';
import { popoutOwnership } from './helpers/popout-ownership.mjs';
import { paneSection } from '../src/closing.ts';
import * as arrangement from '../src/paneArrangement.ts';

const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const declaration = app.match(/const openDashboard = \(id: string,[\s\S]*?\n  \};/)[0];
const code = transform(declaration, { transforms: ['typescript'], disableESTransforms: true }).code;
const pane = (id, kind = 'chat', extra = {}) => ({ id, kind, workspaceId: 'remote-project', title: id, ...extra });
const saved = order => ({ mode: 'grid', order, zoom: 1, focusShare: 0.58 });

function harness(listed, extra = {}) {
  const calls = [], arrangements = { ':threads': saved(['target']), ':code': saved(['terminal-target']) };
  const bindings = {
    listed, deleting: new Set(), poppedIds: new Set(),
    toast: message => calls.push(['toast', message]),
    focusPane: value => calls.push(['focus', value]),
    popOutPane: id => calls.push(['external', id]),
    paneSection, placeInOrder: arrangement.placeInOrder,
    dashboardArrangement: section => arrangements[`:${section}`],
    layoutKey: (_workspace, section) => `:${section}`,
    setArrangements: update => Object.assign(arrangements, update(arrangements)),
    revealPane: id => calls.push(['reveal', id]),
    setMaximized: value => calls.push(['maximized', value]),
    ...extra,
  };
  const open = new Function(...Object.keys(bindings), `${code}; return openDashboard;`)(...Object.values(bindings));
  return { open, calls, arrangements };
}

test('Dashboard owner opens the existing source in its own section, preserving its remote/task identity', () => {
  const task = pane('task', 'chat', { assistantTaskId: 'owned-task', hostId: 'remote-host', closed: true });
  const h = harness([task, pane('target')]);
  h.open(task.id, { kind: 'pane', paneId: 'target' });
  assert.deepEqual(h.calls[0], ['focus', task]);
  assert.deepEqual(h.arrangements[':threads'].order, ['task', 'target']);
  assert.deepEqual(h.arrangements[':code'].order, ['terminal-target']);
  assert.ok(h.calls.some(call => call[0] === 'reveal' && call[1] === 'task'));
  const terminal = pane('shell', 'terminal');
  const t = harness([terminal, pane('terminal-target', 'terminal')]);
  t.open('shell', { kind: 'new' });
  assert.deepEqual(t.arrangements[':code'].order, ['terminal-target', 'shell']);
  assert.deepEqual(t.arrangements[':threads'].order, ['target']);
});

test('Dashboard owner rejects stale, cross-section, deleting and popped-out destinations', () => {
  const h = harness([pane('source')]);
  for (const paneId of ['gone', 'terminal-target', '']) h.open('source', { kind: 'pane', paneId });
  assert.equal(h.calls.filter(([action]) => action === 'focus').length, 0);
  assert.deepEqual(h.arrangements[':threads'].order, ['target']);
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
  const remember = app.match(/^function withPoppedOut\([\s\S]*?^\}/m)[0];
  const code = transform(remember + '\n' + declaration, { transforms: ['typescript'], disableESTransforms: true }).code;
  const { popoutRefusal, restoreOrder } = await import('../src/popoutModel.ts');
  const source = pane('shell', 'terminal');
  const arrangements = { ':threads': saved(['chat']), ':code': saved(['shell', 'other']) };
  let records = []; const snapshots = [];
  const bindings = {
    window: { apexDeck: { popout: { open: async snapshot => { snapshots.push(snapshot); return { token: 'token' }; } } } },
    ...popoutOwnership(),
    poppedIds: new Set(), poppedOut: [], listed: [source], toast: message => assert.fail(message),
    hostOfPane: () => ({ workspace: { id: source.workspaceId, path: '/remote/project' }, hostId: 'remote-host' }),
    runs: {}, appearance: {}, appearanceSettings: undefined, chatFolder: (_pane, workspace) => workspace.path,
    layoutKey: (_workspace, section) => `:${section}`, paneSection,
    dashboardArrangement: section => arrangements[`:${section}`], popoutRefusal,
    restoreOrder, validArrangement: arrangement.validArrangement,
    setArrangements: update => Object.assign(arrangements, update(arrangements)),
    setPoppedOut: update => { records = update(records); },
    key: ':threads',
  };
  const open = new Function(...Object.keys(bindings), `${code}; return popOutPane;`)(...Object.values(bindings));
  open(source.id); await Promise.resolve();
  assert.deepEqual(arrangements[':threads'].order, ['chat']);
  assert.deepEqual(arrangements[':code'].order, ['other']);
  assert.equal(records[0].layoutKey, ':code');
  assert.equal(snapshots[0].hostId, 'remote-host');
  assert.equal(snapshots[0].id, source.id);
});

test('new panes enter the first slot of their own section and request a reveal', () => {
  const declaration = app.match(/const addPane = \(kind: Pane\["kind"\],[\s\S]*?\n  \};/)[0];
  const helper = app.match(/const placeNewPaneFirst = [\s\S]*?\n  \};/)[0];
  const code = transform(`${helper}\n${declaration}`, { transforms: ['typescript'], disableESTransforms: true }).code;
  const arrangements = { ':threads': saved(['a', 'b']), ':code': saved(['shell']) };
  const panes = [pane('a'), pane('b'), pane('shell', 'terminal')], calls = [];
  const bindings = {
    activeWorkspace: 'remote-project', section: 'threads', panes,
    newId: () => 'new', nextTitle: title => title, paneSection,
    layoutKey: (_workspace, section) => `:${section}`,
    validArrangement: arrangement.validArrangement,
    setArrangements: update => Object.assign(arrangements, update(arrangements)),
    setPanes: update => { panes.splice(0, panes.length, ...update(panes)); },
    setActiveWorkspace: () => {}, setFocusedPane: id => calls.push(['focus', id]),
    setSection: section => calls.push(['section', section]), setMaximized: () => {}, setPicking: () => {},
    revealPane: id => calls.push(['reveal', id]),
  };
  const add = new Function(...Object.keys(bindings), `${code}; return addPane;`)(...Object.values(bindings));
  assert.equal(add('terminal', 'Terminal'), 'new');
  assert.deepEqual(arrangements[':code'].order, ['new', 'shell']);
  assert.deepEqual(arrangements[':threads'].order, ['a', 'b']);
  assert.deepEqual(calls, [['focus', 'new'], ['section', 'code'], ['reveal', 'new']]);
});
