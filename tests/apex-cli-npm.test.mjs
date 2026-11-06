import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, existsSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function runLauncher({ standaloneDir, platformDir, args = [], env = {} }) {
  const launcher = join(process.cwd(), 'npm/cli/bin/apex');
  const result = spawnSync('/bin/sh', [launcher, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      APEX_CLI_NPM_TEST: '1',
      APEX_CLI_NPM_TEST_STANDALONE: standaloneDir,
      APEX_CLI_NPM_TEST_PLATFORM: platformDir,
      ...env,
    },
  });
  return result;
}

function makeManifest(dir, version) {
  const manifest = {
    formatVersion: 1,
    product: 'apex-cli',
    version,
    architecture: 'arm64',
    files: [
      { name: 'apex', sha256: 'a'.repeat(64) },
      { name: 'apex-daemon', sha256: 'b'.repeat(64) },
      { name: 'apex-provenance', sha256: 'c'.repeat(64) },
    ],
  };
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest) + '\n');
}

function makeFakeApex(dir) {
  const p = join(dir, 'apex');
  writeFileSync(p, '#!/bin/sh\necho "FAKE_APEX_EXECUTED:$@"\n', { mode: 0o755 });
  chmodSync(p, 0o755);
}

test('launcher prints setup hint when nothing installed', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'apex-npm-'));
  const plat = mkdtempSync(join(tmpdir(), 'apex-npm-plat-'));
  const standalone = join(tmp, 'Prov');
  mkdirSync(standalone, { recursive: true });
  makeManifest(plat, '0.9.8');
  // No standalone manifest
  const res = runLauncher({ standaloneDir: standalone, platformDir: plat, args: [] });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /One-time setup needs your admin password/);
  assert.match(res.stderr, /sudo .* setup/);
  rmSync(tmp, { recursive: true, force: true });
  rmSync(plat, { recursive: true, force: true });
});

test('launcher detects older installed and asks for update', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'apex-npm-'));
  const plat = mkdtempSync(join(tmpdir(), 'apex-npm-plat-'));
  const standaloneRoot = join(tmp, 'Prov');
  const standalone = join(standaloneRoot, 'Standalone');
  mkdirSync(standalone, { recursive: true });
  // installed older
  writeFileSync(join(standaloneRoot, 'Standalone', 'manifest.json'), JSON.stringify({ version: '0.9.7' }) + '\n');
  // also need apex file exists for launcher to consider installed? Actually launcher checks standalone_root/apex existence, but we override standalone dir to be root, not Standalone? Our override is provenance root, so standalone is root/Standalone. We set standaloneDir to root, so launcher looks at root/Standalone/manifest.
  // Let's set correctly: standaloneDir is prov_root, launcher looks at prov_root/Standalone/manifest
  // So we need manifest at standalone/Standalone/manifest? Wait we made standaloneRoot = prov root, with subdir Standalone containing manifest at .../Standalone/manifest -> that's what we wrote? Actually we wrote at Standalone/manifest inside standaloneRoot? We wrote at join(standaloneRoot, 'Standalone', 'manifest.json') which is correct if standaloneDir = standaloneRoot.
  makeFakeApex(standalone);
  makeManifest(plat, '0.9.8');
  // The platform manifest version is 0.9.8, installed is 0.9.7, so update available
  const res = runLauncher({ standaloneDir: standaloneRoot, platformDir: plat, args: [] });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /update available/i);
  rmSync(tmp, { recursive: true, force: true });
  rmSync(plat, { recursive: true, force: true });
});

test('launcher refuses when installed newer than package', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'apex-npm-'));
  const plat = mkdtempSync(join(tmpdir(), 'apex-npm-plat-'));
  const provRoot = join(tmp, 'Prov');
  const st = join(provRoot, 'Standalone');
  mkdirSync(st, { recursive: true });
  writeFileSync(join(st, 'manifest.json'), JSON.stringify({ version: '0.9.9' }) + '\n');
  makeFakeApex(st);
  makeManifest(plat, '0.9.8');
  const res = runLauncher({ standaloneDir: provRoot, platformDir: plat, args: [] });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /newer than this npm package/i);
  rmSync(tmp, { recursive: true, force: true });
  rmSync(plat, { recursive: true, force: true });
});

test('launcher execs trusted binary when versions match', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'apex-npm-'));
  const plat = mkdtempSync(join(tmpdir(), 'apex-npm-plat-'));
  const provRoot = join(tmp, 'Prov');
  const st = join(provRoot, 'Standalone');
  mkdirSync(st, { recursive: true });
  // Both manifests must have matching file hashes for hash-aware launcher to exec
  const files = [
    { name: 'apex', sha256: 'a'.repeat(64) },
    { name: 'apex-daemon', sha256: 'b'.repeat(64) },
    { name: 'apex-provenance', sha256: 'c'.repeat(64) },
  ];
  writeFileSync(join(st, 'manifest.json'), JSON.stringify({ version: '0.9.8', files }) + '\n');
  makeFakeApex(st);
  writeFileSync(join(plat, 'manifest.json'), JSON.stringify({
    formatVersion: 1, product: 'apex-cli', version: '0.9.8', architecture: 'arm64', files
  }) + '\n');
  const res = runLauncher({ standaloneDir: provRoot, platformDir: plat, args: ['--version'] });
  if (res.status !== 0) {
    console.error('stderr:', res.stderr, 'stdout:', res.stdout);
  }
  assert.equal(res.status, 0);
  assert.match(res.stdout, /FAKE_APEX_EXECUTED/);
  rmSync(tmp, { recursive: true, force: true });
  rmSync(plat, { recursive: true, force: true });
});

