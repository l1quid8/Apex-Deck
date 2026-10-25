import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { daemonBinary, serveArgs, dataDirArgs, developmentDataDir, developmentHostDataDir, waitForSocket } from '../desktop/sidecar.mjs';

test('waitForSocket resolves once something listens, and again once it has stopped', async () => {
  const dir = fs.mkdtempSync('/tmp/deck-wait-');
  // A Unix socket is a file; Windows listens on a named pipe instead, and the
  // daemon does the same, so the check runs against whichever this platform has.
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

test('serve exits with the app, and names a data folder only when one is set', () => {
  assert.deepEqual(serveArgs(undefined), ['serve', '--exit-on-stdin-close']);
  assert.deepEqual(serveArgs(''), ['serve', '--exit-on-stdin-close']);
  assert.deepEqual(serveArgs('/tmp/d'), ['serve', '--exit-on-stdin-close', '--data-dir', '/tmp/d']);
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
  assert.deepEqual(serveArgs('/tmp/d', { remote: true }), ['serve', '--exit-on-stdin-close', '--remote', '--data-dir', '/tmp/d']);
  assert.deepEqual(serveArgs(undefined, { remote: true }), ['serve', '--exit-on-stdin-close', '--remote']);
  assert.deepEqual(serveArgs('/tmp/d', { remote: false }), ['serve', '--exit-on-stdin-close', '--data-dir', '/tmp/d']);
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
