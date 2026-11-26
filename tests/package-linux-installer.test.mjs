import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, verify, createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, copyFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildBundle, renderInstaller, desktopEntry } from '../scripts/package-linux-installer.mjs';

const template = readFileSync(new URL('../scripts/linux-installer/apex-deck-install.sh', import.meta.url), 'utf8');

test('installer template is fully rendered from channel names', () => {
  const text = renderInstaller(template, { channel: 'nightly', arch: 'arm64' });
  assert.doesNotMatch(text, /@@/);
  assert.match(text, /readonly AUTHORITY='\/var\/lib\/apex-deck-nightly-provenance'/);
  assert.match(text, /readonly SERVICE='apex-deck-nightly-provenance.service'/);
  assert.match(text, /readonly ARCH='arm64'/);
  assert.throws(() => renderInstaller('@@NOPE@@', { channel: 'nightly', arch: 'x64' }), /Unknown installer placeholder/);
  assert.throws(() => renderInstaller(template, { channel: 'nightly', arch: "x64'; rm -rf /" }), /Unsafe/);
  execFileSync('bash', ['-n'], { input: text });
});

test('desktop entry starts the root-owned launcher and matches the Wayland app id', () => {
  const entry = desktopEntry('nightly');
  assert.match(entry, /^Exec=\/usr\/local\/bin\/apex-deck-nightly$/m);
  assert.match(entry, /^Icon=dev\.apexdeck\.app\.nightly$/m);
  assert.match(entry, /^Name=Apex Deck Nightly$/m);
});