test('launcher finds platform dir via sibling layout', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'apex-npm-'));
  // Simulate npm global layout: node_modules/@apex-deck/cli and cli-darwin-arm64
  const nodeModules = join(tmp, 'node_modules', '@apex-deck');
  const cliRoot = join(nodeModules, 'cli');
  const platRoot = join(nodeModules, 'cli-darwin-arm64');
  mkdirSync(join(cliRoot, 'bin'), { recursive: true });
  mkdirSync(platRoot, { recursive: true });
  // copy launcher
  const srcLauncher = join(process.cwd(), 'npm/cli/bin/apex');
  const dstLauncher = join(cliRoot, 'bin', 'apex');
  const content = readFileSync(srcLauncher, 'utf8');
  writeFileSync(dstLauncher, content, { mode: 0o755 });
  chmodSync(dstLauncher, 0o755);
  const files = [
    { name: 'apex', sha256: 'a'.repeat(64) },
    { name: 'apex-daemon', sha256: 'b'.repeat(64) },
    { name: 'apex-provenance', sha256: 'c'.repeat(64) },
  ];
  writeFileSync(join(platRoot, 'manifest.json'), JSON.stringify({
    formatVersion: 1, product: 'apex-cli', version: '0.9.8', architecture: 'arm64', files
  }) + '\n');
  const provRoot = join(tmp, 'Prov');
  const st = join(provRoot, 'Standalone');
  mkdirSync(st, { recursive: true });
  writeFileSync(join(st, 'manifest.json'), JSON.stringify({ version: '0.9.8', files }) + '\n');
  makeFakeApex(st);
  // Run without test env overrides to exercise sibling discovery
  const res = spawnSync('/bin/sh', [dstLauncher, '--version'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      APEX_CLI_NPM_TEST: '1',
      APEX_CLI_NPM_TEST_STANDALONE: provRoot,
      // No platform override, should find via sibling
    },
  });
  assert.equal(res.status, 0);
  assert.match(res.stdout, /FAKE_APEX_EXECUTED/);
  rmSync(tmp, { recursive: true, force: true });
});

test('installer flags --no-path-link and --uninstall are recognized', () => {
  const src = join(process.cwd(), 'scripts/install-cli-provenance.sh');
  const content = readFileSync(src, 'utf8');
  assert.match(content, /--no-path-link/);
  assert.match(content, /--uninstall/);
  assert.match(content, /is_upgrade/);
  assert.match(content, /already at version/i);
});

test('launcher asks for update when same version but different build (hash mismatch)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'apex-npm-'));
  const plat = mkdtempSync(join(tmpdir(), 'apex-npm-plat-'));
  const provRoot = join(tmp, 'Prov');
  const st = join(provRoot, 'Standalone');
  mkdirSync(st, { recursive: true });
  // Installed manifest with hash AAA
  writeFileSync(join(st, 'manifest.json'), JSON.stringify({
    version: '0.9.8',
    files: [{ name: 'apex', sha256: 'a'.repeat(64) }]
  }) + '\n');
  makeFakeApex(st);
  // Package manifest with different hash BBB but same version
  writeFileSync(join(plat, 'manifest.json'), JSON.stringify({
    formatVersion: 1, product: 'apex-cli', version: '0.9.8', architecture: 'arm64',
    files: [{ name: 'apex', sha256: 'b'.repeat(64) }]
  }) + '\n');
  const res = runLauncher({ standaloneDir: provRoot, platformDir: plat, args: [] });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /update available/i);
  rmSync(tmp, { recursive: true, force: true });
  rmSync(plat, { recursive: true, force: true });
});

test('platform package contains required files in manifest contract and npm files list includes apex-provenance', () => {
  const releaseDir = join(process.cwd(), 'release');
  const platPkg = join(process.cwd(), 'npm/cli-darwin-arm64/package.json');
  const pkg = JSON.parse(readFileSync(platPkg, 'utf8'));
  assert.ok(pkg.files.includes('apex-provenance'), 'npm files list must include apex-provenance');
  if (!existsSync(releaseDir)) return;
  const pkgs = readFileSync(join(process.cwd(), 'package.json'), 'utf8');
  const version = JSON.parse(pkgs).version;
  const signedDir = join(releaseDir, `Apex-CLI_${version}_arm64`);
  if (!existsSync(signedDir)) return;
  const manifest = JSON.parse(readFileSync(join(signedDir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.product, 'apex-cli');
  assert.equal(manifest.files.length, 3);
  for (const f of manifest.files) {
    assert.match(f.sha256, /^[a-f0-9]{64}$/);
    assert.ok(existsSync(join(signedDir, f.name)), `missing ${f.name}`);
  }
  // Archive content check: tgz must actually contain apex-provenance
  const tgzPath = join(releaseDir, `apex-deck-cli-darwin-arm64-${version}.tgz`);
  if (!existsSync(tgzPath)) return;
  const list = spawnSync('/usr/bin/tar', ['-tzf', tgzPath], { encoding: 'utf8' });
  if (list.status === 0) {
    const entries = list.stdout;
    assert.match(entries, /apex-provenance/, 'tgz archive must contain apex-provenance');
    assert.match(entries, /install-cli-provenance\.sh/);
  }
});
