import test from 'node:test';
import assert from 'node:assert/strict';
import { daemonBinary, serveArgs, dataDirArgs, remoteAccessSaved, saveRemoteAccess } from '../desktop/sidecar.mjs';

test('the daemon binary: the environment, then the bundled one, then the dev build', () => {
  const repo = '/src/apex-deck';
  assert.equal(daemonBinary({ packaged: true, resourcesPath: '/App/Resources', repo, env: { APEX_DAEMON_BIN: '/x/apex-daemon' } }), '/x/apex-daemon');
  assert.equal(daemonBinary({ packaged: true, resourcesPath: '/App/Resources', repo, env: {} }), '/App/Resources/bin/apex-daemon');
  assert.equal(daemonBinary({ packaged: false, resourcesPath: '/ignored', repo, env: {} }), '/src/apex-deck/target/debug/apex-daemon');
  assert.equal(daemonBinary({ packaged: false, resourcesPath: '/ignored', repo, env: { APEX_DAEMON_BIN: '' } }), '/src/apex-deck/target/debug/apex-daemon');
});

test('serve exits with the app, and names a data folder only when one is set', () => {
  assert.deepEqual(serveArgs(undefined), ['serve', '--exit-on-stdin-close']);
  assert.deepEqual(serveArgs(''), ['serve', '--exit-on-stdin-close']);
  assert.deepEqual(serveArgs('/tmp/d'), ['serve', '--exit-on-stdin-close', '--data-dir', '/tmp/d']);
  assert.deepEqual(dataDirArgs(undefined), ['data-dir']);
  assert.deepEqual(dataDirArgs('/tmp/d'), ['data-dir', '--data-dir', '/tmp/d']);
});

test('with remote access on, serve adds --remote; off, it does not', () => {
  assert.deepEqual(serveArgs('/tmp/d', { remote: true }), ['serve', '--exit-on-stdin-close', '--remote', '--data-dir', '/tmp/d']);
  assert.deepEqual(serveArgs(undefined, { remote: true }), ['serve', '--exit-on-stdin-close', '--remote']);
  assert.deepEqual(serveArgs('/tmp/d', { remote: false }), ['serve', '--exit-on-stdin-close', '--data-dir', '/tmp/d']);
});

test('the Remote access switch is saved, defaults to off, and survives a bad file', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-remote-'));
  const file = path.join(dir, 'desktop-settings.json');
  assert.equal(remoteAccessSaved(file), false);
  saveRemoteAccess(file, true);
  assert.equal(remoteAccessSaved(file), true);
  saveRemoteAccess(file, false);
  assert.equal(remoteAccessSaved(file), false);
  fs.writeFileSync(file, '{not json');
  assert.equal(remoteAccessSaved(file), false);
  fs.writeFileSync(file, JSON.stringify({ version: 1, remoteAccess: 'yes', other: 1 }));
  assert.equal(remoteAccessSaved(file), false);
  saveRemoteAccess(file, true);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).other, 1, 'other keys are kept');
  fs.rmSync(dir, { recursive: true });
});

test('every script that builds the daemon for the desktop builds it with remote access', async () => {
  const fs = await import('node:fs');
  const { scripts } = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  for (const name of ['desktop', 'desktop:dev', 'desktop:smoke', 'desktop:package', 'desktop:dmg', 'desktop:smoke:multi-host']) {
    assert.match(scripts[name], /cargo build (--release )?-p apex-daemon --features remote/, name);
  }
});
