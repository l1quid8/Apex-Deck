import test from 'node:test';
import assert from 'node:assert/strict';
import { daemonBinary, serveArgs, dataDirArgs } from '../desktop/sidecar.mjs';

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
