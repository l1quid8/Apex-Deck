import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { localDaemon, remoteAccessSaved, saveRemoteAccess } from '../desktop/sidecar.mjs';
import { changeRemoteAccess } from '../desktop/remoteSwitch.mjs';

/**
 * A stand-in apex-daemon: `data-dir` prints the folder; `serve` listens on
 * daemon.sock until stdin closes, except `serve --remote`, which fails the
 * way a daemon built without the feature does.
 */
function fakeDaemonBin(dir) {
  const bin = path.join(dir, 'apex-daemon');
  fs.writeFileSync(bin, `#!${process.execPath}
const net = require('node:net');
const args = process.argv.slice(2);
const folder = args[args.indexOf('--data-dir') + 1];
if (args[0] === 'data-dir') { console.log(folder); process.exit(0); }
if (args.includes('--remote')) { console.error('apex-daemon: this apex-daemon was built without remote access (cargo feature \`remote\`)'); process.exit(2); }
const server = net.createServer((c) => c.end()).listen(require('node:path').join(folder, 'daemon.sock'));
process.stdin.on('end', () => { server.close(); process.exit(0); });
process.stdin.resume();
`);
  fs.chmodSync(bin, 0o755);
  return bin;
}

test('a restart that fails puts the previous setting back, saved, with a working daemon', async () => {
  const dir = fs.mkdtempSync('/tmp/deck-rs-');
  const dataDir = path.join(dir, 'd');
  fs.mkdirSync(dataDir);
  const file = path.join(dir, 'desktop-settings.json');
  const bin = fakeDaemonBin(dir);
  let current = false;
  let daemon = await localDaemon({ bin, dataDir, remote: current });
  const restart = async () => {
    await daemon?.stop();
    daemon = null;
    daemon = await localDaemon({ bin, dataDir, remote: current });
    return daemon;
  };
  try {
    await assert.rejects(
      changeRemoteAccess({ from: false, to: true, save: (on) => saveRemoteAccess(file, on), set: (on) => { current = on; }, restart }),
      (e) => /Remote access/.test(e.message) && /built without remote access/.test(e.message) && /left off/.test(e.message),
    );
    assert.equal(current, false, 'the running setting is the old one');
    assert.equal(remoteAccessSaved(file), false, 'the saved setting is the old one, so the next launch works');
    assert.ok(daemon?.alive(), 'a daemon is running again with the old setting');
  } finally {
    await daemon?.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a restart that works keeps the new setting', async () => {
  const saved = [];
  const set = [];
  const result = await changeRemoteAccess({ from: false, to: true, save: (on) => saved.push(on), set: (on) => set.push(on), restart: async () => ({ owned: true }) });
  assert.deepEqual(result, { owned: true });
  assert.deepEqual(saved, [true]);
  assert.deepEqual(set, [true]);
});

test('when even the old setting will not start, it is still put back and both failures are told', async () => {
  const saved = [];
  let n = 0;
  await assert.rejects(
    changeRemoteAccess({ from: true, to: false, save: (on) => saved.push(on), set: () => {}, restart: async () => { throw new Error(n++ ? 'second.' : 'first.'); } }),
    (e) => /first\./.test(e.message) && /left on/.test(e.message) && /second\./.test(e.message),
  );
  assert.deepEqual(saved, [false, true]);
});
