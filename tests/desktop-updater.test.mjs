import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Writable } from 'node:stream';
import {
  FEED_URL, Updater, assetUrl, compareVersions, disabledReason, editsElsewhere, fetchDownload, fetchManifest,
  packageFor, packageVerifier, parseManifest, teamFrom,
} from '../desktop/updater.mjs';

const bytes = Buffer.from('apex deck 0.9.1 package');
const sha = crypto.createHash('sha256').update(bytes).digest('hex');
const feed = (fields = {}) => ({
  schemaVersion: 1,
  version: '0.9.1',
  notes: 'Faster restarts.',
  packages: [{ arch: 'arm64', minimumSystemVersion: '13.0', name: 'Apex-Deck-0.9.1-arm64.pkg', size: bytes.length, sha256: sha }],
  ...fields,
});

function fixture(t, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-updater-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const calls = { download: 0, verify: 0, install: [], changes: [] };
  const timers = { setTimeout: (fn) => { queueMicrotask(fn); return 1; }, clearTimeout: () => {} };
  const updater = new Updater({
    current: '0.9.0', arch: 'arm64', osVersion: '26.1',
    cacheDir: path.join(dir, 'cache'), stateFile: path.join(dir, 'updates.json'), resultFile: path.join(dir, 'last-update.json'),
    fetchJson: async (url) => { assert.equal(url, FEED_URL); return feed(); },
    download: async (url, file, { onProgress }) => {
      calls.download += 1;
      assert.equal(url, 'https://github.com/l1quid8/apex-deck/releases/download/v0.9.1/Apex-Deck-0.9.1-arm64.pkg');
      fs.writeFileSync(file, bytes);
      onProgress(bytes.length);
      return sha;
    },
    verify: async () => { calls.verify += 1; },
    requestInstall: async (ready) => { calls.install.push(ready); return '12345678-1234-4234-8234-123456789abc'; },
    timers, retryDelays: [0, 0], now: () => 1_000_000,
    onChange: (status) => calls.changes.push(status.state),
    ...overrides,
  });
  return { dir, updater, calls };
}

test('versions compare numerically and anything else is refused', () => {
  assert.ok(compareVersions('0.10.0', '0.9.9') > 0);
  assert.equal(compareVersions('1.0', '1.0.0'), 0);
  assert.ok(compareVersions('0.9.0', '0.9.1') < 0);
  assert.throws(() => compareVersions('1.0-beta', '1.0'));
});

test('the feed is read field by field and can only point at this repository', () => {
  assert.equal(parseManifest(feed()).packages[0].name, 'Apex-Deck-0.9.1-arm64.pkg');
  for (const bad of [
    { schemaVersion: 2 }, { version: 'latest' }, { notes: 5 }, { packages: [] },
    { packages: [{ ...feed().packages[0], name: '../../evil.pkg' }] },
    { packages: [{ ...feed().packages[0], name: 'https://evil.example/x.pkg' }] },
    { packages: [{ ...feed().packages[0], sha256: 'ABC' }] },
    { packages: [{ ...feed().packages[0], size: 0 }] },
    { packages: [{ ...feed().packages[0], arch: 'riscv' }] },
  ]) assert.throws(() => parseManifest(feed(bad)), JSON.stringify(bad));
  assert.equal(assetUrl('0.9.1', 'Apex-Deck-0.9.1-arm64.pkg'), 'https://github.com/l1quid8/apex-deck/releases/download/v0.9.1/Apex-Deck-0.9.1-arm64.pkg');
  assert.throws(() => assetUrl('0.9.1', 'a/b.pkg'));
  const manifest = parseManifest(feed());
  assert.ok(packageFor(manifest, { arch: 'arm64', osVersion: '13.0' }));
  assert.equal(packageFor(manifest, { arch: 'x64', osVersion: '26.1' }), null);
  assert.equal(packageFor(manifest, { arch: 'arm64', osVersion: '12.7' }), null);
});

test('only a packaged, Developer ID signed, protected copy on its own data updates itself', () => {
  const ok = { packaged: true, platform: 'darwin', dataDir: undefined, smoke: false, protectedCopy: true, team: 'TEAM123456' };
  assert.equal(disabledReason(ok), null);
  for (const change of [{ packaged: false }, { platform: 'linux' }, { smoke: true }, { dataDir: '/tmp/iso' }, { team: null }, { protectedCopy: false }]) {
    assert.equal(typeof disabledReason({ ...ok, ...change }), 'string', JSON.stringify(change));
  }
  assert.equal(teamFrom('Identifier=dev.apexdeck.app\nTeamIdentifier=TEAM123456\n'), 'TEAM123456');
  assert.equal(teamFrom('TeamIdentifier=not set\n'), null);
});

test('a newer release downloads, is checked, and waits ready in the cache', async (t) => {
  const { updater, calls } = fixture(t);
  const status = await updater.check();
  assert.equal(status.state, 'ready');
  assert.deepEqual(status.available, { version: '0.9.1', notes: 'Faster restarts.' });
  assert.deepEqual(calls.changes.filter((s, i, all) => s !== all[i - 1]), ['checking', 'downloading', 'verifying', 'ready']);
  assert.equal(calls.download, 1);
  assert.equal(calls.verify, 1);
  assert.deepEqual(fs.readFileSync(updater.ready.package), bytes);
});

