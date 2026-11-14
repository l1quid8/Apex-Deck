import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { generateKeyPairSync, verify, createHash } from 'node:crypto';
import { packagePayload } from '../scripts/package-linux-protected.mjs';

test('evaluation package signs exact manifest and inventories every payload file', () => {
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
    assert.deepEqual(manifest.files.map(f => f.path), ['apex-deck', 'resources', 'resources/app.asar']);
    assert.equal(manifest.archiveSha256, createHash('sha256').update(readFileSync(`${prefix}.tar`)).digest('hex'));
    assert.equal(manifest.files[0].mode, 0o755);
    assert.equal(readFileSync(`${prefix}.tar`).length, manifest.archiveSize);
    assert.equal(bytes.includes(Buffer.from('PRIVATE KEY')), false);
    symlinkSync('/etc/passwd', path.join(payload, 'escape'));
    assert.throws(() => packagePayload({ payload, prefix: path.join(root, 'bad'), privateKey, arch: 'arm64', version: '0.9.9', commit: 'a'.repeat(40) }), /symlink|regular/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
