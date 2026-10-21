import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { QuitGate, ANSWER_TIME } from '../desktop/quit.mjs';

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

test('once confirmed nothing is held or asked again', () => {
  const { gate: g, timers, through } = gate();
  g.confirm();
  assert.equal(g.request(), null);
  timers.advance(5000);
  assert.deepEqual(through, []);
});
