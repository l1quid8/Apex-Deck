import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stubNodeCommand } from './helpers/node-command-stub.mjs';
import { readStamp, stampEnv } from '../scripts/build-stamp.mjs';
import { assertCheckoutUnchanged, resolvePinnedCheckout } from '../scripts/package-pinned.mjs';

const PACKAGE_PINNED = fileURLToPath(new URL('../scripts/package-pinned.mjs', import.meta.url));

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const ui = '6c5a1f110fa5';
const service = '2f43c919e683';
// git that answers like the moved branch did: whatever it is asked, it says
// the *other* commit, which is what made one package carry two labels.
const gitSaying = (value) => (args) => (args[0] === 'rev-parse' ? value : '');

test('a pinned commit wins over what the checkout currently says', () => {
  const stamp = readStamp({ env: { APEX_BUILD_COMMIT: ui }, git: gitSaying(service) });
  assert.equal(stamp.commit, ui, 'the exported commit must be copied, not re-resolved from git');
});

test('the pinned dirty flag wins too, so both sides agree on -dirty', () => {
  const stamp = readStamp({ env: { APEX_BUILD_COMMIT: ui, APEX_BUILD_DIRTY: 'true' }, git: gitSaying(ui) });
  assert.equal(stamp.dirty, true);
  assert.equal(readStamp({ env: { APEX_BUILD_COMMIT: ui, APEX_BUILD_DIRTY: 'false' }, git: gitSaying(ui) }).dirty, false);
});

test('with nothing pinned it still falls back to git', () => {
  assert.equal(readStamp({ env: {}, git: gitSaying(service) }).commit, service);
  assert.equal(readStamp({ env: {}, git: () => null }).commit, 'unknown');
  assert.equal(readStamp({ env: { APEX_BUILD_COMMIT: '   ' }, git: gitSaying(service) }).commit, service, 'blank is not a pin');
});

test('stampEnv hands both toolchains the same value', () => {
  const env = stampEnv({ commit: ui, dirty: false }, { PATH: '/usr/bin' });
  assert.equal(env.APEX_BUILD_COMMIT, ui);
  assert.equal(env.APEX_BUILD_DIRTY, 'false');
  assert.equal(env.PATH, '/usr/bin', 'the rest of the environment is preserved');
});

test('both stampers read the pin instead of asking git on their own', () => {
  const vite = read('vite.config.ts');
  const buildRs = read('crates/apex-daemon/build.rs');
  assert.match(vite, /APEX_BUILD_COMMIT/, 'vite.config.ts must accept the pinned commit');
  assert.match(buildRs, /APEX_BUILD_COMMIT/, 'apex-daemon/build.rs must accept the pinned commit');
  // Without rerun-if-env-changed cargo keeps the previous stamp on a re-run.
  assert.match(buildRs, /rerun-if-env-changed=APEX_BUILD_COMMIT/);
});

test('packaging cannot bypass the pin', () => {
  const scripts = JSON.parse(read('package.json')).scripts;
  assert.match(scripts['desktop:package'], /package-pinned\.mjs/);
  assert.match(scripts['desktop:dmg'], /package-pinned\.mjs/);
  assert.match(scripts['_desktop:package'], /package-mac\.mjs/, 'the unpinned body still packages in place');
  assert.ok(!/--dir/.test(scripts['_desktop:package']), '--dir belongs to the pinned entry point so both use one body');
});

test('checkout identity compares full 40-char SHAs and accepts the full SHA passed by CI', () => {
  const fullA = '41702564203e86e178dedda3887abc117a13d246';
  // Same 12-char prefix as fullA, different full SHA.
  const fullSamePrefix = '41702564203e0000000000000000000000000000';
  const fullB = '11c1ade33ad9f6dc2d80ff32a68e159d501fde38';

  const fakeGit = (head) => (args) => {
    if (args[0] === 'rev-parse' && args.includes('--verify')) return head;
    if (args[0] === 'rev-parse' && args.includes('--short=12')) return head.slice(0, 12);
    return '';
  };

  // Exact CI environment: full 40-char APEX_BUILD_COMMIT matching stationary HEAD.
  const ciEnv = {
    APEX_CHANNEL: 'nightly',
    APEX_BUILD_NUMBER: '42',
    APEX_NIGHTLY_DATE: '20261124',
    APEX_BUILD_COMMIT: fullA,
  };
  const resolved = resolvePinnedCheckout({ env: ciEnv, git: fakeGit(fullA) });
  assert.equal(resolved.fullCommit, fullA);
  assert.equal(resolved.stamp.commit, fullA.slice(0, 12));
  assert.equal(resolved.stamp.dirty, false);
  assert.equal(assertCheckoutUnchanged(resolved.fullCommit, { git: fakeGit(fullA) }), fullA);

  // Moving HEAD to a different commit — even with the same 12-char prefix — fails closed.
  assert.throws(
    () => assertCheckoutUnchanged(resolved.fullCommit, { git: fakeGit(fullSamePrefix) }),
    new RegExp(`checkout moved during the build \\(${fullA} -> ${fullSamePrefix}\\)`),
  );

  // Mismatched full 40-char pin fails closed before building.
  assert.throws(
    () => resolvePinnedCheckout({ env: { APEX_BUILD_COMMIT: fullB }, git: fakeGit(fullA) }),
    /does not match checkout HEAD/,
  );

  // Short 12-char prefix matching HEAD still works.
  const shortResolved = resolvePinnedCheckout({ env: { APEX_BUILD_COMMIT: fullA.slice(0, 12) }, git: fakeGit(fullA) });
  assert.equal(shortResolved.fullCommit, fullA);
  assert.equal(shortResolved.stamp.commit, fullA.slice(0, 12));
});

