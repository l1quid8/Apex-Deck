#!/usr/bin/env node
// Cross-language/native verifier regression. Ephemeral test trust is compiled
// into a separate verifier build and never accepted by the ordinary broker.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { generateKeyPairSync } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import assert from 'node:assert/strict';
import { packagePayload } from './package-linux-protected.mjs';
const root = mkdtempSync(path.join(tmpdir(), 'apex-evaluation-ci-'));
try {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
  const payload = path.join(root, 'payload'); mkdirSync(payload);
  mkdirSync(path.join(payload, 'resources'));
  writeFileSync(path.join(payload, 'apex-deck'), 'signed executable fixture', { mode: 0o755 });
  writeFileSync(path.join(payload, 'resources', 'app.asar'), 'signed ASAR fixture');
  const prefix = path.join(root, 'evaluation');
  packagePayload({ payload, prefix, privateKey, arch: process.arch, version: '0.9.9', commit: 'a'.repeat(40) });
  const env = { ...process.env, APEX_LINUX_EVALUATION_PUBLIC_KEY: pub };
  // A separate target directory ensures these test verifier trust roots never
  // contaminate an ordinary release artifact selected by a packaging script.
  const target = path.join(root, 'target');
  execFileSync('cargo', ['build', '--locked', '-p', 'apex-provenance', '--features', 'linux-evaluation-verifier', '--target-dir', target], { env, stdio: 'inherit' });
  const verifier = path.join(target, 'debug', 'apex-provenance');
  const args = ['verify-linux-release', `${prefix}.manifest.json`, `${prefix}.sig`, `${prefix}.tar`];
  assert.match(execFileSync(verifier, args, { encoding: 'utf8' }), /Verified evaluation-only Linux payload/);
  const bytes = readFileSync(`${prefix}.tar`); bytes[512] ^= 1; writeFileSync(`${prefix}.tar`, bytes);
  const rejected = spawnSync(verifier, args, { encoding: 'utf8' });
  assert.equal(rejected.status, 1); assert.match(rejected.stderr, /digest mismatch/);
  // The ordinary verifier must remain disabled even with an evaluation key in
  // its runtime environment. Build without the evaluation feature.
  execFileSync('cargo', ['build', '--locked', '-p', 'apex-provenance', '--target-dir', target], { env, stdio: 'inherit' });
  const disabled = spawnSync(verifier, args, { env, encoding: 'utf8' });
  assert.equal(disabled.status, 1); assert.match(disabled.stderr, /trust is not provisioned/);
  console.log('Native signer/verifier interop, tamper rejection and unprovisioned trust checks passed.');
} finally { rmSync(root, { recursive: true, force: true }); }
