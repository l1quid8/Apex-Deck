import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Run the recovery's actual entry updater without mounting the entire chat UI.
const source = readFileSync(new URL('../src/ChatPane.tsx', import.meta.url), 'utf8');
const updater = source.match(/setEntries\(old => (\[\.\.\.restored, .*\])\);/)[1];
const restore = new Function('old', 'restored', `return ${updater};`);
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

test('failed chat loads mark their notices for cleanup on recovery', () => {
  const body = source.match(/fail: error => \{\n        if \(!alive\) return;\n        setReady\(false\); setLoadError\(String\(error\)\);([\s\S]*?)\n      \},/)[1];
  const calls = [];
  new Function('error', 'notify', body)(new Error('offline'), (...args) => calls.push(args));
  assert.equal(calls[0][3], 'room-load');
});