test('package-pinned succeeds on a stationary checkout under the exact Nightly CI env and fails if HEAD moves', () => {
  const dir = mkdtempSync(join(tmpdir(), 'apex-package-pinned-ci-'));
  try {
    const repo = join(dir, 'repo');
    mkdirSync(repo, { recursive: true });

    const runGit = (args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
    runGit(['init', '-q']);
    runGit(['config', 'user.email', 'test@example.com']);
    runGit(['config', 'user.name', 'Test']);
    writeFileSync(join(repo, 'README.md'), 'v1\n');
    runGit(['add', 'README.md']);
    runGit(['commit', '-qm', 'initial']);
    const head = runGit(['rev-parse', '--verify', 'HEAD']);

    // Mock `npm` creates a stamped stub Nightly .app in release/mac-arm64/ and
    // optionally advances git HEAD when MOCK_ADVANCE_HEAD=1.
    const capturedEnvFile = join(dir, 'captured-env.json');
    const stubArgs = stubNodeCommand(dir, 'npm', `
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const commit = process.env.APEX_BUILD_COMMIT || '';
const buildNumber = process.env.APEX_BUILD_NUMBER || '';
fs.writeFileSync(${JSON.stringify(capturedEnvFile)}, JSON.stringify({
  APEX_CHANNEL: process.env.APEX_CHANNEL,
  APEX_BUILD_COMMIT: commit,
  APEX_BUILD_NUMBER: buildNumber,
  APEX_NIGHTLY_DATE: process.env.APEX_NIGHTLY_DATE,
  APEX_BUILD_DIRTY: process.env.APEX_BUILD_DIRTY,
}));
const app = path.resolve('release/mac-arm64/Apex Deck Nightly.app');
fs.mkdirSync(path.join(app, 'Contents/Resources/bin'), { recursive: true });
// The native Info.plist verification uses macOS plutil.
if (process.platform === 'darwin') fs.writeFileSync(path.join(app, 'Contents/Info.plist'), [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
  '<plist version="1.0"><dict>',
  '<key>CFBundleIdentifier</key><string>dev.apexdeck.app.nightly</string>',
  '<key>CFBundleShortVersionString</key><string>0.9.19</string>',
  '<key>CFBundleVersion</key><string>' + buildNumber + '</string>',
  '</dict></plist>',
].join('\\n'));
fs.writeFileSync(path.join(app, 'Contents/Resources/app.asar'), 'ui ' + commit);
fs.writeFileSync(path.join(app, 'Contents/Resources/bin/apex-daemon'), 'apex-build-commit=' + commit + ';');
if (process.env.MOCK_ADVANCE_HEAD === '1') {
  fs.writeFileSync('README.md', 'v2\\n');
  execFileSync('git', ['add', 'README.md']);
  execFileSync('git', ['commit', '-qm', 'moved']);
}
`);

    const ciEnv = {
      ...process.env,
      APEX_CHANNEL: 'nightly',
      APEX_BUILD_NUMBER: '42',
      APEX_NIGHTLY_DATE: '20261124',
      APEX_BUILD_COMMIT: head,
      APEX_DECK_SKIP_PKG: '1',
    };

    // 1. Stationary checkout with full 40-char CI APEX_BUILD_COMMIT must pass.
    const ok = spawnSync(process.execPath, [...stubArgs, PACKAGE_PINNED], { cwd: repo, env: ciEnv, encoding: 'utf8' });
    assert.equal(ok.status, 0, `expected exit 0, got ${ok.status}:\nstdout: ${ok.stdout}\nstderr: ${ok.stderr}`);
    const captured = JSON.parse(readFileSync(capturedEnvFile, 'utf8'));
    assert.equal(captured.APEX_CHANNEL, 'nightly');
    assert.equal(captured.APEX_BUILD_NUMBER, '42');
    assert.equal(captured.APEX_NIGHTLY_DATE, '20261124');
    assert.equal(captured.APEX_BUILD_COMMIT, head.slice(0, 12));
    assert.equal(captured.APEX_BUILD_DIRTY, 'false');

    // 2. If HEAD moves during the build, package-pinned must fail with full SHAs.
    const moved = spawnSync(process.execPath, [...stubArgs, PACKAGE_PINNED], {
      cwd: repo,
      env: { ...ciEnv, MOCK_ADVANCE_HEAD: '1' },
      encoding: 'utf8',
    });
    assert.equal(moved.status, 1, 'moved checkout must fail');
    const newHead = runGit(['rev-parse', '--verify', 'HEAD']);
    assert.match(moved.stderr, new RegExp(`the checkout moved during the build \\(${head} -> ${newHead}\\)`));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
