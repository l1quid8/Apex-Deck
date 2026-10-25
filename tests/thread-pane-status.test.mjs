import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transform } from 'sucrase';
import * as composerStatus from '../src/composerStatus.ts';
import { terminalStatus } from '../src/terminalRun.ts';
import { ParticipantQueues } from '../src/turnQueue.ts';

// Exercise the selector used by Dashboard, the sidebar and pane headers without
// mounting the entire desktop. Keep its real lifecycle and terminal helpers.
const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const declaration = app.match(/const statusOf = \(pane: Pane\): PaneStatus => \{[\s\S]*?\n  \};/)[0];
const compiled = transform(declaration, { transforms: ['typescript'], disableESTransforms: true }).code;
const selectStatus = ({ threads = {}, attention = {}, output = new Map(), runs = {} } = {}) =>
  new Function('threadStatus', 'attention', 'lastOutput', 'runs', 'WORKING_WINDOW_MS', 'terminalStatus', 'threadPaneStatus', `${compiled}\nreturn statusOf;`)(
    threads, attention, { current: output }, runs, 1500, terminalStatus, composerStatus.threadPaneStatus,
  );
const pane = { id: 'thread', kind: 'chat' };
const status = (extra = {}) => ({ busy: false, text: '', replying: [], waiting: [], ...extra });

test('a silent running thread stays Working until its lifecycle ends', t => {
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  const threads = { thread: status({ busy: true, replying: ['Null'] }) };
  const output = new Map([['thread', now]]);
  const select = selectStatus({ threads, output });
  assert.equal(select(pane), 'working');
  now = 4000;
  assert.equal(select(pane), 'working', 'thinking and tools do not need output every 1.5 seconds');
  now = 9 * 60_000;
  assert.equal(select(pane), 'working', 'long silence cannot settle an active turn');
  threads.thread = status();
  output.set('thread', now);
  assert.equal(select(pane), 'idle', 'the terminal lifecycle event settles the thread immediately');
});

test('recipient reservations keep a thread Working between queued turns and stale room Idle', async () => {
  const queue = new ParticipantQueues(async () => ['null'], async () => {}, async () => {}, () => {});
  const threads = { thread: status() };
  const select = selectStatus({ threads });
  await queue.send('first');
  threads.thread = status({ busy: queue.active });
  assert.equal(select(pane), 'working', 'a dispatched turn counts before its first progress event');
  queue.started('null');
  await queue.send('second');
  queue.idle('null');
  queue.roomIdle();
  threads.thread = status({ busy: queue.active });
  assert.equal(select(pane), 'working', 'the next reservation survives the previous round ending');
  queue.idle('null');
  queue.roomIdle();
  threads.thread = status({ busy: queue.active });
  assert.equal(select(pane), 'idle');
});

test('open approvals and blocking questions take precedence over running work', () => {
  const waiting = selectStatus({ threads: { thread: status({ busy: true, replying: ['Null'], waiting: ['Jigga'] }) } });
  assert.equal(waiting(pane), 'needs_input');
  const question = selectStatus({
    threads: { thread: status({ busy: true, replying: ['Null'] }) },
    attention: { thread: { kind: 'needs_input', note: 'Answer a question', at: 1, blocking: true } },
  });
  assert.equal(question(pane), 'needs_input');
});

test('current work takes precedence over nonblocking attention from an earlier round', () => {
  for (const kind of ['done', 'failed', 'needs_input']) {
    for (const active of [{ busy: true }, { replying: ['Null'] }]) {
      const select = selectStatus({
        threads: { thread: status(active) },
        attention: { thread: { kind, note: 'Earlier round', at: 1 } },
      });
      assert.equal(select(pane), 'working', `${kind} cannot hide the active turn`);
    }
  }
});

test('settled threads keep their attention state and other room events cannot imply work', t => {
  t.mock.method(Date, 'now', () => 1000);
  for (const kind of ['done', 'failed', 'needs_input']) {
    const select = selectStatus({ threads: { thread: status() }, attention: { thread: { kind, note: '', at: 1 } } });
    assert.equal(select(pane), kind);
  }
  assert.equal(selectStatus({ output: new Map([['thread', 1000]]) })(pane), 'idle');
});

test('terminal output heuristics and stopped/exited states keep their existing behavior', t => {
  t.mock.method(Date, 'now', () => 4000);
  const terminal = { id: 'term', kind: 'terminal' };
  assert.equal(selectStatus({ runs: { term: { state: 'running' } }, output: new Map([['term', 3500]]) })(terminal), 'working');
  assert.equal(selectStatus({ runs: { term: { state: 'running' } }, output: new Map([['term', 1000]]) })(terminal), 'idle');
  for (const state of ['stopped', 'exited']) {
    assert.equal(selectStatus({ runs: { term: { state } }, output: new Map([['term', 3500]]) })(terminal), 'exited');
  }
  assert.equal(selectStatus({ runs: { term: { state: 'running' } }, attention: { term: { kind: 'needs_input', note: '', at: 1 } } })(terminal), 'needs_input');
  assert.equal(selectStatus()({ id: 'preview', kind: 'preview' }), 'idle');
});
