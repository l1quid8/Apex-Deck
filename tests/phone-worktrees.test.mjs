import test from 'node:test';
import assert from 'node:assert/strict';

// The phone's Worktrees pane and its ↓ button. These run the rules that decide what each row says,
// what its sheet offers, who sees the pane, and how many replies the ↓ counts.
const { canManageWorktrees, newBelow, newWorktreeFolder, projectTop, shortPath, startFrom, worktreeActions, worktreeRow } = await import(new URL('../src/phone/worktrees.ts', import.meta.url).href);

const tree = (over = {}) => ({ path: '/Users/you/Downloads/apex-deck-worktrees/feat-x', head: 'abcdef1234', branch: 'feat/x', main: false, locked: false, prunable: false, changes: 0, task: false, copy: null, ...over });
const copy = (over = {}) => tree({ branch: null, copy: { bot: 'Jigga', thread: 't1', threadTitle: 'Phone polish', state: 'working', reason: null, ...over }, changes: 3 });

test('only Full access to every thread opens the pane, as the Mac only lists worktrees for that', () => {
  assert.equal(canManageWorktrees(null), true); // a WebSocket pair has no access record and keeps full control
  assert.equal(canManageWorktrees({ tier: 'full', threads: 'all' }), true);
  assert.equal(canManageWorktrees({ tier: 'full', threads: ['t1'] }), false);
  assert.equal(canManageWorktrees({ tier: 'chat', threads: 'all' }), false);
  assert.equal(canManageWorktrees({ tier: 'read_only', threads: 'all' }), false);
});

test('an agent copy row names the agent, marks this thread, and says what it is doing', () => {
  const mine = worktreeRow(copy(), 't1', '/p');
  assert.deepEqual([mine.dot, mine.name, mine.tag, mine.here, mine.line, mine.warn], ['busy', 'Jigga’s copy', 'This thread', true, 'Working · 3 changed files', null]);
  const folding = worktreeRow(copy({ state: 'folding' }), 't1', '/p');
  assert.equal(folding.dot, 'on');
  assert.equal(folding.line, 'Folding back · 3 changed files');
});

test('a stuck copy from another thread names that thread, goes amber, and says why', () => {
  const row = worktreeRow({ ...copy({ bot: 'Scout', thread: 't2', threadTitle: 'Build check', state: 'needs_you', reason: 'README.md changed on both sides.' }), changes: 1 }, 't1', '/p');
  assert.deepEqual([row.dot, row.tag, row.line, row.warn], ['wait', null, 'Build check · Needs you · 1 changed file', 'README.md changed on both sides.']);
});

test('worktree rows: mounted, main, changes and missing each read as one plain line', () => {
  const root = '/Users/you/Downloads/apex-deck';
  const main = worktreeRow(tree({ path: root, branch: 'main', main: true }), 't1', root);
  assert.deepEqual([main.dot, main.tag, main.here, main.line], ['on', 'Mounted here', true, 'Main · ~/Downloads/apex-deck']);
  const mainElsewhere = worktreeRow(tree({ path: root, branch: 'main', main: true }), 't1', '/other');
  assert.deepEqual([mainElsewhere.dot, mainElsewhere.tag], ['on', null]);
  const changed = worktreeRow(tree({ changes: 4 }), 't1', root);
  assert.deepEqual([changed.dot, changed.tag, changed.line], ['', '4 changes', '…/apex-deck-worktrees/feat-x']);
  const gone = worktreeRow(tree({ prunable: true, branch: 'fix/old-tabs' }), 't1', root);
  assert.deepEqual([gone.dot, gone.tag, gone.line], ['off', 'Missing', 'Its folder is gone']);
  assert.equal(worktreeRow(tree({ branch: null }), 't1', root).name, 'detached · abcdef12');
});

test('a row\'s sheet offers what the Mac\'s ⋯ menu does, minus Open folder', () => {
  const root = '/Users/you/Downloads/apex-deck';
  assert.deepEqual(worktreeActions(tree(), root), { mount: true, mounted: false, discard: false, prune: true, remove: true });
  // The folder this thread works in can't be pruned or removed until another is mounted.
  assert.deepEqual(worktreeActions(tree({ path: root + '/' }), root), { mount: true, mounted: true, discard: false, prune: false, remove: false });
  assert.deepEqual(worktreeActions(tree({ main: true }), '/x'), { mount: true, mounted: false, discard: false, prune: false, remove: false });
  assert.deepEqual(worktreeActions(tree({ locked: true }), '/x'), { mount: true, mounted: false, discard: false, prune: false, remove: false });
  assert.deepEqual(worktreeActions(tree({ prunable: true }), '/x'), { mount: false, mounted: false, discard: false, prune: true, remove: false });
  assert.deepEqual(worktreeActions(tree({ task: true }), '/x'), { mount: false, mounted: false, discard: false, prune: false, remove: false });
  // A working copy is Deck's to manage; a stuck one can be thrown away.
  assert.deepEqual(worktreeActions(copy(), '/x'), { mount: false, mounted: false, discard: false, prune: false, remove: false });
  assert.equal(worktreeActions(copy({ state: 'needs_you' }), '/x').discard, true);
});

test('New worktree fills the folder in beside the project, and starts from its branch', () => {
  assert.equal(newWorktreeFolder('/Users/you/Downloads/apex-deck/', 'feat/jump-to-bottom'), '/Users/you/Downloads/apex-deck-worktrees/feat-jump-to-bottom');
  assert.equal(startFrom([tree(), tree({ main: true, branch: 'main' })]), 'main');
  assert.equal(startFrom([tree({ main: true, branch: null })]), 'HEAD');
});

test('a thread in a subfolder still puts a new worktree beside the whole project, as the Mac\'s tab does', () => {
  // The Mac's list names the project's top folder; the thread here works in its crates folder.
  const top = projectTop({ root: '/Users/you/Downloads/apex-deck', items: [] }, '/Users/you/Downloads/apex-deck/crates');
  assert.equal(newWorktreeFolder(top, 'feat/x'), '/Users/you/Downloads/apex-deck-worktrees/feat-x');
  // Before the Mac has answered, the thread's own folder is all the phone knows.
  assert.equal(projectTop(null, '/Users/you/Downloads/apex-deck/crates'), '/Users/you/Downloads/apex-deck/crates');
});

test('paths shorten to ~ and cut from the left', () => {
  assert.equal(shortPath('/home/ops/code'), '~/code');
  assert.equal(shortPath('/Users/you'), '~');
  assert.equal(shortPath('/srv/' + 'a'.repeat(60)).length, 46);
  assert.ok(shortPath('/srv/' + 'a'.repeat(60)).startsWith('…'));
});

test('the ↓ counts only replies that came in after you left the end', () => {
  const msgs = [{ seq: 1, speaker: { kind: 'human' } }, { seq: 2, speaker: { kind: 'bot' } }, { seq: 3, speaker: { kind: 'human' } }, { seq: 4, speaker: { kind: 'bot' } }, { seq: 5, speaker: { kind: 'bot' } }];
  assert.equal(newBelow(msgs, null), 0);
  assert.equal(newBelow(msgs, 5), 0);
  assert.equal(newBelow(msgs, 2), 2);
});
