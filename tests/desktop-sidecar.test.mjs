import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { daemonBinary, serveArgs, dataDirArgs, developmentDataDir, developmentHostDataDir, waitForSocket, localDaemon } from '../desktop/sidecar.mjs';
import os from 'node:os';

test('waitForSocket resolves once something listens, and again once it has stopped', async () => {
  // A Unix socket path is capped at ~104 bytes, and os.tmpdir() is already too
  // long for one on macOS, so POSIX keeps the short /tmp. Windows has no socket
  // files: the daemon listens on a named pipe there, and so does this check.
  const dir = fs.mkdtempSync(process.platform === 'win32' ? path.join(os.tmpdir(), 'deck-wait-') : '/tmp/deck-wait-');
  const socket = process.platform === 'win32'
    ? `\\\\.\\pipe\\apex-deck-wait-${process.pid}-${Math.random().toString(16).slice(2)}`
    : path.join(dir, 'daemon.sock');
  try {
    assert.equal(await waitForSocket(socket, { timeout: 150 }), false, 'nothing listening yet');
    const server = net.createServer((c) => c.end()).listen(socket);
    await new Promise((resolve) => server.once('listening', resolve));
    assert.equal(await waitForSocket(socket, { timeout: 150 }), true);
    await new Promise((resolve) => server.close(resolve));
    assert.equal(await waitForSocket(socket, { wanted: false, timeout: 150 }), true);
    assert.equal(await waitForSocket(socket, { timeout: 150 }), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the daemon binary: the environment, then the bundled one, then the dev build', () => {
  const repo = '/src/apex-deck';
  // The bundled and dev binaries carry the platform's executable name, so this
  // asserts Windows' apex-daemon.exe when the suite runs there.
  const name = process.platform === 'win32' ? 'apex-daemon.exe' : 'apex-daemon';
  const dev = path.join(repo, 'target', 'debug', name);
  assert.equal(daemonBinary({ packaged: true, resourcesPath: '/App/Resources', repo, env: { APEX_DAEMON_BIN: '/x/' + name } }), '/x/' + name);
  assert.equal(daemonBinary({ packaged: true, resourcesPath: '/App/Resources', repo, env: {} }), path.join('/App/Resources', 'bin', name));
  assert.equal(daemonBinary({ packaged: false, resourcesPath: '/ignored', repo, env: {} }), dev);
  assert.equal(daemonBinary({ packaged: false, resourcesPath: '/ignored', repo, env: { APEX_DAEMON_BIN: '' } }), dev);
});

test('serve survives the app, and names a data folder only when one is set', () => {
  assert.deepEqual(serveArgs(undefined), ['serve']);
  assert.deepEqual(serveArgs(''), ['serve']);
  assert.deepEqual(serveArgs('/tmp/d'), ['serve', '--data-dir', '/tmp/d']);
  assert.deepEqual(dataDirArgs(undefined), ['data-dir']);
  assert.deepEqual(dataDirArgs('/tmp/d'), ['data-dir', '--data-dir', '/tmp/d']);
});

test('development data is stable per checkout and the host data folder is isolated from installed service data', () => {
  const env = {};
  const a = developmentDataDir('/work/deck-a', env, '/users/tester');
  assert.equal(a, developmentDataDir('/work/deck-a/.', env, '/users/tester'));
  assert.notEqual(a, developmentDataDir('/other/deck-a', env, '/users/tester'));
  // The folder is built with path.join, so accept either separator.
  assert.match(a, /^[\\/]users[\\/]tester[\\/]\.apex-deck[\\/]dev[\\/]deck-a-[a-f0-9]{12}$/);
  assert.equal(developmentDataDir('/work/deck-a', { APEX_DECK_DATA_DIR: '/tmp/shared' }, '/users/tester'), '/tmp/shared');
  assert.equal(developmentHostDataDir('/tmp/shared'), '/tmp/shared-checkout-host');
});

test('with remote access on, serve adds --remote; off, it does not', () => {
  assert.deepEqual(serveArgs('/tmp/d', { remote: true }), ['serve', '--remote', '--data-dir', '/tmp/d']);
  assert.deepEqual(serveArgs(undefined, { remote: true }), ['serve', '--remote']);
  assert.deepEqual(serveArgs('/tmp/d', { remote: false }), ['serve', '--data-dir', '/tmp/d']);
});

test('every script that builds the daemon for the desktop builds it with remote access', async () => {
  const fs = await import('node:fs');
  const { scripts } = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  // Packaging entry points hand off to scripts/package-pinned.mjs so the app
  // and the service get one commit stamp; the daemon still has to be built
  // with remote access inside that shared body.
  const effective = (name) => (
    /scripts\/package-pinned\.mjs/.test(scripts[name]) ? `${scripts[name]} && ${scripts['_desktop:package']}` : scripts[name]
  );
  for (const name of ['desktop', 'desktop:dev', 'desktop:smoke', 'desktop:package', 'desktop:dmg', 'desktop:smoke:multi-host']) {
    assert.match(effective(name), /cargo build (--release )?-p apex-daemon --features remote/, name);
  }
});


test('desktop exit leaves its shared daemon alive and simultaneous startup reuses the winner', async () => {
  const dir = fs.mkdtempSync('/tmp/deck-shared-');
  const fixture = path.join(dir, 'fake-daemon.cjs');
  fs.writeFileSync(fixture, `#!/usr/bin/env node
const net = require('node:net');
const path = require('node:path');
const fs = require('node:fs');
const folder = process.argv[process.argv.indexOf('--data-dir') + 1];
if (process.argv[2] === 'data-dir') { console.log(folder); process.exit(0); }
try { fs.writeFileSync(path.join(folder, 'owner.lock'), String(process.pid), { flag: 'wx' }); } catch { process.exit(1); }
const server = net.createServer(c => c.end());
server.on('error', () => process.exit(1));
// The lock is acquired well before readiness, as with a real host startup.
setTimeout(() => server.listen(path.join(folder, 'daemon.sock')), 250);
`, { mode: 0o700 });
  let daemons = [];
  try {
    daemons = await Promise.all([localDaemon({ bin: fixture, dataDir: dir }), localDaemon({ bin: fixture, dataDir: dir })]);
    assert.equal(daemons.filter(d => d.owned).length, 1);
    assert.equal(daemons.filter(d => !d.owned).length, 1);
    for (const daemon of daemons) await daemon.stop();
    assert.equal(await waitForSocket(daemons[0].socket, { timeout: 300 }), true);
    const reused = await localDaemon({ bin: fixture, dataDir: dir });
    assert.equal(reused.owned, false);
  } finally {
    for (const daemon of daemons) daemon.child?.kill('SIGKILL');
    await new Promise(resolve => setTimeout(resolve, 50));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
