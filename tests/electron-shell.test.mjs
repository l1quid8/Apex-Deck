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
    emitLine: (gen, line) => lineCb("local", gen, line),
    emitClose: (gen, reason) => closeCb("local", gen, reason),
    holdNext: () => new Promise((release) => hold.push(release)),
    daemon: {
      connect: async () => { const gen = ++next; while (hold.length) await hold.shift()(); return gen; },
      send: (_host, gen, line) => sent.push([gen, line]),
      close: (_host, gen) => closed.push(gen),
      onLine: (cb) => { lineCb = cb; return ()=>{}; },
      onClose: (cb) => { closeCb = cb; return ()=>{}; },
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

test('isolated requests require the isolation capability before sending work', async () => {
  const calls = [];
  const available = new Set(['assistant_delegation']);
  const client = {
    call: async (cmd, args) => { calls.push([cmd, args]); return null; },
    on: () => () => {},
    requireCapability: (capability) => { if (!available.has(capability)) throw new Error(`Update host for ${capability}`); },
  };
  const transport = daemonTransport(client);
  await transport.call('assistant_message', { mode: 'in_place' });
  assert.throws(() => transport.call('assistant_message', { mode: 'isolated' }), /Update host for assistant_isolation/);
  assert.throws(() => transport.call('assistant_task_action', { action: 'approve', mode: 'isolated' }), /Update host for assistant_isolation/);
  assert.equal(calls.length, 1);
  available.add('assistant_isolation');
  await transport.call('assistant_message', { mode: 'isolated' });
  assert.equal(calls.length, 2);
});

import { electronShell } from '../src/electronShell.ts';

test('the shell saves and opens on this machine, and the host opens targets and copies drops', async () => {
  const seen = [];
  const record = (name) => async (...args) => { seen.push([name, ...args]); return name === 'saveFile' ? '/Users/me/Downloads/a.md' : null; };
  const bridge = { shell: Object.fromEntries(['pickPath', 'saveFile', 'exportFile', 'openArtifact', 'setBadge', 'attention', 'startupFolders', 'quitHeard', 'quitApp'].map((n) => [n, record(n)])) };
  const calls = [];
  const transport = { call: async (cmd, args) => { calls.push([cmd, args]); return null; } };
  const shell = electronShell(bridge, transport, { owned: false, remote: false, name: 'This Mac' }, async () => null);
  assert.equal(shell.quitStopsWork, false);
  await shell.pickFolder();
  assert.equal(await shell.artifactSave('a.md', 'x'), '/Users/me/Downloads/a.md');
  await shell.exportThread('t.md', 'y');
  await shell.artifactOpenExternal('page.html', '<p>');
  await shell.flagAttention(3, false);
  await shell.flagAttention(0, true);
  await shell.requestCriticalAttention();
  await shell.openTarget('src/a.ts', '/w', true);
  await shell.copyAttachment('t', '/Users/me/pic.png');
  assert.deepEqual(seen, [
    ['pickPath', 'directory', 'Add a workspace folder'],
    ['saveFile', 'a.md', 'x'],
    ['exportFile', 't.md', 'y'],
    ['openArtifact', 'page.html', '<p>'],
    ['setBadge', 3],
    ['setBadge', 0], ['attention', false],
    ['attention', true],
  ]);
  assert.deepEqual(calls, [
    ['open_target', { target: 'src/a.ts', cwd: '/w', reveal: true }],
    ['copy_attachment', { room: 't', path: '/Users/me/pic.png' }],
  ]);
});

test('on another machine: work goes on after quitting, paths are typed, files there stay there', async () => {
  const opened = []; const asked = []; const saved = [];
  const bridge = { shell: {
    startupFolders: async () => ['/Users/me/proj'],
    openExternal: async (url) => { opened.push(url); },
    readLocalFile: async (hostId, path) => { assert.equal(hostId, 'at'); if (path.endsWith('/dir')) throw new Error("Error invoking remote method 'shell:readLocalFile': Error: Folders can't be sent to vps; drop the files in it instead."); return new Uint8Array([7, 8]); },
  } };
  const transport = {
    call: async () => { throw new Error('not expected'); },
    saveAttachment: async (room, name, bytes) => { saved.push([room, name, [...bytes]]); return '/home/me/att/pic.png'; },
  };
  const ask = async (request) => { asked.push(request); return '/srv/app'; };
  const shell = electronShell(bridge, transport, { id: 'at', owned: false, remote: true, name: 'vps' }, ask);
  assert.equal(shell.quitStopsWork, false);
  assert.deepEqual(await shell.startupFolders(), []);
  assert.equal(await shell.pickFolder(), '/srv/app');
  assert.equal(await shell.pickPath('file', 'Choose a key file'), '/srv/app');
  assert.deepEqual(asked, [{ hostId: 'at', kind: 'directory', title: 'Add a workspace folder' }, { hostId: 'at', kind: 'file', title: 'Choose a key file' }]);
  await shell.openTarget('https://example.com/docs', '/srv/app', false);
  assert.deepEqual(opened, ['https://example.com/docs']);
  await assert.rejects(shell.openTarget('src/main.rs', '/srv/app', true), { message: "That file is on vps; Deck can't open it on this Mac." });
  assert.equal(await shell.copyAttachment('t', '/Users/me/Desktop/pic.png'), '/home/me/att/pic.png');
  assert.deepEqual(saved, [['t', 'pic.png', [7, 8]]]);
  await assert.rejects(shell.copyAttachment('t', '/Users/me/dir'), { message: "Folders can't be sent to vps; drop the files in it instead." });
});

test("a refused connect reaches the banner in the daemon's own words", async () => {
  const bridge = fakeBridge();
  bridge.daemon.connect = async () => { throw new Error("Error invoking remote method 'daemon:connect': Error: /Users/me/Library/Application Support/dev.apexdeck.app: Apex Deck (pid 412) is using this folder"); };
  const connect = bridgeConnect(bridge);
  await assert.rejects(connect(), { message: '/Users/me/Library/Application Support/dev.apexdeck.app: Apex Deck (pid 412) is using this folder' });
});
