import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { transform } from 'sucrase';

// Exercise the hook across React-style commit/effect turns, with only React and
// the native IPC boundary substituted. Every open must see the preceding commit.
function harness() {
  const source = readFileSync(new URL('../src/useRestorePopouts.ts', import.meta.url), 'utf8');
  let cells = [], cursor = 0, effects = [], hook;
  const context = {
    Promise,
    useRef(initial) { const i = cursor++; cells[i] ??= { current: initial }; return cells[i]; },
    useState(initial) { const i = cursor++; if (!(i in cells)) cells[i] = initial; return [cells[i], next => { cells[i] = typeof next === 'function' ? next(cells[i]) : next; }]; },
    useEffect(effect) { effects.push(effect); },
  };
  const code = transform(source.replace(/^import .*;\n/gm, '').replace('export function', 'function'), { transforms: ['typescript'] }).code;
  hook = runInNewContext(`${code}\nuseRestorePopouts;`, context);
  return async (...args) => {
    cursor = 0; effects = [];
    hook(...args);
    for (const effect of effects) effect();
    // Flush the IPC completion and state update; a new render is explicit.
    for (let i = 0; i < 8; i++) await Promise.resolve();
  };
}

test('restore waits for startup and serializes windows using each newly committed layout', async () => {
  const render = harness();
  const calls = [], errors = [];
  let ready = false, layout = ['a', 'b'];
  const saved = [{ kind: 'pane', id: 'a' }, { kind: 'pane', id: 'b' }, { kind: 'tab', id: 'files' }];
  const step = () => render(ready, saved, { panes: layout, tabs: ['files'] }, async id => {
    calls.push({ id, layout: [...layout] });
    layout = layout.filter(p => p !== id);
  }, async id => { calls.push({ tab: id }); }, error => errors.push(error));
  await step();
  assert.deepEqual(calls, []);
  ready = true;
  for (let i = 0; i < 10; i++) await step();
  assert.deepEqual(calls, [
    { id: 'a', layout: ['a', 'b'] },
    { id: 'b', layout: ['b'] },
    { tab: 'files' },
  ]);
  assert.deepEqual(errors, []);
});

test('a failed window does not block the remaining layout or retry forever', async () => {
  const render = harness();
  const opened = [], errors = [];
  const saved = [{ kind: 'pane', id: 'bad' }, { kind: 'tab', id: 'files' }];
  for (let i = 0; i < 10; i++) await render(true, saved, { panes: ['bad'], tabs: ['files'] }, async () => {
    throw new Error('window failed');
  }, async id => { opened.push(id); }, error => errors.push(error.message));
  assert.deepEqual(opened, ['files']);
  assert.deepEqual(errors, ['window failed']);
});

test('items removed during restoration are not reopened', async () => {
  const render = harness();
  const opened = [];
  const saved = [{ kind: 'pane', id: 'gone' }];
  await render(true, saved, { panes: ['gone'], tabs: [] }, id => opened.push(id), () => {}, () => {});
  for (let i = 0; i < 5; i++) await render(true, saved, { panes: [], tabs: [] }, id => opened.push(id), () => {}, () => {});
  assert.deepEqual(opened, []);
});
