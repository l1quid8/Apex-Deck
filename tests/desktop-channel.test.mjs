import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync, sign, createHash } from 'node:crypto';
import { channel, loadChannel } from '../desktop/channel.mjs';
import { attestFrame } from '../desktop/provenance.mjs';
import { Updater, parseManifest, FEED_URL } from '../desktop/updater.mjs';

const commit = 'abcdef0'.padEnd(40, '1');
const release = { channel: 'nightly', commit, buildNumber: 42, tag: 'nightly-20261123-abcdef0' };
const bytes = Buffer.from('test installer');
const sha256 = createHash('sha256').update(bytes).digest('hex');
const manifest = { schemaVersion: 1, version: '1.2.3', packages: [
  { arch: 'arm64', minimumSystemVersion: '14.0', name: 'fixture.pkg', size: bytes.length, sha256 },
] };

test('packaged selection requires a sealed stamp and ignores the environment', () => {
  const select = stamp => loadChannel({ packaged: true, env: { APEX_CHANNEL: 'stable' }, readStamp: () => stamp });
  assert.equal(select(release).DOMAIN, 'apex-provenance-nightly-v1');
  for (const stamp of [null, {}, { channel: '' }, { channel: 'preview' }, { ...release, buildNumber: 0 }, { ...release, commit: 'abcdef0' }]) {
    assert.throws(() => select(stamp));
  }
  assert.throws(() => loadChannel({ packaged: false, env: { APEX_CHANNEL: '' } }));
});

test('a valid signature for the other receipt domain is rejected', async () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const domain = channel.nightly ? 'apex-provenance-v1' : 'apex-provenance-nightly-v1';
  await assert.rejects(attestFrame({ id: 1, cmd: 'room_set_trashed', args: { id: 'fixture', trashed: true } }, {
    platform: 'darwin', dataDir: '/fixture', uid: 501, publicKey: publicKey.export({type:'spki',format:'der'}).subarray(-32),
    issue: async ({command}) => {
      const payload = JSON.stringify({ domain, kind: 'submission', receipt: { uid: 501, dataDir: '/fixture', command } });
      return { payload, signature: sign(null, Buffer.from(payload), privateKey).toString('base64') };
    },
  }), /Receipt does not match/);
});

test('feeds are channel-specific and Nightly requires an immutable tag matching its SHA', () => {
  const other = channel.nightly ? {} : release;
  assert.throws(() => parseManifest({ ...manifest, ...other }), /channel/);
  if (channel.nightly) {
    assert.match(FEED_URL, /download\/nightly\/apex-deck-nightly-update.json$/);
    for (const fields of [{ tag: 'nightly' }, { commit: '0'.repeat(40) }, { buildNumber: 1.5 }]) {
      assert.throws(() => parseManifest({ ...manifest, ...release, ...fields }));
    }
  } else {
    assert.equal(parseManifest(manifest).version, manifest.version);
  }
});

test('same-version Nightlies download by build number and reconcile against the installed build', {skip: !channel.nightly}, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'channel-'));
  t.after(() => fs.rmSync(dir, {recursive:true, force:true}));
  let latest = release;
  const options = {
    current: manifest.version, installedBuild: { buildNumber: 41, commit: '0'.repeat(40) },
    arch: 'arm64', osVersion: '14.0', cacheDir: path.join(dir, 'cache'),
    stateFile: path.join(dir, 'state.json'), resultFile: path.join(dir, 'result.json'),
    fetchJson: async () => ({ ...manifest, ...latest }),
    download: async (url, file) => {
      assert.ok(url.endsWith('/' + latest.tag + '/fixture.pkg'));
      fs.writeFileSync(file, bytes);
      return sha256;
    },
    verify: async () => {}, requestInstall: async () => 'fixture', retryDelays: [],
  };
  for (const buildNumber of [undefined, null, 0, -1, 1.5]) {
    const invalid = new Updater({ ...options, installedBuild: { buildNumber } });
    assert.match((await invalid.check()).error, /Invalid installed Nightly build number/);
  }
  const updater = new Updater(options);
  assert.equal((await updater.check()).state, 'ready');
  const first = updater.ready.package;
  latest = { ...release, buildNumber: 43, commit: '2'.repeat(40), tag: 'nightly-20261124-2222222' };
  assert.equal((await updater.check()).state, 'ready');
  assert.notEqual(first, updater.ready.package);
  await updater.restart();
  fs.writeFileSync(options.resultFile, JSON.stringify({ id: 'fixture', outcome: 'installed' }));
  const state = fs.readFileSync(options.stateFile);
  updater.reconcile();
  assert.equal(updater.status().result.outcome, 'failed');
  fs.writeFileSync(options.stateFile, state);
  const restarted = new Updater({ ...options, installedBuild: latest });
  restarted.reconcile();
  assert.equal(restarted.status().result.outcome, 'installed');
  assert.equal((await restarted.check()).state, 'up-to-date');
});

