import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { QuitGate, ANSWER_TIME, editsElsewhere } from '../desktop/quit.mjs';

test('the direct exit path awaits voice shutdown without relying on will-quit', async () => {
  // Execute the production quit function without starting Electron or a window.
  const source = readFileSync(new URL('../desktop/main.mjs', import.meta.url), 'utf8');
  const quit = source.match(/async function finishQuit\(\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(quit);
  let voiceStopped = false, daemonStopped = false;
  const context = {
    finishing: false,
    gate: { confirm() {} },
    localVoice: { async shutdown() { await Promise.resolve(); voiceStopped = true; } },
    flushProfile: async () => {},
    local: { owned: true, async stop() { daemonStopped = true; } },
    app: { exit(code) { assert.equal(code, 0); assert.ok(voiceStopped, 'voice helper stopped before app.exit'); assert.ok(daemonStopped); } },
  };
  await runInNewContext(`${quit}\nfinishQuit()`, context);
  assert.ok(voiceStopped);
});

function fakeTimers() {
  let now = 0; const pending = [];
  return {
    setTimeout: (fn, ms) => { const t = { fn, at: now + ms, live: true }; pending.push(t); return t; },
    clearTimeout: (t) => { t.live = false; },
    advance: (ms) => { now += ms; for (const t of pending) if (t.live && t.at <= now) { t.live = false; t.fn(); } },
  };
}

function gate() {
  const timers = fakeTimers(); const through = [];
  return { timers, through, gate: new QuitGate({ timers, letThrough: () => through.push('quit') }) };
}

test('a close or quit asks the window first, with its own number', () => {
  const { gate: g } = gate();
  assert.equal(ANSWER_TIME, 2000);
  assert.equal(g.request(), 1);
  assert.equal(g.request(), 2);
});

test('an answered request is held for the person', () => {
  const { gate: g, timers, through } = gate();
  const n = g.request();
  g.heard(n);
  timers.advance(10_000);
  assert.deepEqual(through, []);
  assert.equal(g.confirmed, false);
});

test('a window that never answers does not keep the app open', () => {
  const { gate: g, timers, through } = gate();
  g.request();
  timers.advance(1999);
  assert.deepEqual(through, []);
  timers.advance(1);
  assert.deepEqual(through, ['quit']);
  assert.equal(g.confirmed, true);
});

test('hearing an older request does not answer a newer one', () => {
  const { gate: g, timers, through } = gate();
  const first = g.request();
  g.request();
  g.heard(first);
  timers.advance(2000);
  assert.deepEqual(through, ['quit']);
});

/** The quitting and updates sections of main.mjs, run against fake windows; `tail` runs after them. */
function quitting({ windows, popoutWindows, tail = '', ...rest }) {
  const source = readFileSync(new URL('../desktop/main.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('// ------------------------------------------------------------ quitting');
  const end = source.indexOf('// ------------------------------------------------------------ the docked browser');
  assert.ok(start > 0 && end > start);
  const handlers = new Map();
  const exits = [];
  runInNewContext(`${source.slice(start, end)}\n${tail}`, {
    QuitGate,
    editsElsewhere,
    windows,
    popoutWindows,
    handle: (channel, run) => handlers.set(channel, run),
    localVoice: { async shutdown() {} },
    flushProfile: async () => {},
    local: null,
    app: { exit: (code) => exits.push(code) },
    ...rest,
  });
  return { handlers, exits };
}

test('unsaved edits in another Deck window or a pop-out stop Quit; the asking window’s own were already asked about', async () => {
  const deck = { win: { id: 1 } };
  const other = { win: { id: 2 } };
  const popout = { win: { id: 3 }, role: 'popout' };
  const { handlers, exits } = quitting({ windows: new Map([[1, deck], [2, other]]), popoutWindows: new Map([[3, popout]]) });
  const edit = handlers.get('updates:unsavedEdit');
  const quit = handlers.get('shell:quitApp');
  await edit(popout, 'plan.md');
  await assert.rejects(quit(deck), /^Error: plan\.md has unsaved changes in another Deck window\. Save or discard them there first\.$/);
  await edit(popout, null);
  await edit(other, 'todo.md');
  await assert.rejects(quit(deck), /^Error: todo\.md has unsaved changes in another Deck window/);
  assert.deepEqual(exits, [], 'Deck stays open');
  await edit(other, null);
  await edit(deck, 'notes.md');
  await quit(deck);
  assert.deepEqual(exits, [0]);
});

test('only another open window’s unsaved edits stop quitting; the asking window’s own were already asked about', () => {
  const open = new Set([1, 2]);
  const isOpen = (id) => open.has(id);
  assert.equal(editsElsewhere(new Map(), 1, isOpen), null);
  assert.equal(editsElsewhere(new Map([[1, 'notes.md']]), 1, isOpen), null);
  assert.match(editsElsewhere(new Map([[1, 'notes.md'], [2, 'plan.md']]), 1, isOpen), /^plan\.md has unsaved changes in another Deck window\. Save or discard them there first\.$/);
  open.delete(2);
  assert.equal(editsElsewhere(new Map([[2, 'plan.md']]), 1, isOpen), null, 'a closed window holds nothing');
});

test('a popped-out Files tab’s unsaved edits stop Restart to update from the Deck window', async () => {
  let restarts = 0;
  const deck = { win: { id: 1 } };
  const popout = { win: { id: 2 }, role: 'popout' };
  const { handlers } = quitting({
    windows: new Map([[1, deck]]),
    popoutWindows: new Map([[2, popout]]),
    fakeUpdater: { restart: async () => { restarts += 1; } },
    tail: 'updater = fakeUpdater;',
  });
  await handlers.get('updates:unsavedEdit')(popout, 'plan.md');
  await assert.rejects(handlers.get('updates:restart')(deck), /^Error: plan\.md has unsaved changes in another Deck window/);
  assert.equal(restarts, 0);
  await handlers.get('updates:unsavedEdit')(popout, null);
  await handlers.get('updates:restart')(deck);
  assert.equal(restarts, 1);
});

test('once confirmed nothing is held or asked again', () => {
  const { gate: g, timers, through } = gate();
  g.confirm();
  assert.equal(g.request(), null);
  timers.advance(5000);
  assert.deepEqual(through, []);
});
