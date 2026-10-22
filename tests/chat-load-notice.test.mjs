import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isWaitingForOwner, WAITING_FOR_OWNER } from '../src/roomRecovery.ts';

// Run the recovery's actual entry updater without mounting the entire chat UI.
const source = readFileSync(new URL('../src/ChatPane.tsx', import.meta.url), 'utf8');
const updater = source.match(/setEntries\(old => (\[\.\.\.restored, .*\])\);/)[1];
const restore = new Function('old', 'restored', 'mountNotice = []', `return ${updater};`);
const notice = (key, text, source) => ({ kind: 'notice', notice: { key, text, tone: 'error', ...(source ? { source } : {}) } });

test('successful chat retry removes load errors and preserves unrelated notices', () => {
  const unrelated = notice(2, 'Could not attach file');
  const similarText = notice(3, 'Could not load the chat: quoted by a tool');
  const restored = [{ kind: 'message', message: { seq: 1, text: 'Saved reply' } }];
  const old = [
    notice(0, 'Could not load the chat: offline', 'room-load'),
    notice(1, 'Could not load the chat: still offline', 'room-load'),
    unrelated, similarText,
    { kind: 'message', message: { seq: 0, text: 'Stale reply' } },
  ];
  assert.deepEqual(restore(old, restored), [...restored, unrelated, similarText]);
});

// The load failure handler, run as written with its collaborators stubbed.
const failBody = source.match(/fail: error => \{\n        if \(!alive\) return;\n        setReady\(false\); setLoadError\(String\(error\)\);([\s\S]*?)\n      \},/)[1];
const runFail = (error, attach) => {
  const calls = []; const missed = [];
  new Function('error', 'notify', 'attach', 'isWaitingForOwner', 'setWaitingForOwner', 'attachRetry', failBody)(
    error, (...args) => calls.push(args), attach, isWaitingForOwner, () => {}, { missed: () => missed.push(error) });
  return { calls, missed };
};

test('failed chat loads mark their notices for cleanup on recovery', () => {
  const { calls, missed } = runFail(new Error('offline'), false);
  assert.equal(calls[0][3], 'room-load');
  assert.equal(missed.length, 0);
});

test('an attached view waiting for Deck reads again quietly instead of stacking error notices', () => {
  const { calls, missed } = runFail(new Error(WAITING_FOR_OWNER), true);
  assert.equal(calls.length, 0);
  assert.equal(missed.length, 1);
  // The Deck window's own view never waits: there a missing room is a real error.
  assert.equal(runFail(new Error(WAITING_FOR_OWNER), false).calls.length, 1);
});


test('room recovery replaces the old mount notice instead of duplicating it', () => {
  const current=notice(3,'Now working in tree','mount');
  assert.deepEqual(restore([notice(1,'Now working in old tree','mount')],[],[current]),[current]);
});