test('an older or equal release, or a missing feed, means up to date', async (t) => {
  for (const fetchJson of [async () => feed({ version: '0.9.0' }), async () => feed({ version: '0.8.9' }), async () => null]) {
    const { updater, calls } = fixture(t, { fetchJson });
    assert.equal((await updater.check()).state, 'up-to-date');
    assert.equal(calls.download, 0);
  }
});

test('a download that does not match its checksum is retried, then reported, and leaves nothing behind', async (t) => {
  let attempts = 0;
  const { updater } = fixture(t, {
    download: async (_url, file) => { attempts += 1; fs.writeFileSync(file, 'tampered'); return 'f'.repeat(64); },
  });
  const status = await updater.check();
  assert.equal(attempts, 3);
  assert.equal(status.state, 'error');
  assert.match(status.error, /checksum/);
  assert.deepEqual(fs.readdirSync(path.join(updater.cacheDir, '0.9.1')), []);
});

test('a package whose app fails the signature check is deleted, not offered', async (t) => {
  const { updater } = fixture(t, { verify: async () => { throw new Error('The update isn’t signed by the team that signed this app.'); } });
  const status = await updater.check();
  assert.equal(status.state, 'error');
  assert.match(status.error, /team/);
  assert.deepEqual(fs.readdirSync(path.join(updater.cacheDir, '0.9.1')), []);
});

test('checks asked for at once share one download, and a verified download is reused', async (t) => {
  const { updater, calls } = fixture(t);
  const [a, b] = await Promise.all([updater.check(), updater.check({ manual: true })]);
  assert.equal(a.state, 'ready');
  assert.equal(b.state, 'ready');
  assert.equal(calls.download, 1);
  const again = new Updater({ ...updater, current: '0.9.0', download: async () => assert.fail('downloaded again') });
  assert.equal((await again.check()).state, 'ready');
});

test('a ready update survives a failed later check', async (t) => {
  let fail = false;
  const { updater } = fixture(t, { fetchJson: async () => { if (fail) throw new Error('offline'); return feed(); } });
  await updater.check();
  fail = true;
  const status = await updater.check();
  assert.equal(status.state, 'ready');
  assert.equal(status.available.version, '0.9.1');
});

test('restart hands over exactly the checked package and records the request; a refusal keeps it ready', async (t) => {
  const { updater, calls } = fixture(t);
  await assert.rejects(updater.restart(), /No update is ready/);
  await updater.check();
  assert.equal(await updater.restart(), '12345678-1234-4234-8234-123456789abc');
  assert.deepEqual(calls.install, [{ version: '0.9.1', package: updater.ready.package, sha256: sha, size: bytes.length }]);
  assert.deepEqual(JSON.parse(fs.readFileSync(updater.stateFile, 'utf8')).requested, { id: '12345678-1234-4234-8234-123456789abc', version: '0.9.1', from: '0.9.0', at: 1_000_000 });
  assert.equal(updater.status().state, 'installing');

  const refused = fixture(t, { requestInstall: async () => { throw new Error('An update is already being installed.'); } }).updater;
  await refused.check();
  await assert.rejects(refused.restart(), /already being installed/);
  assert.equal(refused.status().state, 'ready');
  assert.match(refused.status().error, /already/);
});

test('Later hides the ready banner until the person checks again', async (t) => {
  const { updater } = fixture(t);
  await updater.check();
  updater.later();
  assert.equal(updater.status().dismissed, true);
  await updater.check({ manual: true });
  assert.equal(updater.status().dismissed, false);
});

test('after relaunch Deck says once how the requested update went', (t) => {
  const id = '12345678-1234-4234-8234-123456789abc';
  const cases = [
    [{ id, outcome: 'installed' }, '0.9.1', 0, { outcome: 'installed', version: '0.9.1' }],
    [{ id, outcome: 'failed', message: 'Version 0.9.1 is not newer' }, '0.9.0', 0, { outcome: 'failed', version: '0.9.1', message: 'Version 0.9.1 is not newer' }],
    [{ id, outcome: 'needs-attention', message: 'injected' }, '0.9.0', 0, { outcome: 'needs-attention', version: '0.9.1', message: 'injected' }],
    [{ id: 'another', outcome: 'installed' }, '0.9.0', 20 * 60 * 1000, { outcome: 'failed', version: '0.9.1', message: 'The update did not run. Nothing was changed.' }],
    [null, '0.9.0', 60 * 1000, null],
  ];
  for (const [written, current, age, expected] of cases) {
    const { updater } = fixture(t, { current, now: () => 1_000_000 + age });
    fs.writeFileSync(updater.stateFile, JSON.stringify({ requested: { id, version: '0.9.1', from: '0.9.0', at: 1_000_000 } }));
    if (written) fs.writeFileSync(updater.resultFile, JSON.stringify(written));
    updater.reconcile();
    assert.deepEqual(updater.status().result, expected, JSON.stringify(written));
    assert.equal('requested' in JSON.parse(fs.readFileSync(updater.stateFile, 'utf8')), expected === null);
  }
});

