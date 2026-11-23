#!/usr/bin/env node
// Cross-language/native verifier regression. Ephemeral test trust is compiled
// into a separate verifier build and never accepted by the ordinary broker.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { generateKeyPairSync, sign } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import assert from 'node:assert/strict';
import { packagePayload } from './package-linux-protected.mjs';
import { channel } from '../desktop/channel.mjs';
const root = mkdtempSync(path.join(tmpdir(), 'apex-evaluation-ci-'));
try {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
  const payload = path.join(root, 'payload'); mkdirSync(payload);
  mkdirSync(path.join(payload, 'resources'));
  writeFileSync(path.join(payload, 'apex-deck'), 'signed executable fixture', { mode: 0o755 });
  writeFileSync(path.join(payload, 'resources', 'app.asar'), 'signed ASAR fixture');
  const prefix = path.join(root, 'evaluation');
  const other = channel.nightly ? 'stable' : 'nightly';
  const otherPrefix = path.join(root, 'other-channel');
  const fixture = { payload, privateKey, arch: process.arch, version: '0.9.9', commit: 'a'.repeat(40) };
  const build = name => ({ channel: name, buildNumber: name === 'nightly' ? 2 : undefined });
  const ownManifest = packagePayload({ ...fixture, prefix, ...build(channel.name) });
  const otherManifest = packagePayload({ ...fixture, prefix: otherPrefix, ...build(other) });
  const legacyPrefix = path.join(root, 'legacy');
  const stable = channel.nightly ? otherPrefix : prefix;
  const { channel: _name, ...legacyManifest } = channel.nightly ? otherManifest : ownManifest;
  const legacyBytes = Buffer.from(JSON.stringify(legacyManifest));
  writeFileSync(`${legacyPrefix}.manifest.json`, legacyBytes);
  writeFileSync(`${legacyPrefix}.sig`, sign(null, legacyBytes, privateKey));
  const env = { ...process.env, APEX_LINUX_EVALUATION_PUBLIC_KEY: pub };
  // A separate target directory ensures these test verifier trust roots never
  // contaminate an ordinary release artifact selected by a packaging script.
  const target = path.join(root, 'target');
  const compile = (name, evaluation = true) => execFileSync('cargo',
    ['build', '--locked', '-p', 'apex-provenance', '--target-dir', target,
      ...(evaluation ? ['--features', 'linux-evaluation-verifier'] : [])],
    { env: { ...env, APEX_CHANNEL: name }, stdio: 'inherit' });
  compile(channel.name);
  const verifier = path.join(target, 'debug', 'apex-provenance');
  const verifyArgs = (manifestPrefix, archivePrefix = manifestPrefix) => [
    'verify-linux-release', `${manifestPrefix}.manifest.json`, `${manifestPrefix}.sig`, `${archivePrefix}.tar`,
  ];
  const args = verifyArgs(prefix);
  const rejectsChannel = input => {
    const result = spawnSync(verifier, input, { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /channel/i);
  };
  const verified = input => assert.match(execFileSync(verifier, input, { encoding: 'utf8' }), /Verified evaluation-only Linux payload/);
  const checkLegacy = name => (name === 'stable' ? verified : rejectsChannel)(verifyArgs(legacyPrefix, stable));
  verified(args);
  rejectsChannel(verifyArgs(otherPrefix));
  checkLegacy(channel.name);
  if (process.platform === 'linux' && process.env.CI === 'true') {
    const staging = `/var/lib/apex-deck-evaluation-test-${process.pid}`;
    // This is a disposable CI runner. No registration, authority state,
    // active descriptor or systemd service is created by this test.
    execFileSync('sudo', ['install', '-d', '-m', '0755', channel.LINUX_TREE, staging]);
    execFileSync('sudo', ['namei', '-l', channel.LINUX_TREE, staging], { stdio: 'inherit' });
    // Hosted runners may make /opt writable to the runner for tool caching.
    // Establish the production precondition on this disposable runner; never
    // weaken the verifier to accept writable installation ancestors.
    execFileSync('sudo', ['chown', 'root:root', '/opt']);
    execFileSync('sudo', ['chmod', 'go-w', '/opt']);
    for (const suffix of ['.manifest.json', '.sig', '.tar']) execFileSync('sudo', ['install', '-m', '0644', `${prefix}${suffix}`, `${staging}/release${suffix}`]);
    let tree;
    try {
      const output = execFileSync('sudo', [verifier, 'stage-linux-release', `${staging}/release.manifest.json`, `${staging}/release.sig`, `${staging}/release.tar`], { encoding: 'utf8' });
      assert(output.startsWith(`Staged verified evaluation payload: ${channel.LINUX_TREE}/staging-`));
      tree = output.trim().split(': ')[1];
      assert.equal(readFileSync(path.join(tree, 'resources/app.asar'), 'utf8'), 'signed ASAR fixture');
      assert.equal(existsSync(path.join(channel.LINUX_ROOT, 'active-install.json')), false);
      const invalid = readFileSync(`${prefix}.tar`); invalid[512] ^= 1;
      writeFileSync(`${prefix}.tampered.tar`, invalid);
      execFileSync('sudo', ['install', '-m', '0644', `${prefix}.tampered.tar`, `${staging}/release.tar`]);
      const rejected = spawnSync('sudo', [verifier, 'stage-linux-release', `${staging}/release.manifest.json`, `${staging}/release.sig`, `${staging}/release.tar`], { encoding: 'utf8' });
      assert.equal(rejected.status, 1); assert.match(rejected.stderr, /digest mismatch/);
      assert.equal(readFileSync(path.join(tree, 'apex-deck'), 'utf8'), 'signed executable fixture');
    } finally {
      if (tree?.startsWith(`${channel.LINUX_TREE}/staging-`)) execFileSync('sudo', ['rm', '-rf', '--', tree]);
      execFileSync('sudo', ['rm', '-rf', '--', staging]);
    }
  }
  const bytes = readFileSync(`${prefix}.tar`); bytes[512] ^= 1; writeFileSync(`${prefix}.tar`, bytes);
  const rejected = spawnSync(verifier, args, { encoding: 'utf8' });
  assert.equal(rejected.status, 1); assert.match(rejected.stderr, /digest mismatch/);
  bytes[512] ^= 1;
  writeFileSync(`${prefix}.tar`, bytes);
  compile(other);
  verified(verifyArgs(otherPrefix));
  rejectsChannel(args);
  checkLegacy(other);
  // The ordinary verifier must remain disabled even with an evaluation key in
  // its runtime environment. Build without the evaluation feature.
  compile(channel.name, false);
  const disabled = spawnSync(verifier, args, { env, encoding: 'utf8' });
  assert.equal(disabled.status, 1); assert.match(disabled.stderr, /trust is not provisioned/);
  console.log('Native signer/verifier interop, legacy Stable, cross-channel rejection, tamper and unprovisioned trust checks passed.');
} finally { rmSync(root, { recursive: true, force: true }); }
