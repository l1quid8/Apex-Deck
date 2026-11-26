import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync, verify } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { publicKeyObject, publisherKeys, rawPublicKey, renderedInstaller, seal } from '../scripts/seal-linux-installer.mjs';

const linux = process.platform === 'linux';
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const id = {
  channel: 'nightly', version: '0.9.19', commit: 'a'.repeat(40), arch: 'x64', buildNumber: 5,
  appImage: 'Apex-Deck-Nightly_20261126_aaaaaaa_x86_64.AppImage', date: '20261126',
};
const top = 'Apex-Deck-Nightly_20261126_aaaaaaa_x86_64.linux-installer';

function fixture({ manifest = {}, extra, installer, link } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'seal-test-'));
  const root = path.join(dir, 'tree', top);
  mkdirSync(path.join(root, 'release'), { recursive: true });
  const payload = Buffer.from('payload bytes');
  writeFileSync(path.join(root, 'release/payload.tar'), payload);
  const body = { version: id.version, commit: id.commit, channel: id.channel, buildNumber: id.buildNumber, arch: id.arch, protocol: 1,
    evaluation: false, archiveSize: payload.length, archiveSha256: sha(payload), files: [{ path: 'apex-deck' }], ...manifest };
  writeFileSync(path.join(root, 'release/manifest.json'), JSON.stringify(body));
  writeFileSync(path.join(root, 'apex-deck-install'), installer ?? renderedInstaller(id.channel, id.arch), { mode: 0o755 });
  if (extra) writeFileSync(path.join(root, 'release', extra), 'x');
  if (link) symlinkSync('/etc/passwd', path.join(root, 'release', link));
  const unsigned = path.join(dir, `${top}.unsigned.tar`);
  execFileSync('tar', ['--create', '--file', unsigned, '--sort=name', '--owner=0', '--group=0', '--numeric-owner', '-C', path.join(dir, 'tree'), top]);
  const { privateKey } = generateKeyPairSync('ed25519');
  const keyPath = path.join(dir, 'key.pem');
  writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  chmodSync(keyPath, 0o600);
  const keysFile = path.join(dir, 'keys.json');
  writeFileSync(keysFile, JSON.stringify({ stable: [], nightly: [rawPublicKey(privateKey)] }));
  return { dir, unsigned, keyPath, keysFile, out: path.join(dir, 'out'), raw: rawPublicKey(privateKey) };
}

test('seals a production bundle with a committed key; the signature verifies against it', { skip: !linux }, () => {
  const f = fixture();
  try {
    const result = seal({ unsigned: f.unsigned, keyPath: f.keyPath, out: f.out, keysFile: f.keysFile, ...id });
    assert.equal(result.trust, 'production');
    assert.equal(result.publisherKey, f.raw);
    const extracted = path.join(f.dir, 'check');
    mkdirSync(extracted);
    execFileSync('tar', ['-xf', result.artifact, '-C', extracted]);
    const manifest = readFileSync(path.join(extracted, top, 'release/manifest.json'));
    const signature = readFileSync(path.join(extracted, top, 'release/manifest.sig'));
    assert.ok(verify(null, manifest, publicKeyObject(f.raw), signature));
    assert.equal(readFileSync(`${result.artifact}.sha256`, 'utf8'), `${sha(readFileSync(result.artifact))}  ${top}.tar\n`);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('refuses a key that is not a committed publisher key', { skip: !linux }, () => {
  const f = fixture();
  try {
    writeFileSync(f.keysFile, JSON.stringify({ stable: [], nightly: [Buffer.alloc(32, 1).toString('base64')] }));
    assert.throws(() => seal({ unsigned: f.unsigned, keyPath: f.keyPath, out: f.out, keysFile: f.keysFile, ...id }), /not a nightly publisher key/);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

for (const [label, options, pattern] of [
  ['an evaluation manifest', { manifest: { evaluation: true } }, /evaluation/],
  ['another commit', { manifest: { commit: 'b'.repeat(40) } }, /commit/],
  ['another build number', { manifest: { buildNumber: 6 } }, /buildNumber/],
  ['a payload the manifest does not describe', { manifest: { archiveSha256: 'c'.repeat(64) } }, /archiveSha256/],
  ['an extra file', { extra: 'manifest.sig' }, /unexpected entry/],
  ['a symlink', { link: 'evil' }, /unexpected entry/],
  ['another installer script', { installer: '#!/bin/sh\necho hi\n' }, /installer/],
]) {
  test(`refuses ${label}`, { skip: !linux }, () => {
    const f = fixture(options);
    try {
      assert.throws(() => seal({ unsigned: f.unsigned, keyPath: f.keyPath, out: f.out, keysFile: f.keysFile, ...id }), pattern);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });
}

test('refuses a signing key others can read', { skip: !linux }, () => {
  const f = fixture();
  try {
    chmodSync(f.keyPath, 0o644);
    assert.throws(() => seal({ unsigned: f.unsigned, keyPath: f.keyPath, out: f.out, keysFile: f.keysFile, ...id }), /readable only by its owner/);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('the committed publisher keys are valid Ed25519 keys and no channel shares one', () => {
  const stable = publisherKeys('stable');
  const nightly = publisherKeys('nightly');
  for (const raw of [...stable, ...nightly]) {
    assert.equal(Buffer.from(raw, 'base64').length, 32);
    assert.equal(publicKeyObject(raw).asymmetricKeyType, 'ed25519');
  }
  assert.deepEqual(stable.filter((key) => nightly.includes(key)), []);
  assert.equal(new Set(nightly).size, nightly.length);
});

test('the seal checks against the planned commit\'s data root, not only this checkout', { skip: !linux }, () => {
  const f = fixture();
  try {
    const root = path.join(f.dir, 'planned');
    mkdirSync(path.join(root, 'desktop'), { recursive: true });
    mkdirSync(path.join(root, 'scripts/linux-installer'), { recursive: true });
    mkdirSync(path.join(root, 'crates/apex-provenance'), { recursive: true });
    const here = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
    writeFileSync(path.join(root, 'desktop/channels.json'), readFileSync(path.join(here, 'desktop/channels.json')));
    writeFileSync(path.join(root, 'scripts/linux-installer/apex-deck-install.sh'), '#!/bin/bash\n# an older installer @@PRODUCT@@\n');
    writeFileSync(path.join(root, 'crates/apex-provenance/linux-publisher-keys.json'), readFileSync(f.keysFile));
    assert.throws(() => seal({ unsigned: f.unsigned, keyPath: f.keyPath, out: f.out, dataRoot: root, ...id }), /not this commit's installer/);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});
