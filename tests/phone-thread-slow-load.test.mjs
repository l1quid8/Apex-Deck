import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

// A big thread on a slow link must still arrive, however long it takes. These run PhoneApp's own load
// effect, sliced from the source, against a stand-in machine and a fake clock.
const { transform } = createRequire(import.meta.url)('sucrase');
const source = fs.readFileSync(new URL('../src/phone/PhoneApp.tsx', import.meta.url), 'utf8');
const slice = (s, e) => { const at = source.indexOf(s), end = source.indexOf(e, at); assert.ok(at >= 0 && end > at, s); return source.slice(at, end); };
const effect = transform(slice('  useEffect(() => {\n    if (!openPane || !openWorkspace)', '\n  // Who the message as typed'), { transforms: ['typescript'] }).code;
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve)); };
const thread = (count) => ({ snapshot: { transcript: Array.from({ length: count }, (_, i) => ({ seq: i + 1 })), participants: [], options: { policy: 'everyone' } }, approvals: [], active: [], live: true, cwd: '/p' });

/** Opens thread "big" on a stand-in Mac. `answer(n)` is what the Mac's nth thread request returns. */
async function openBigThread(t, answer) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { createRoomRecovery, representedRoomEvent } = await import(new URL('../src/roomRecovery.ts', import.meta.url).href);
  const { createStepsIndexLoader } = await import(new URL('../src/workSteps.ts', import.meta.url).href);
  const helpers = await import(new URL('../src/phone/threadCopies.ts', import.meta.url).href);
  const seen = { requests: 0, checks: [], loads: [] };
  const host = {
    machine: { id: 'mac', name: 'Mac' },
    connection: { get: () => ({ status: { kind: 'connected' } }) },
    // "Are you there?": the Mac is busy sending the thread, so it can't answer in time.
    check: async (ms) => { seen.checks.push(ms); return 'replaced'; },
    backend: { roomSteps: async () => null, onRoomEvent: async () => () => {} },
  };
  const env = {
    ...helpers,
    openPane: { id: 'big', workspaceId: 'ws', title: 'Big thread' }, openWorkspace: { id: 'ws' }, openHostId: 'mac', openLink: { id: 'mac', status: 'online' }, openPath: '/p', viewingPending: false,
    room: null, roomRef: { current: null },
    setRoom: (next) => { env.room = typeof next === 'function' ? next(env.room) : next; env.roomRef.current = env.room; },
    phoneHost: () => host, toLink: (status) => status.kind === 'connected' ? 'online' : 'offline', isChatSpace: () => false,
    threadKey: (pane, hostId) => `${hostId}:${pane.id}`, queueKey: (hostId, id) => JSON.stringify([hostId, id]),
    threadCopies: { current: { get: () => undefined } },
    setThreadLoad: (next) => seen.loads.push(next), retryThreadLoad: { current: () => {} },
    loadRoomState: () => answer(++seen.requests), NEW_THREAD: {}, LOST: 'lost',
    createRoomRecovery, representedRoomEvent, createStepsIndexLoader,
    loadedSteps: { current: new Map() }, refreshSteps: { current: () => {} }, setSavedSteps: () => {},
    setWaiting: () => {}, setBusy: () => {}, setCuts: () => {}, queues: { current: new Map() },
    restoreQuestions: () => ({}), NO_ASKS: {}, workingFrom: () => ({}), toPerson: (config) => config,
    phoneTrace: () => ({ add() {} }), roughKb: () => 0, words: (error) => String(error?.message ?? error),
    requestAnimationFrame: () => 0, setNotice: () => {}, useEffect: (run) => run(),
  };
  new Function('env', `with(env){${effect}}`)(env);
  await settle();
  return { env, seen, wait: async (ms) => { t.mock.timers.tick(ms); await settle(); } };
}

test('a thread still loading after 10 s says so and waits for the same answer, without asking the Mac if it is there', async (t) => {
  let arrive;
  const { env, seen, wait } = await openBigThread(t, () => new Promise((resolve) => { arrive = resolve; }));
  assert.equal(seen.requests, 1);
  await wait(10_000);
  // Before: the Mac was asked "are you there?" behind the thread it was still sending, looked dead,
  // and the phone dialed again, threw the download away and started over every 10 s.
  assert.deepEqual(seen.checks, [], 'no are-you-there check while the thread is on its way');
  assert.deepEqual(seen.loads.at(-1), { key: JSON.stringify(['mac', 'big']), failed: null, slow: true }, 'says it is still loading');
  await wait(50_000);
  assert.equal(seen.requests, 1, 'the same download is kept, not asked for again');
  assert.deepEqual(seen.checks, []);
  assert.equal(env.room, null);
  // A minute in, the thread lands and replaces the loading screen.
  arrive(thread(3));
  await settle();
  assert.equal(env.room?.messages.length, 3);
  assert.equal(seen.loads.at(-1), null);
});

test('a thread load that really fails is tried again after a wait', async (t) => {
  const { env, seen, wait } = await openBigThread(t, (n) => n === 1 ? Promise.reject(new Error('refused')) : Promise.resolve(thread(2)));
  assert.deepEqual(seen.loads.at(-1), { key: JSON.stringify(['mac', 'big']), failed: 'refused' });
  assert.equal(seen.requests, 1);
  await wait(2000);
  assert.equal(seen.requests, 2);
  assert.equal(env.room?.messages.length, 2);
  assert.equal(seen.loads.at(-1), null);
  assert.deepEqual(seen.checks, []);
});