test('bundle carries a signed payload with broker, launcher assets and the same installer', { skip: process.platform !== 'linux' }, () => {
  const root = mkdtempSync(path.join(tmpdir(), 'apex-installer-test-'));
  try {
    const unpacked = path.join(root, 'linux-unpacked');
    mkdirSync(path.join(unpacked, 'resources/bin'), { recursive: true });
    writeFileSync(path.join(unpacked, 'apex-deck'), 'electron', { mode: 0o755 });
    writeFileSync(path.join(unpacked, 'chrome-sandbox'), 'sandbox', { mode: 0o4755 });
    writeFileSync(path.join(unpacked, 'resources/app.asar'), 'asar', { mode: 0o664 });
    writeFileSync(path.join(unpacked, 'resources/bin/apex-daemon'), 'daemon', { mode: 0o755 });
    const provenance = path.join(root, 'apex-provenance');
    writeFileSync(provenance, 'broker', { mode: 0o755 });
    const commit = 'b'.repeat(40);
    const json = path.join(root, 'app.json');
    writeFileSync(json, JSON.stringify({ channel: 'nightly', version: '0.9.19', arch: 'x64', sourceCommit: commit, buildNumber: 7, date: '20261125', name: 'Apex-Deck-Nightly_20261125_bbbbbbb_x86_64.AppImage' }));
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const out = path.join(root, 'out');
    const result = buildBundle({ unpacked, provenance, appimageJson: json, out, privateKey });
    assert.equal(path.basename(result.artifact), 'Apex-Deck-Nightly_20261125_bbbbbbb_x86_64.linux-installer.tar');
    assert.equal(result.trust, 'evaluation');
    assert.equal(readFileSync(`${result.artifact}.sha256`, 'utf8'), `${result.sha256}  ${path.basename(result.artifact)}\n`);
    const extracted = path.join(root, 'extracted'); mkdirSync(extracted);
    execFileSync('tar', ['-xf', result.artifact, '-C', extracted]);
    const top = path.join(extracted, 'Apex-Deck-Nightly_20261125_bbbbbbb_x86_64.linux-installer');
    const manifestBytes = readFileSync(path.join(top, 'release/manifest.json'));
    assert(verify(null, manifestBytes, publicKey, readFileSync(path.join(top, 'release/manifest.sig'))));
    assert.equal(createHash('sha256').update(manifestBytes).digest('hex'), result.manifestSha256);
    const manifest = JSON.parse(manifestBytes);
    assert.equal(manifest.evaluation, true);
    assert.equal(manifest.buildNumber, 7);
    const files = Object.fromEntries(manifest.files.map(f => [f.path, f]));
    assert.equal(files['resources/bin/apex-provenance'].mode, 0o755);
    assert.equal(files['chrome-sandbox'].mode, 0o755, 'setuid bit is never shipped');
    assert.equal(files['resources/app.asar'].mode, 0o644);
    assert(files['resources/linux/dev.apexdeck.app.nightly.desktop']);
    assert(Object.keys(files).some(p => /^resources\/linux\/icons\/\d+x\d+\.png$/.test(p)));
    const inner = path.join(root, 'payload'); mkdirSync(inner);
    execFileSync('tar', ['-xf', path.join(top, 'release/payload.tar'), '-C', inner]);
    assert.equal(readFileSync(path.join(inner, 'resources/linux/apex-deck-install'), 'utf8'), readFileSync(path.join(top, 'apex-deck-install'), 'utf8'));
    assert.equal(statSync(path.join(top, 'apex-deck-install')).mode & 0o777, 0o755);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('an unsigned production bundle seals with a committed key into the shape the broker verifies', { skip: process.platform !== 'linux' }, async () => {
  const { seal, rawPublicKey } = await import('../scripts/seal-linux-installer.mjs');
  const root = mkdtempSync(path.join(tmpdir(), 'apex-installer-seal-'));
  try {
    const unpacked = path.join(root, 'linux-unpacked');
    mkdirSync(path.join(unpacked, 'resources/bin'), { recursive: true });
    writeFileSync(path.join(unpacked, 'apex-deck'), 'electron', { mode: 0o755 });
    writeFileSync(path.join(unpacked, 'resources/app.asar'), 'asar');
    const provenance = path.join(root, 'apex-provenance');
    writeFileSync(provenance, 'broker', { mode: 0o755 });
    const commit = 'c'.repeat(40);
    const appImage = 'Apex-Deck-Nightly_20261126_ccccccc_arm64.AppImage';
    const json = path.join(root, 'app.json');
    writeFileSync(json, JSON.stringify({ channel: 'nightly', version: '0.9.19', arch: 'arm64', sourceCommit: commit, buildNumber: 5, date: '20261126', name: appImage }));
    const unsigned = buildBundle({ unpacked, provenance, appimageJson: json, out: path.join(root, 'unsigned'), privateKey: null, evaluation: false });
    assert.equal(path.basename(unsigned.artifact), 'Apex-Deck-Nightly_20261126_ccccccc_arm64.linux-installer.unsigned.tar');
    const listing = execFileSync('tar', ['-tf', unsigned.artifact], { encoding: 'utf8' });
    assert.doesNotMatch(listing, /manifest\.sig/, 'the build job never signs');
    assert.throws(() => buildBundle({ unpacked, provenance, appimageJson: json, out: path.join(root, 'bad'), privateKey: null }), /evaluation payload must be signed/);

    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const keyPath = path.join(root, 'key.pem');
    writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    const keysFile = path.join(root, 'keys.json');
    writeFileSync(keysFile, JSON.stringify({ stable: [], nightly: [rawPublicKey(privateKey)] }));
    const sealed = seal({ unsigned: unsigned.artifact, keyPath, keysFile, out: path.join(root, 'sealed'),
      channel: 'nightly', version: '0.9.19', commit, buildNumber: 5, arch: 'arm64', appImage, date: '20261126' });
    assert.equal(path.basename(sealed.artifact), 'Apex-Deck-Nightly_20261126_ccccccc_arm64.linux-installer.tar');
    assert.equal(sealed.manifestSha256, unsigned.manifestSha256, 'the seal signs the manifest bytes the build wrote');
    const extracted = path.join(root, 'extracted'); mkdirSync(extracted);
    execFileSync('tar', ['-xf', sealed.artifact, '-C', extracted]);
    const top = path.join(extracted, 'Apex-Deck-Nightly_20261126_ccccccc_arm64.linux-installer');
    const manifestBytes = readFileSync(path.join(top, 'release/manifest.json'));
    assert(verify(null, manifestBytes, publicKey, readFileSync(path.join(top, 'release/manifest.sig'))));
    assert.equal(JSON.parse(manifestBytes).evaluation, false);
    assert.equal(statSync(path.join(top, 'apex-deck-install')).mode & 0o777, 0o755);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
