import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import {
  callDaemon, hasRemoteAccessKey, importSavedRemoteAccess, readDesktopSettings, setPhoneConnections, writeDesktopSettings,
} from '../desktop/remoteSwitch.mjs';

/** A stand-in daemon: the saved setting, and whether the file exists yet. */
function daemonDouble() {
  let enabled = false;
  let present = false;
  const calls = [];
  const call = async (cmd, args) => {
    calls.push({ cmd, args });
    if (args.import && present) return { enabled, endpoint_id: null, port: null, advertise: [] };
    enabled = args.enabled === true;
    present = true;
    return { enabled, endpoint_id: enabled ? 'ep' : null, port: enabled ? 9 : null, advertise: [] };
  };
  return { calls, call, state: () => ({ enabled, present }) };
}

test('setPhoneConnections asks the daemon without restarting anything', async () => {
  const calls = [];
  const info = await setPhoneConnections({
    enabled: true,
    call: async (cmd, args) => {
      calls.push({ cmd, args });
      return { enabled: true, endpoint_id: 'abc', port: 1, advertise: [] };
    },
  });
  assert.deepEqual(calls, [{ cmd: 'remote_set', args: { enabled: true, import: false } }]);
  assert.equal(info.enabled, true);
});

test('an import writes the daemon setting and deletes only the old key', async () => {
  const dir = fs.mkdtempSync('/tmp/deck-rs-');
  const file = path.join(dir, 'desktop-settings.json');
  writeDesktopSettings(file, { remoteAccess: true, theme: 'dark' });
  const daemon = daemonDouble();
  try {
    const info = await importSavedRemoteAccess(file, daemon.call);
    assert.equal(info.enabled, true);
    assert.equal(hasRemoteAccessKey(file), false);
    assert.equal(readDesktopSettings(file).theme, 'dark');
    assert.deepEqual(daemon.calls, [{ cmd: 'remote_set', args: { enabled: true, import: true } }]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a failed key delete, a later off, and a re-sent import ends off', async () => {
  const dir = fs.mkdtempSync('/tmp/deck-rs-');
  const file = path.join(dir, 'desktop-settings.json');
  writeDesktopSettings(file, { remoteAccess: true, theme: 'dark' });
  const daemon = daemonDouble();
  try {
    fs.chmodSync(dir, 0o555);
    const info = await importSavedRemoteAccess(file, daemon.call);
    assert.equal(info.enabled, true, 'the daemon took the import');
    // A read-only folder is how a POSIX machine makes the rewrite fail. Windows
    // chmod only toggles the read-only flag on files, so there the key is always
    // rewritten and this half of the contract cannot be provoked.
    if (process.platform !== 'win32') assert.equal(hasRemoteAccessKey(file), true, 'the key stays when it cannot be deleted');
    fs.chmodSync(dir, 0o755);

    const off = await setPhoneConnections({ enabled: false, call: daemon.call });
    assert.equal(off.enabled, false);

    const again = await importSavedRemoteAccess(file, daemon.call);
    assert.equal(again.enabled, false, 'the re-sent import does not turn it back on');
    assert.equal(daemon.state().enabled, false);
    assert.equal(hasRemoteAccessKey(file), false, 'the key is deleted once the write works');
    assert.equal(readDesktopSettings(file).theme, 'dark');
    assert.deepEqual(daemon.calls.map((entry) => entry.args), [
      { enabled: true, import: true },
      { enabled: false, import: false },
      { enabled: true, import: true },
    ]);
  } finally {
    fs.chmodSync(dir, 0o755);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a daemon error during import leaves the old key', async () => {
  const dir = fs.mkdtempSync('/tmp/deck-rs-');
  const file = path.join(dir, 'desktop-settings.json');
  writeDesktopSettings(file, { remoteAccess: false });
  try {
    await assert.rejects(
      importSavedRemoteAccess(file, async () => { throw new Error('UDP port 9 is in use'); }),
      /UDP port 9 is in use/,
    );
    assert.equal(hasRemoteAccessKey(file), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** A socket that speaks one answer, after an event and the hello. */
function answeringSocket(dir, frames) {
  // Windows has no Unix socket files; the daemon this stands in for listens on a
  // named pipe there, so the double does too.
  const socketPath = process.platform === 'win32'
    ? `\\\\.\\pipe\\apex-deck-rs-${process.pid}-${Math.random().toString(16).slice(2)}`
    : path.join(dir, 'daemon.sock');
  const seen = [];
  const server = net.createServer((socket) => {
    let buf = '';
    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) seen.push(JSON.parse(line));
      }
      if (seen.some((frame) => frame.id === 1)) {
        for (const frame of frames) socket.write(`${JSON.stringify(frame)}\n`);
      }
    });
  });
  return { socketPath, seen, listen: () => new Promise((resolve) => server.listen(socketPath, resolve)), close: () => new Promise((resolve) => server.close(resolve)) };
}

test('callDaemon says hello, skips other frames, and returns the answer', async () => {
  const dir = fs.mkdtempSync('/tmp/deck-rs-');
  const server = answeringSocket(dir, [
    { seq: 4, event: 'room-event', payload: {} },
    { id: 0, ok: { protocol: 1 } },
    { id: 1, ok: { enabled: false, endpoint_id: null, port: null, advertise: [] } },
  ]);
  await server.listen();
  try {
    const info = await callDaemon(server.socketPath, 'remote_info', {});
    assert.equal(info.enabled, false);
    assert.deepEqual(server.seen.map((frame) => frame.cmd), ['hello', 'remote_info']);
    assert.equal(server.seen[0].args.protocol, 1);
    assert.equal(server.seen[0].id, 0);
    assert.equal(server.seen[1].id, 1);
  } finally {
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('callDaemon rejects with the daemon words', async () => {
  const dir = fs.mkdtempSync('/tmp/deck-rs-');
  const server = answeringSocket(dir, [
    { id: 0, ok: { protocol: 1 } },
    { id: 1, err: 'UDP port 41641 is in use', reason: 'io' },
  ]);
  await server.listen();
  try {
    await assert.rejects(callDaemon(server.socketPath, 'remote_set', { enabled: true, import: false }), /41641/);
  } finally {
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
