import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { generateKeyPairSync, verify, createHash } from 'node:crypto';
import { packagePayload } from '../scripts/package-linux-protected.mjs';

test('evaluation package signs exact manifest and inventories every payload file', { skip: process.platform === 'win32' && 'Requires POSIX executable modes' }, () => {
  const root = mkdtempSync(path.join(tmpdir(), 'apex-payload-'));
  try {
    const payload = path.join(root, 'payload'); mkdirSync(payload);
    mkdirSync(path.join(payload, 'resources'));
    writeFileSync(path.join(payload, 'resources', 'app.asar'), 'application');
    writeFileSync(path.join(payload, 'apex-deck'), 'executable', { mode: 0o755 });
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const prefix = path.join(root, 'out');
    packagePayload({ payload, prefix, privateKey, arch: 'arm64', version: '0.9.9', commit: 'a'.repeat(40) });
    const bytes = readFileSync(`${prefix}.manifest.json`);
    assert(verify(null, bytes, publicKey, readFileSync(`${prefix}.sig`)));
    const manifest = JSON.parse(bytes);
    assert.equal(manifest.evaluation, true);
    assert.equal(manifest.channel, 'stable');
    assert.equal(manifest.buildNumber, undefined);
    assert.deepEqual(manifest.files.map(f => f.path), ['apex-deck', 'resources', 'resources/app.asar']);
    assert.equal(manifest.archiveSha256, createHash('sha256').update(readFileSync(`${prefix}.tar`)).digest('hex'));
    assert.equal(manifest.files[0].mode, 0o755);
    assert.equal(readFileSync(`${prefix}.tar`).length, manifest.archiveSize);
    assert.equal(bytes.includes(Buffer.from('PRIVATE KEY')), false);
    const nightly = { payload, privateKey, arch: 'arm64', version: '0.9.9', commit: 'b'.repeat(40), channel: 'nightly' };
    assert.throws(() => packagePayload({ ...nightly, prefix: path.join(root, 'missing') }), /build number/);
    const nightlyPrefix = path.join(root, 'nightly');
    packagePayload({ ...nightly, prefix: nightlyPrefix, buildNumber: 7 });
    const nightlyBytes = readFileSync(`${nightlyPrefix}.manifest.json`);
    assert(verify(null, nightlyBytes, publicKey, readFileSync(`${nightlyPrefix}.sig`)));
    assert.equal(JSON.parse(nightlyBytes).channel, 'nightly');
    assert.equal(JSON.parse(nightlyBytes).buildNumber, 7);
    symlinkSync('/etc/passwd', path.join(payload, 'escape'));
    assert.throws(() => packagePayload({ payload, prefix: path.join(root, 'bad'), privateKey, arch: 'arm64', version: '0.9.9', commit: 'a'.repeat(40) }), /symlink|regular/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