test('each shared identity has a distinct value in both channels', () => {
  const { stable, nightly } = JSON.parse(fs.readFileSync(new URL('../desktop/channels.json', import.meta.url)));
  assert.deepEqual(Object.keys(stable).sort(), Object.keys(nightly).sort());
  for (const key of Object.keys(stable)) assert.notEqual(stable[key], nightly[key], key);
});

test('Windows sidecar selects the channel executable only for packaged builds', async () => {
  const { daemonBinary } = await import('../desktop/sidecar.mjs');
  const options = { platform: 'win32', repo: 'src', resourcesPath: 'resources', env: {} };
  assert.equal(daemonBinary({ ...options, packaged: true }), path.join('resources', 'bin', channel.WINDOWS_DAEMON));
  assert.equal(daemonBinary({ ...options, packaged: false }), path.join('src', 'target', 'debug', 'apex-daemon.exe'));
});

test('signed Windows Nightly installers must carry the promised numeric PE FileVersion', {skip: !channel.nightly}, async () => {
  const { windowsVerifier, windowsInstaller } = await import('../desktop/updater.mjs');
  const signer = { subject: 'Deck', issuer: 'Test' };
  const signature = { ...signer, issuer: 'O=Test', product: channel.PRODUCT, status: 'Valid', version: '1.2.3', fileVersion: '0.0.1.42' };
  const verify = windowsVerifier({ run: async () => JSON.stringify(signature), signer });
  const ready = { package: 'fixture.exe', version: '1.2.3', buildNumber: 65578 };
  await verify(ready.package, ready);
  signature.fileVersion = '0.0.1.41';
  await assert.rejects(windowsInstaller({ verify, launch: () => assert.fail('wrong build launched') })(ready), /build number mismatch/);
});

test('macOS requestUpdate carries buildNumber on Nightly and omits it on Stable', async () => {
  const { requestUpdate } = await import('../desktop/provenance.mjs');
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const rawKey = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
  let sent = null;
  const issue = async (req) => {
    sent = req;
    const payload = JSON.stringify({ domain: channel.DOMAIN, kind: 'update', uid: 501, id: '12345678-1234-4234-8234-123456789abc', version: req.version });
    return { payload, signature: sign(null, Buffer.from(payload), privateKey).toString('base64') };
  };
  const base = { version: '0.9.19', package: '/tmp/u.pkg', sha256: 'a'.repeat(64), size: 123 };
  if (channel.nightly) {
    await assert.rejects(requestUpdate(base, { uid: 501, publicKey: rawKey, issue }), /build number/);
    const id = await requestUpdate({ ...base, buildNumber: 42 }, { uid: 501, publicKey: rawKey, issue });
    assert.equal(id, '12345678-1234-4234-8234-123456789abc');
    assert.equal(sent.buildNumber, 42);
  } else {
    const id = await requestUpdate({ ...base, buildNumber: 42 }, { uid: 501, publicKey: rawKey, issue });
    assert.equal(id, '12345678-1234-4234-8234-123456789abc');
    assert.equal('buildNumber' in sent, false);
  }
});
