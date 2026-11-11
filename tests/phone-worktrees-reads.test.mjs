import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

// How often the phone asks the Mac about worktrees, and what for. This runs the pane's own useWorktrees,
// sliced from the source, under a few lines of stand-in React that re-render on demand.
const { transform } = createRequire(import.meta.url)('sucrase');
const source = fs.readFileSync(new URL('../src/phone/WorktreesPane.tsx', import.meta.url), 'utf8');
const at = source.indexOf('export function useWorktrees(');
const end = source.indexOf('\n}\n', at) + 2;
assert.ok(at >= 0 && end > at);
const code = transform(source.slice(at, end).replace(/^export /, ''), { transforms: ['typescript'] }).code;
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve)); };

/** Stand-in React: hooks keep their place by call order; effects run after a render when their inputs changed. */
function mount() {
  const slots = [];
  let index = 0, due = [];
  const env = {
    worktreeErrorMessage: (reason) => String(reason),
    useState(first) { const k = index++; if (!(k in slots)) slots[k] = { value: first }; const slot = slots[k]; return [slot.value, (next) => { slot.value = typeof next === 'function' ? next(slot.value) : next; }]; },
    useRef(first) { const k = index++; if (!(k in slots)) slots[k] = { current: first }; return slots[k]; },
    useEffect(run, deps) {
      const k = index++, before = slots[k];
      if (before && deps && deps.length === before.deps.length && deps.every((dep, i) => Object.is(dep, before.deps[i]))) return;
      due.push(() => { before?.undo?.(); slots[k] = { deps, undo: run() }; });
    },
  };
  const useWorktrees = new Function('env', `with(env){${code};return useWorktrees}`)(env);
  return (...args) => { index = 0; due = []; const state = useWorktrees(...args); due.forEach((run) => run()); return state; };
}

function mac() {
  const asked = [];
  const listing = { root: '/p', items: [{ path: '/p', branch: 'main', main: true, copy: null }] };
  const backend = {
    worktreeList: async (root) => { asked.push(`list ${root}`); return listing; },
    roomState: async (id) => { asked.push(`whole thread ${id}`); return { cwd: '/p' }; },
  };
  return { backend, asked };
}

test('the worktree list is read when the thread opens and when a reply finishes, never with the whole thread', async () => {
  const { backend, asked } = mac();
  const render = mount();
  // Thread t1 opens, idle: one list read, for the title bar's amber dot.
  render(backend, '/p', 't1', true, false, '/p');
  await settle();
  assert.deepEqual(asked, ['list /p']);
  // A reply starts, and its messages and steps stream in: nothing is read.
  render(backend, '/p', 't1', true, true, '/p');
  render(backend, '/p', 't1', true, true, '/p');
  await settle();
  assert.deepEqual(asked, ['list /p'], 'nothing is read while agents are still replying');
  // The reply finishes: read once, as that is when an agent copy folds back or gets stuck.
  render(backend, '/p', 't1', true, false, '/p');
  await settle();
  assert.deepEqual(asked, ['list /p', 'list /p']);
  const state = render(backend, '/p', 't1', true, false, '/p');
  assert.equal(state.listing.root, '/p');
  assert.ok(!asked.some((what) => what.startsWith('whole thread')), 'the thread is never downloaded again for its folder');
});

test('the mounted folder comes from the thread already loaded, and follows the phone\'s own Mount at once', async () => {
  const { backend, asked } = mac();
  const render = mount();
  let state = render(backend, '/p', 't1', true, false, '/p-worktrees/feat-x');
  await settle();
  state = render(backend, '/p', 't1', true, false, '/p-worktrees/feat-x');
  assert.equal(state.mounted, '/p-worktrees/feat-x');
  // Mount from the pane: the Mac has switched the folder, and the thread on screen hasn't reloaded yet.
  state.mountedTo('/p-worktrees/feat-y');
  state = render(backend, '/p', 't1', true, false, '/p-worktrees/feat-x');
  assert.equal(state.mounted, '/p-worktrees/feat-y');
  // When the thread loads again, what it says wins.
  state = render(backend, '/p', 't1', true, false, '/p-worktrees/feat-y');
  state = render(backend, '/p', 't1', true, false, '/p');
  assert.equal(state.mounted, '/p');
  // A thread the phone has not loaded yet works in its project folder.
  state = render(backend, '/p', 't2', true, false, null);
  state = render(backend, '/p', 't2', true, false, null);
  assert.equal(state.mounted, '/p');
  assert.ok(!asked.some((what) => what.startsWith('whole thread')));
});
