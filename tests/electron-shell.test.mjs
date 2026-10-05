import test from 'node:test';
import assert from 'node:assert/strict';
import { bridgeConnect, toBase64, fromBase64, daemonTransport } from '../src/electronShell.ts';

test('base64 both ways, for files of any size', () => {
  const bytes = new Uint8Array(300_000).map((_, i) => (i * 7) % 256);
  const text = toBase64(bytes);
  assert.equal(text, Buffer.from(bytes).toString('base64'));
  assert.deepEqual(fromBase64(text), bytes);
  assert.equal(toBase64(new Uint8Array()), '');
});

/** The preload bridge's daemon half, played by the test. */
function fakeBridge() {
  let lineCb, closeCb; let next = 0; const sent = []; const closed = []; const hold = [];
  return {
    sent, closed,
    emitLine: (gen, line) => lineCb(gen, line),
    emitClose: (gen, reason) => closeCb(gen, reason),
    holdNext: () => new Promise((release) => hold.push(release)),
    daemon: {
      connect: async () => { const gen = ++next; while (hold.length) await hold.shift()(); return gen; },
      send: (gen, line) => sent.push([gen, line]),
      close: (gen) => closed.push(gen),
      onLine: (cb) => { lineCb = cb; },
      onClose: (cb) => { closeCb = cb; },
    },
  };
}

test('a link hears only its own generation, and sends and closes as itself', async () => {
  const bridge = fakeBridge();
  const connect = bridgeConnect(bridge);
  const first = await connect();
  const heard = [];
  first.onLine((l) => heard.push(['first', l]));
  const second = await connect();
  second.onLine((l) => heard.push(['second', l]));
  bridge.emitLine(1, 'old');
  bridge.emitLine(2, 'new');
  second.send('hello');
  second.close();
  assert.deepEqual(heard, [['second', 'new']]);
  assert.deepEqual(bridge.sent, [[2, 'hello']]);
  assert.deepEqual(bridge.closed, [2]);
});

test('a close that arrives before the link is handed over still reaches it', async () => {
  const bridge = fakeBridge();
  const connect = bridgeConnect(bridge);
  const link = await connect();
  bridge.emitClose(1, 'Permission denied (publickey).');
  const reasons = [];
  link.onClose((r) => reasons.push(r));
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(reasons, ['Permission denied (publickey).']);
});

test('attachments travel as base64 over the daemon', async () => {
  const calls = [];
  const client = {
    call: async (cmd, args) => { calls.push([cmd, args]); return cmd === 'read_attachment' ? 'AQID' : '/att/a.bin'; },
    on: () => () => {},
  };
  const transport = daemonTransport(client);
  assert.equal(await transport.saveAttachment('t', 'a.bin', new Uint8Array([1, 2, 3])), '/att/a.bin');
  assert.deepEqual(new Uint8Array(await transport.readAttachment('/att/a.bin')), new Uint8Array([1, 2, 3]));
  assert.deepEqual(calls, [['save_attachment', { room: 't', name: 'a.bin', data: 'AQID' }], ['read_attachment', { path: '/att/a.bin' }]]);
});