test('a disabled updater never checks', async (t) => {
  const { updater } = fixture(t, { disabled: 'Development builds don’t update themselves.', fetchJson: async () => assert.fail('checked') });
  assert.equal((await updater.check()).state, 'disabled');
  updater.start();
});

test('downloads stop at the promised size and report the hash of what was written', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-download-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const body = (chunks) => ({ ok: true, status: 200, body: (async function* () { yield* chunks; })() });
  const download = fetchDownload(async () => body([bytes.subarray(0, 5), bytes.subarray(5)]));
  const seen = [];
  assert.equal(await download('u', path.join(dir, 'a'), { size: bytes.length, onProgress: (n) => seen.push(n) }), sha);
  assert.deepEqual(seen, [5, bytes.length]);
  await assert.rejects(fetchDownload(async () => body([bytes, bytes]))('u', path.join(dir, 'b'), { size: bytes.length }), /larger/);
  await assert.rejects(fetchDownload(async () => body([bytes.subarray(0, 3)]))('u', path.join(dir, 'c'), { size: bytes.length }), /early/);
  await assert.rejects(fetchDownload(async () => ({ ok: false, status: 404 }))('u', path.join(dir, 'd'), { size: 1 }), /404/);
  assert.equal(await fetchManifest(async () => ({ ok: false, status: 404 }))('u'), null);
  assert.deepEqual(await fetchManifest(async () => ({ ok: true, status: 200, text: async () => '{"a":1}' }))('u'), { a: 1 });
});

test('a file that cannot be written fails the download instead of crashing Deck, and the check retries', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-download-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const body = (chunks) => ({ ok: true, status: 200, body: (async function* () { for (const chunk of chunks) { await new Promise((done) => setTimeout(done, 5)); yield chunk; } })() });
  // The folder is gone: opening the file fails after the stream is made.
  await assert.rejects(fetchDownload(async () => body([bytes]))('u', path.join(dir, 'missing', 'a'), { size: bytes.length }), { code: 'ENOENT' });
  // The disk fills partway through.
  const full = Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
  const files = { createWriteStream: () => new Writable({ write: (_chunk, _encoding, done) => done(full) }) };
  await assert.rejects(fetchDownload(async () => body([bytes.subarray(0, 5), bytes.subarray(5), bytes.subarray(5)]), files)('u', path.join(dir, 'b'), { size: bytes.length * 2 }), { code: 'ENOSPC' });
  // Through the updater: three tries, then a retryable error.
  let attempts = 0;
  const { updater } = fixture(t, { download: (url, file, options) => { attempts += 1; return fetchDownload(async () => body([bytes]), files)(url, file, options); } });
  const status = await updater.check();
  assert.equal(attempts, 3);
  assert.equal(status.state, 'error');
  assert.match(status.error, /no space/);
});

test('the package check pins this app’s team and the promised version', async (t) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-verify-test-'));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const commands = [];
  let version = '0.9.1';
  let signed = true;
  const run = async (command, args) => {
    commands.push([command, ...args]);
    if (command === '/usr/bin/codesign' && !signed) throw new Error('failed');
    return command === '/usr/bin/plutil' ? `${version}\n` : '';
  };
  const verify = packageVerifier({ run, team: 'TEAM123456', scratch });
  await verify('/cache/u.pkg', { version: '0.9.1' });
  assert.equal(commands[0][0], '/usr/sbin/pkgutil');
  assert.equal(commands[0][1], '--expand-full');
  assert.ok(commands[1].includes('-R=identifier "dev.apexdeck.app" and anchor apple generic and certificate leaf[subject.OU] = "TEAM123456"'));
  version = '0.9.0';
  await assert.rejects(verify('/cache/u.pkg', { version: '0.9.1' }), /holds version 0.9.0/);
  signed = false;
  await assert.rejects(verify('/cache/u.pkg', { version: '0.9.1' }), /signed by the team/);
  assert.deepEqual(fs.readdirSync(scratch), [], 'each check clears its unpacked copy');
});

test('unsaved edits in another open window stop Restart to update; the asking window’s own were already asked about', () => {
  const open = new Set([1, 2]);
  const isOpen = (id) => open.has(id);
  assert.equal(editsElsewhere(new Map(), 1, isOpen), null);
  assert.equal(editsElsewhere(new Map([[1, 'notes.md']]), 1, isOpen), null);
  assert.match(editsElsewhere(new Map([[1, 'notes.md'], [2, 'plan.md']]), 1, isOpen), /^plan\.md has unsaved changes in another Deck window\. Save or discard them there first\.$/);
  open.delete(2);
  assert.equal(editsElsewhere(new Map([[2, 'plan.md']]), 1, isOpen), null, 'a closed window holds nothing');
});
