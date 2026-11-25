import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { stubNodeCommand } from './helpers/node-command-stub.mjs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import {
  NIGHTLY_MANIFEST_NAME,
  expectedDmgNames,
  fetchCurrentFeed,
  fetchGitHubState,
  formatNightlyTag,
  parseNightlyFeed,
  pickGreenMainCommit,
  planNightlyRelease,
  publishNightlyRelease,
  resolveRequiredDmgs,
  verifyAssetFiles,
} from '../scripts/nightly-release.mjs';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml');
const SCRIPT = fileURLToPath(new URL('../scripts/nightly-release.mjs', import.meta.url));

const SHA_OLD = '11c1ade33ad9f6dc2d80ff32a68e159d501fde38';
const SHA_NEW = '41702564203e86e178dedda3887abc117a13d246';
const SHA_FAIL = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

function makeFixture({
  commit = SHA_NEW,
  date = '20261124',
  buildNumber = 43,
  version = '0.9.19',
  withDmg = true,
} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-nightly-release-'));
  const assetsDir = path.join(dir, 'assets');
  const dmgDir = path.join(dir, 'release');
  fs.mkdirSync(assetsDir, { recursive: true });
  fs.mkdirSync(dmgDir, { recursive: true });
  const tag = formatNightlyTag(date, commit);
  const pkgName = `Apex-Deck-Nightly_${date}_${commit.slice(0, 7)}_arm64.pkg`;
  const dmgName = `Apex-Deck-Nightly_${date}_${commit.slice(0, 7)}_arm64.dmg`;
  const pkgBytes = Buffer.from(`fake-pkg-${tag}-${buildNumber}`);
  const dmgBytes = Buffer.from(`fake-dmg-${tag}-${buildNumber}`);
  const armBytes = Buffer.from(`fake-linux-arm64-${tag}-${buildNumber}`);
  const x64Bytes = Buffer.from(`fake-linux-x86_64-${tag}-${buildNumber}`);
  fs.writeFileSync(path.join(assetsDir, pkgName), pkgBytes);
  fs.writeFileSync(path.join(assetsDir, 'apex-daemon-nightly-linux-arm64'), armBytes);
  fs.writeFileSync(path.join(assetsDir, 'apex-daemon-nightly-linux-x86_64'), x64Bytes);
  const dmgPath = path.join(dmgDir, dmgName);
  if (withDmg) fs.writeFileSync(dmgPath, dmgBytes);
  const manifest = {
    schemaVersion: 1,
    channel: 'nightly',
    version,
    buildNumber,
    commit,
    tag,
    notes: `Nightly build ${buildNumber}`,
    packages: [{
      arch: 'arm64',
      minimumSystemVersion: '13.0',
      name: pkgName,
      size: pkgBytes.length,
      sha256: sha256(pkgBytes),
    }],
    daemons: [
      { arch: 'arm64', name: 'apex-daemon-nightly-linux-arm64', size: armBytes.length, sha256: sha256(armBytes) },
      { arch: 'x86_64', name: 'apex-daemon-nightly-linux-x86_64', size: x64Bytes.length, sha256: sha256(x64Bytes) },
    ],
  };
  const manifestPath = path.join(assetsDir, NIGHTLY_MANIFEST_NAME);
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { dir, assetsDir, dmgDir, manifestPath, manifest, pkgName, dmgName, dmgPath, dmgBytes };
}

test('pickGreenMainCommit chooses only the newest completed green push on main', () => {
  const runs = [
    { id: 105, head_branch: 'main', event: 'push', status: 'in_progress', conclusion: null, head_sha: SHA_FAIL, created_at: '2026-11-24T07:50:00Z' },
    { id: 104, head_branch: 'main', event: 'push', status: 'completed', conclusion: 'failure', head_sha: SHA_FAIL, created_at: '2026-11-24T07:40:00Z' },
    { id: 103, head_branch: 'feat/other', event: 'push', status: 'completed', conclusion: 'success', head_sha: SHA_FAIL, created_at: '2026-11-24T07:30:00Z' },
    { id: 102, head_branch: 'main', event: 'push', status: 'completed', conclusion: 'success', head_sha: SHA_NEW, created_at: '2026-11-24T07:20:00Z' },
    { id: 101, head_branch: 'main', event: 'push', status: 'completed', conclusion: 'success', head_sha: SHA_OLD, created_at: '2026-11-23T07:20:00Z' },
  ];
  assert.deepEqual(pickGreenMainCommit(runs), { commit: SHA_NEW, runId: 102, createdAt: '2026-11-24T07:20:00Z' });
  assert.equal(pickGreenMainCommit(runs, { targetSha: SHA_FAIL }), null);
  assert.equal(pickGreenMainCommit(runs, { targetSha: SHA_OLD })?.commit, SHA_OLD);
});

test('planNightlyRelease skips an unchanged green main SHA and advances buildNumber when main changes', () => {
  const prev = makeFixture({ commit: SHA_OLD, date: '20261123', buildNumber: 42 });
  try {
    const runsUnchanged = [
      { id: 201, head_branch: 'main', event: 'push', status: 'completed', conclusion: 'failure', head_sha: SHA_FAIL, created_at: '2026-11-24T07:00:00Z' },
      { id: 200, head_branch: 'main', event: 'push', status: 'completed', conclusion: 'success', head_sha: SHA_OLD, created_at: '2026-11-23T07:00:00Z' },
    ];
    const skipped = planNightlyRelease({ runs: runsUnchanged, currentFeed: prev.manifest, date: '20261124' });
    assert.equal(skipped.shouldBuild, false);
    assert.equal(skipped.reason, 'unchanged');
    assert.equal(skipped.commit, SHA_OLD);
    assert.equal(skipped.buildNumber, 42);

    const forced = planNightlyRelease({ runs: runsUnchanged, currentFeed: prev.manifest, date: '20261124', force: true });
    assert.equal(forced.shouldBuild, true);
    assert.equal(forced.reason, 'forced');
    assert.equal(forced.buildNumber, 43);

    const runsChanged = [
      { id: 202, head_branch: 'main', event: 'push', status: 'completed', conclusion: 'success', head_sha: SHA_NEW, created_at: '2026-11-24T07:30:00Z' },
      ...runsUnchanged,
    ];
    const planned = planNightlyRelease({ runs: runsChanged, currentFeed: prev.manifest, date: '20261124' });
    assert.equal(planned.shouldBuild, true);
    assert.equal(planned.reason, 'changed');
    assert.equal(planned.commit, SHA_NEW);
    assert.equal(planned.buildNumber, 43);
    assert.equal(planned.tag, 'nightly-20261124-4170256');
  } finally {
    fs.rmSync(prev.dir, { recursive: true, force: true });
  }
});

test('dry-run CLI skips an unchanged green main SHA and writes should_build=false', () => {
  const prev = makeFixture({ commit: SHA_OLD, date: '20261123', buildNumber: 42 });
  try {
    const stateFile = path.join(prev.dir, 'state.json');
    const outFile = path.join(prev.dir, 'github-output.txt');
    fs.writeFileSync(stateFile, JSON.stringify({
      runs: [{ id: 300, head_branch: 'main', event: 'push', status: 'completed', conclusion: 'success', head_sha: SHA_OLD, created_at: '2026-11-24T01:00:00Z' }],
      currentFeed: prev.manifest,
    }));
    const res = spawnSync(process.execPath, [
      SCRIPT, 'plan',
      '--state-file', stateFile,
      '--date', '20261124',
      '--github-output', outFile,
      '--dry-run',
    ], { encoding: 'utf8' });
    assert.equal(res.status, 0, res.stderr);
    const parsed = JSON.parse(res.stdout);
    assert.equal(parsed.shouldBuild, false);
    assert.equal(parsed.reason, 'unchanged');
    const outputs = fs.readFileSync(outFile, 'utf8');
    assert.match(outputs, /^should_build=false$/m);
    assert.match(outputs, /^reason=unchanged$/m);
  } finally {
    fs.rmSync(prev.dir, { recursive: true, force: true });
  }
});

test('dry-run publish holds the rolling Nightly feed when local or downloaded asset verification fails', () => {
  const prev = makeFixture({ commit: SHA_OLD, date: '20261123', buildNumber: 42 });
  const next = makeFixture({ commit: SHA_NEW, date: '20261124', buildNumber: 43 });
  try {
    // 1. Clean dry run uploads + downloads packages, daemons, and required DMG, and never touches --latest.
    const clean = publishNightlyRelease({
      manifestPath: next.manifestPath,
      assetsDir: next.assetsDir,
      dmgDir: next.dmgDir,
      currentFeed: prev.manifest,
      dryRun: true,
    });
    assert.equal(clean.published, true);
    assert.equal(clean.feedAdvanced, true);
    const flatClean = clean.commands.map((args) => args.join(' ')).join('\n');
    assert.doesNotMatch(flatClean, /--latest/);
    assert.match(flatClean, new RegExp(`release upload nightly-20261124-4170256 .*${next.dmgName.replaceAll('.', '\\.')}`));
    assert.match(flatClean, new RegExp(`release download nightly-20261124-4170256 .*--pattern ${next.dmgName.replaceAll('.', '\\.')}`));
    assert.match(flatClean, /gh release edit nightly-20261124-4170256 .*--draft=false --prerelease/);
    assert.match(flatClean, /gh release upload nightly .*apex-deck-nightly-update\.json/);

    // 2. Tampered post-upload pkg download check holds the rolling feed and refuses --draft=false.
    const badDownloadDir = path.join(next.dir, 'bad-download');
    fs.cpSync(next.assetsDir, badDownloadDir, { recursive: true });
    fs.copyFileSync(next.dmgPath, path.join(badDownloadDir, next.dmgName));
    fs.writeFileSync(path.join(badDownloadDir, next.pkgName), Buffer.from('corrupted-pkg-bytes'));
    const heldDownload = publishNightlyRelease({
      manifestPath: next.manifestPath,
      assetsDir: next.assetsDir,
      dmgDir: next.dmgDir,
      currentFeed: prev.manifest,
      dryRun: true,
      verifyDir: badDownloadDir,
    });
    assert.equal(heldDownload.published, false);
    assert.equal(heldDownload.feedAdvanced, false);
    assert.equal(heldDownload.stage, 'download-verify');
    assert.ok(heldDownload.errors.some((line) => line.includes(next.pkgName)));
    const flatHeld = heldDownload.commands.map((args) => args.join(' ')).join('\n');
    assert.doesNotMatch(flatHeld, /--draft=false/, 'must not publish immutable tag after failed verification');
    assert.doesNotMatch(flatHeld, /release upload nightly --repo/, 'must hold rolling nightly feed after failed verification');
    assert.doesNotMatch(flatHeld, /apex-deck-nightly-update\.json/, 'must not upload rolling feed manifest after failed verification');

    // 3. CLI dry-run against corrupted verifyDir exits nonzero and holds the feed.
    const prevFeedFile = path.join(prev.dir, 'prev-feed.json');
    fs.writeFileSync(prevFeedFile, JSON.stringify(prev.manifest));
    const cli = spawnSync(process.execPath, [
      SCRIPT, 'publish',
      '--assets-dir', next.assetsDir,
      '--extra-dir', next.dmgDir,
      '--manifest', next.manifestPath,
      '--current-feed', prevFeedFile,
      '--verify-dir', badDownloadDir,
      '--dry-run',
    ], { encoding: 'utf8' });
    assert.notEqual(cli.status, 0, 'failed asset verification must exit nonzero');
    assert.match(cli.stderr, /Nightly feed held at download-verify/);
    const cliOut = JSON.parse(cli.stdout);
    assert.equal(cliOut.feedAdvanced, false);

    // 4. Local missing daemon holds the feed before creating any release.
    fs.rmSync(path.join(next.assetsDir, 'apex-daemon-nightly-linux-arm64'));
    const heldLocal = publishNightlyRelease({
      manifestPath: next.manifestPath,
      assetsDir: next.assetsDir,
      dmgDir: next.dmgDir,
      currentFeed: prev.manifest,
      dryRun: true,
    });
    assert.equal(heldLocal.published, false);
    assert.equal(heldLocal.feedAdvanced, false);
    assert.equal(heldLocal.stage, 'local-verify');
    assert.deepEqual(heldLocal.commands, []);
  } finally {
    fs.rmSync(prev.dir, { recursive: true, force: true });
    fs.rmSync(next.dir, { recursive: true, force: true });
  }
});

test('parseNightlyFeed and verifyAssetFiles reject non-Nightly feeds and non-monotonic buildNumbers', () => {
  const next = makeFixture({ commit: SHA_NEW, date: '20261124', buildNumber: 42 });
  const prev = makeFixture({ commit: SHA_OLD, date: '20261123', buildNumber: 42 });
  try {
    assert.throws(() => parseNightlyFeed({ ...next.manifest, channel: 'stable' }), /channel mismatch/);
    assert.throws(() => parseNightlyFeed({ ...next.manifest, tag: 'v0.9.19' }), /Invalid immutable Nightly tag/);
    assert.equal(verifyAssetFiles(next.manifest, next.assetsDir).ok, true);
    const nonMonotonic = publishNightlyRelease({
      manifestPath: next.manifestPath,
      assetsDir: next.assetsDir,
      dmgDir: next.dmgDir,
      currentFeed: prev.manifest,
      dryRun: true,
    });
    assert.equal(nonMonotonic.published, false);
    assert.equal(nonMonotonic.feedAdvanced, false);
    assert.equal(nonMonotonic.stage, 'monotonic-check');
  } finally {
    fs.rmSync(next.dir, { recursive: true, force: true });
    fs.rmSync(prev.dir, { recursive: true, force: true });
  }
});

test('expectedDmgNames and resolveRequiredDmgs enforce exact build DMGs and sidecars', () => {
  const next = makeFixture({ commit: SHA_NEW, date: '20261124', buildNumber: 43 });
  try {
    assert.deepEqual(expectedDmgNames(next.manifest), [next.dmgName]);
    const universal = {
      ...next.manifest,
      packages: [
        { ...next.manifest.packages[0], arch: 'arm64', name: 'Apex-Deck-Nightly_20261124_4170256_universal.pkg' },
        { ...next.manifest.packages[0], arch: 'x64', name: 'Apex-Deck-Nightly_20261124_4170256_universal.pkg' },
      ],
    };
    assert.deepEqual(expectedDmgNames(universal), ['Apex-Deck-Nightly_20261124_4170256_universal.dmg']);
    const dual = {
      ...next.manifest,
      packages: [
        next.manifest.packages[0],
        { ...next.manifest.packages[0], arch: 'x64', name: 'Apex-Deck-Nightly_20261124_4170256_x64.pkg' },
      ],
    };
    assert.deepEqual(expectedDmgNames(dual), [
      'Apex-Deck-Nightly_20261124_4170256_arm64.dmg',
      'Apex-Deck-Nightly_20261124_4170256_x64.dmg',
    ]);

    const ok = resolveRequiredDmgs(next.manifest, { assetsDir: next.assetsDir, dmgDir: next.dmgDir });
    assert.equal(ok.ok, true);
    assert.equal(ok.dmgs.length, 1);
    assert.equal(ok.dmgs[0].name, next.dmgName);
    assert.equal(ok.dmgs[0].size, next.dmgBytes.length);
    assert.equal(ok.dmgs[0].sha256, sha256(next.dmgBytes));

    // Matching .sha256 sidecar passes; mismatched sidecar fails closed.
    const sidecar = `${next.dmgPath}.sha256`;
    fs.writeFileSync(sidecar, `${sha256(next.dmgBytes)}  ${next.dmgName}\n`);
    assert.equal(resolveRequiredDmgs(next.manifest, { assetsDir: next.assetsDir, dmgDir: next.dmgDir }).ok, true);
    fs.writeFileSync(sidecar, `${'0'.repeat(64)}  ${next.dmgName}\n`);
    const badSidecar = resolveRequiredDmgs(next.manifest, { assetsDir: next.assetsDir, dmgDir: next.dmgDir });
    assert.equal(badSidecar.ok, false);
    assert.match(badSidecar.errors[0], /checksum sidecar mismatch/);
    fs.rmSync(sidecar);

    // Empty DMG fails closed.
    fs.writeFileSync(next.dmgPath, Buffer.alloc(0));
    const emptyDmg = resolveRequiredDmgs(next.manifest, { assetsDir: next.assetsDir, dmgDir: next.dmgDir });
    assert.equal(emptyDmg.ok, false);
    assert.match(emptyDmg.errors[0], /Invalid size/);
  } finally {
    fs.rmSync(next.dir, { recursive: true, force: true });
  }
});

test('publish requires the expected Nightly DMG and holds the feed when missing or from another build', () => {
  const prev = makeFixture({ commit: SHA_OLD, date: '20261123', buildNumber: 42 });
  const next = makeFixture({ commit: SHA_NEW, date: '20261124', buildNumber: 43, withDmg: false });
  try {
    // 1. Omitting DMG completely must hold the feed at local-verify with zero gh calls.
    const missing = publishNightlyRelease({
      manifestPath: next.manifestPath,
      assetsDir: next.assetsDir,
      dmgDir: next.dmgDir,
      currentFeed: prev.manifest,
      dryRun: true,
    });
    assert.equal(missing.published, false);
    assert.equal(missing.feedAdvanced, false);
    assert.equal(missing.stage, 'local-verify');
    assert.deepEqual(missing.commands, []);
    assert.ok(missing.errors.some((line) => line.includes(`Missing required dmg asset: ${next.dmgName}`)));

    // 2. Having only an older/other build's DMG in dmgDir must still fail closed.
    fs.writeFileSync(path.join(next.dmgDir, prev.dmgName), Buffer.from('stale-dmg-bytes'));
    const staleOnly = publishNightlyRelease({
      manifestPath: next.manifestPath,
      assetsDir: next.assetsDir,
      dmgDir: next.dmgDir,
      currentFeed: prev.manifest,
      dryRun: false,
      runner: () => { throw new Error('must not invoke gh when required DMG is missing'); },
    });
    assert.equal(staleOnly.published, false);
    assert.equal(staleOnly.feedAdvanced, false);
    assert.equal(staleOnly.stage, 'local-verify');
    assert.deepEqual(staleOnly.commands, []);
    assert.ok(staleOnly.errors.some((line) => line.includes(next.dmgName)));

    // 3. CLI dry-run without the expected DMG exits nonzero and leaves feed unadvanced.
    const prevFeedFile = path.join(prev.dir, 'prev-feed.json');
    fs.writeFileSync(prevFeedFile, JSON.stringify(prev.manifest));
    const cli = spawnSync(process.execPath, [
      SCRIPT, 'publish',
      '--assets-dir', next.assetsDir,
      '--extra-dir', next.dmgDir,
      '--manifest', next.manifestPath,
      '--current-feed', prevFeedFile,
      '--dry-run',
    ], { encoding: 'utf8' });
    assert.notEqual(cli.status, 0, 'missing DMG must fail CLI publish');
    assert.match(cli.stderr, /Nightly feed held at local-verify/);
    assert.equal(JSON.parse(cli.stdout).feedAdvanced, false);
  } finally {
    fs.rmSync(prev.dir, { recursive: true, force: true });
    fs.rmSync(next.dir, { recursive: true, force: true });
  }
});

test('publish verifies downloaded DMG size and SHA-256 before advancing the rolling Nightly feed', () => {
  const prev = makeFixture({ commit: SHA_OLD, date: '20261123', buildNumber: 42 });
  const next = makeFixture({ commit: SHA_NEW, date: '20261124', buildNumber: 43 });
  try {
    const prevFeedFile = path.join(prev.dir, 'prev-feed.json');
    fs.writeFileSync(prevFeedFile, JSON.stringify(prev.manifest));

    // 1. Dry-run verifyDir missing the downloaded DMG holds the feed.
    const missingDownloadDir = path.join(next.dir, 'missing-dmg-download');
    fs.cpSync(next.assetsDir, missingDownloadDir, { recursive: true });
    const missingDl = publishNightlyRelease({
      manifestPath: next.manifestPath,
      assetsDir: next.assetsDir,
      dmgDir: next.dmgDir,
      currentFeed: prev.manifest,
      dryRun: true,
      verifyDir: missingDownloadDir,
    });
    assert.equal(missingDl.published, false);
    assert.equal(missingDl.feedAdvanced, false);
    assert.equal(missingDl.stage, 'download-verify');
    assert.ok(missingDl.errors.some((line) => line.includes(`Missing dmg asset: ${next.dmgName}`)));

    // 2. Dry-run verifyDir with a truncated DMG (size mismatch) holds the feed.
    const badSizeDir = path.join(next.dir, 'bad-dmg-size');
    fs.cpSync(next.assetsDir, badSizeDir, { recursive: true });
    fs.writeFileSync(path.join(badSizeDir, next.dmgName), next.dmgBytes.subarray(0, next.dmgBytes.length - 4));
    const sizeErr = publishNightlyRelease({
      manifestPath: next.manifestPath,
      assetsDir: next.assetsDir,
      dmgDir: next.dmgDir,
      currentFeed: prev.manifest,
      dryRun: true,
      verifyDir: badSizeDir,
    });
    assert.equal(sizeErr.published, false);
    assert.equal(sizeErr.feedAdvanced, false);
    assert.equal(sizeErr.stage, 'download-verify');
    assert.ok(sizeErr.errors.some((line) => line.includes(`Size mismatch for ${next.dmgName}`)));

    // 3. Dry-run verifyDir with same-size bit-flipped DMG (SHA-256 mismatch) holds the feed and exits nonzero via CLI.
    const badShaDir = path.join(next.dir, 'bad-dmg-sha');
    fs.cpSync(next.assetsDir, badShaDir, { recursive: true });
    const flipped = Buffer.from(next.dmgBytes);
    flipped[0] ^= 0xff;
    assert.equal(flipped.length, next.dmgBytes.length);
    fs.writeFileSync(path.join(badShaDir, next.dmgName), flipped);
    const cli = spawnSync(process.execPath, [
      SCRIPT, 'publish',
      '--assets-dir', next.assetsDir,
      '--extra-dir', next.dmgDir,
      '--manifest', next.manifestPath,
      '--current-feed', prevFeedFile,
      '--verify-dir', badShaDir,
      '--dry-run',
    ], { encoding: 'utf8' });
    assert.notEqual(cli.status, 0, 'corrupted DMG download must fail CLI publish');
    assert.match(cli.stderr, /Nightly feed held at download-verify/);
    const cliOut = JSON.parse(cli.stdout);
    assert.equal(cliOut.feedAdvanced, false);
    assert.ok(cliOut.errors.some((line) => line.includes(`SHA-256 mismatch for ${next.dmgName}`)));

    // 4. Live-mode runner: corrupted DMG download (wrong size AND same-size flipped bytes) holds feed; clean download advances feed.
    for (const [label, corruptBytes, expectedPattern] of [
      ['size', Buffer.from('short'), /Size mismatch/],
      ['sha256', flipped, /SHA-256 mismatch/],
    ]) {
      const seen = [];
      const held = publishNightlyRelease({
        manifestPath: next.manifestPath,
        assetsDir: next.assetsDir,
        dmgDir: next.dmgDir,
        currentFeed: prev.manifest,
        dryRun: false,
        runner: (_cmd, args) => {
          seen.push(args.join(' '));
          if (args[0] === 'release' && args[1] === 'view') return { status: 1, stdout: '', stderr: 'release not found' };
          if (args[0] === 'release' && args[1] === 'download') {
            const dir = args[args.indexOf('--dir') + 1];
            const pattern = args[args.indexOf('--pattern') + 1];
            const payload = pattern === next.dmgName
              ? corruptBytes
              : fs.readFileSync(path.join(next.assetsDir, pattern));
            fs.writeFileSync(path.join(dir, pattern), payload);
            return { status: 0, stdout: '', stderr: '' };
          }
          return { status: 0, stdout: '', stderr: '' };
        },
      });
      assert.equal(held.published, false, `${label}: must not publish`);
      assert.equal(held.feedAdvanced, false, `${label}: must not advance rolling feed`);
      assert.equal(held.stage, 'download-verify');
      assert.ok(held.errors.some((line) => line.includes(next.dmgName) && expectedPattern.test(line)));
      assert.ok(seen.some((line) => line.includes(`--pattern ${next.dmgName}`)), `${label}: must download DMG for verification`);
      assert.ok(seen.every((line) => !line.includes('--draft=false')), `${label}: must not publish draft`);
      assert.ok(seen.every((line) => !line.includes('release upload nightly --repo') && !line.includes('apex-deck-nightly-update.json')), `${label}: must hold rolling feed`);
    }

    const cleanSeen = [];
    const okLive = publishNightlyRelease({
      manifestPath: next.manifestPath,
      assetsDir: next.assetsDir,
      dmgDir: next.dmgDir,
      currentFeed: prev.manifest,
      dryRun: false,
      runner: (_cmd, args) => {
        cleanSeen.push(args.join(' '));
        if (args[0] === 'release' && args[1] === 'view' && args[2] === next.manifest.tag) {
          return { status: 1, stdout: '', stderr: 'release not found' };
        }
        if (args[0] === 'release' && args[1] === 'view' && args[2] === 'nightly') {
          return { status: 0, stdout: JSON.stringify({ tagName: 'nightly' }), stderr: '' };
        }
        if (args[0] === 'release' && args[1] === 'download') {
          const dir = args[args.indexOf('--dir') + 1];
          const pattern = args[args.indexOf('--pattern') + 1];
          const source = pattern === next.dmgName ? next.dmgPath : path.join(next.assetsDir, pattern);
          fs.writeFileSync(path.join(dir, pattern), fs.readFileSync(source));
          return { status: 0, stdout: '', stderr: '' };
        }
        return { status: 0, stdout: '', stderr: '' };
      },
    });
    assert.equal(okLive.published, true);
    assert.equal(okLive.feedAdvanced, true);
    const dmgUploadIdx = cleanSeen.findIndex((line) => line.includes(`release upload ${next.manifest.tag}`) && line.includes(next.dmgName));
    const dmgDownloadIdx = cleanSeen.findIndex((line) => line.includes(`release download ${next.manifest.tag}`) && line.includes(`--pattern ${next.dmgName}`));
    const publishIdx = cleanSeen.findIndex((line) => line.includes('--draft=false'));
    const feedIdx = cleanSeen.findIndex((line) => line.includes('release upload nightly --repo') && line.includes(NIGHTLY_MANIFEST_NAME));
    assert.ok(dmgUploadIdx >= 0, 'clean publish must upload required DMG');
    assert.ok(dmgDownloadIdx > dmgUploadIdx, 'clean publish must download DMG after upload');
    assert.ok(publishIdx > dmgDownloadIdx, 'clean publish must verify DMG before publishing immutable tag');
    assert.ok(feedIdx > publishIdx, 'clean publish must advance rolling feed after immutable tag is published');
  } finally {
    fs.rmSync(prev.dir, { recursive: true, force: true });
    fs.rmSync(next.dir, { recursive: true, force: true });
  }
});

test('live-mode publish refuses overwriting an immutable published tag and holds feed on bad download', () => {
  const prev = makeFixture({ commit: SHA_OLD, date: '20261123', buildNumber: 42 });
  const next = makeFixture({ commit: SHA_NEW, date: '20261124', buildNumber: 43 });
  try {
    // Already-published immutable tag must never be overwritten.
    const alreadyPublished = publishNightlyRelease({
      manifestPath: next.manifestPath,
      assetsDir: next.assetsDir,
      dmgDir: next.dmgDir,
      currentFeed: prev.manifest,
      dryRun: false,
      runner: (_cmd, args) => {
        if (args[0] === 'release' && args[1] === 'view' && args[2] === next.manifest.tag) {
          return { status: 0, stdout: JSON.stringify({ isDraft: false, isPrerelease: true }), stderr: '' };
        }
        throw new Error(`Unexpected gh call: ${args.join(' ')}`);
      },
    });
    assert.equal(alreadyPublished.published, false);
    assert.equal(alreadyPublished.feedAdvanced, false);
    assert.equal(alreadyPublished.stage, 'immutable-tag');

    // Download-back returns tampered pkg bytes -> must hold feed (no --draft=false, no nightly upload).
    const seen = [];
    const tamperedLive = publishNightlyRelease({
      manifestPath: next.manifestPath,
      assetsDir: next.assetsDir,
      dmgDir: next.dmgDir,
      currentFeed: prev.manifest,
      dryRun: false,
      runner: (_cmd, args) => {
        seen.push(args.join(' '));
        if (args[0] === 'release' && args[1] === 'view') return { status: 1, stdout: '', stderr: 'release not found' };
        if (args[0] === 'release' && args[1] === 'download') {
          const dir = args[args.indexOf('--dir') + 1];
          const pattern = args[args.indexOf('--pattern') + 1];
          const source = pattern === next.dmgName ? next.dmgPath : path.join(next.assetsDir, pattern);
          fs.writeFileSync(path.join(dir, pattern), pattern === next.pkgName ? Buffer.from('bad-download') : fs.readFileSync(source));
          return { status: 0, stdout: '', stderr: '' };
        }
        return { status: 0, stdout: '', stderr: '' };
      },
    });
    assert.equal(tamperedLive.published, false);
    assert.equal(tamperedLive.feedAdvanced, false);
    assert.equal(tamperedLive.stage, 'download-verify');
    assert.ok(seen.every((line) => !line.includes('--draft=false')), 'must not publish draft after failed verify');
    assert.ok(seen.every((line) => !line.includes('release upload nightly --repo') && !line.includes('apex-deck-nightly-update.json')), 'must hold rolling nightly feed');
  } finally {
    fs.rmSync(prev.dir, { recursive: true, force: true });
    fs.rmSync(next.dir, { recursive: true, force: true });
  }
});

test('fetchCurrentFeed starts at build 1 only when feed absence is confirmed and aborts on auth, network, or server errors', () => {
  const prev = makeFixture({ commit: SHA_OLD, date: '20261123', buildNumber: 42 });
  try {
    // 1. Confirmed absent rolling tag (releases list succeeds, tag returns HTTP 404).
    const absentTag = fetchCurrentFeed({
      repo: 'l1quid8/apex-deck',
      runner: (_cmd, args) => {
        if (args[1] === 'repos/l1quid8/apex-deck/releases?per_page=1') {
          return { status: 0, stdout: '[]', stderr: '' };
        }
        if (args[1] === 'repos/l1quid8/apex-deck/releases/tags/nightly') {
          return { status: 1, stdout: '{"message":"Not Found","status":"404"}', stderr: 'gh: Not Found (HTTP 404)' };
        }
        throw new Error(`Unexpected gh call: ${args.join(' ')}`);
      },
    });
    assert.equal(absentTag, null);
    const initialPlan = planNightlyRelease({
      runs: [{ id: 1, head_branch: 'main', event: 'push', status: 'completed', conclusion: 'success', head_sha: SHA_NEW, created_at: '2026-11-24T01:00:00Z' }],
      currentFeed: absentTag,
      date: '20261124',
    });
    assert.equal(initialPlan.buildNumber, 1);

    // 2. Rolling tag exists with another platform's feed only -> macOS/Linux feed confirmed absent.
    const absentAsset = fetchCurrentFeed({
      repo: 'l1quid8/apex-deck',
      runner: (_cmd, args) => {
        if (args[1] === 'repos/l1quid8/apex-deck/releases?per_page=1') {
          return { status: 0, stdout: '[{"tag_name":"nightly"}]', stderr: '' };
        }
        if (args[1] === 'repos/l1quid8/apex-deck/releases/tags/nightly') {
          return { status: 0, stdout: JSON.stringify({ tag_name: 'nightly', assets: [{ name: 'apex-deck-nightly-update-windows.json' }] }), stderr: '' };
        }
        throw new Error(`Unexpected gh call: ${args.join(' ')}`);
      },
    });
    assert.equal(absentAsset, null);

    // 3. Rolling feed exists and downloads cleanly.
    const loaded = fetchCurrentFeed({
      repo: 'l1quid8/apex-deck',
      runner: (_cmd, args) => {
        if (args[1] === 'repos/l1quid8/apex-deck/releases?per_page=1') {
          return { status: 0, stdout: '[{"tag_name":"nightly"}]', stderr: '' };
        }
        if (args[1] === 'repos/l1quid8/apex-deck/releases/tags/nightly') {
          return { status: 0, stdout: JSON.stringify({ tag_name: 'nightly', assets: [{ name: NIGHTLY_MANIFEST_NAME }] }), stderr: '' };
        }
        if (args[0] === 'release' && args[1] === 'download') {
          const dir = args[args.indexOf('--dir') + 1];
          fs.writeFileSync(path.join(dir, NIGHTLY_MANIFEST_NAME), JSON.stringify(prev.manifest));
          return { status: 0, stdout: '', stderr: '' };
        }
        throw new Error(`Unexpected gh call: ${args.join(' ')}`);
      },
    });
    assert.equal(loaded.buildNumber, 42);
    assert.equal(loaded.commit, SHA_OLD);

    // 4. Auth failure (403 or private-repo 404 on releases list) must abort, never return null.
    for (const err of [
      { status: 1, stdout: '{"message":"Resource not accessible by integration","status":"403"}', stderr: 'gh: Resource not accessible by integration (HTTP 403)' },
      { status: 1, stdout: '{"message":"Not Found","status":"404"}', stderr: 'gh: Not Found (HTTP 404)' },
    ]) {
      assert.throws(() => fetchCurrentFeed({
        repo: 'l1quid8/apex-deck',
        runner: (_cmd, args, { allowFailure = false } = {}) => {
          if (!allowFailure) throw new Error(`gh ${args.join(' ')} failed (${err.status}): ${err.stderr}`);
          return err;
        },
      }));
    }

    // 5. Transient 500, 403, or network error on rolling tag lookup must abort.
    for (const tagErr of [
      { status: 1, stdout: '{"message":"Internal Server Error","status":"500"}', stderr: 'gh: Internal Server Error (HTTP 500)' },
      { status: 1, stdout: '{"message":"API rate limit exceeded","status":"403"}', stderr: 'gh: API rate limit exceeded (HTTP 403)' },
      { status: 1, stdout: '', stderr: 'Post "https://api.github.com": dial tcp: lookup api.github.com: no such host' },
    ]) {
      assert.throws(() => fetchCurrentFeed({
        repo: 'l1quid8/apex-deck',
        runner: (_cmd, args) => {
          if (args[1] === 'repos/l1quid8/apex-deck/releases?per_page=1') {
            return { status: 0, stdout: '[{"tag_name":"nightly"}]', stderr: '' };
          }
          if (args[1] === 'repos/l1quid8/apex-deck/releases/tags/nightly') {
            return tagErr;
          }
          throw new Error(`Unexpected gh call: ${args.join(' ')}`);
        },
      }), /Failed to read rolling Nightly release metadata/);
    }

    // 6. Download failure after asset was listed must abort.
    assert.throws(() => fetchCurrentFeed({
      repo: 'l1quid8/apex-deck',
      runner: (_cmd, args, { allowFailure = false } = {}) => {
        if (args[1] === 'repos/l1quid8/apex-deck/releases?per_page=1') {
          return { status: 0, stdout: '[{"tag_name":"nightly"}]', stderr: '' };
        }
        if (args[1] === 'repos/l1quid8/apex-deck/releases/tags/nightly') {
          return { status: 0, stdout: JSON.stringify({ tag_name: 'nightly', assets: [{ name: NIGHTLY_MANIFEST_NAME }] }), stderr: '' };
        }
        if (args[0] === 'release' && args[1] === 'download') {
          if (!allowFailure) throw new Error('gh release download failed (1): HTTP 502 Bad Gateway');
          return { status: 1, stdout: '', stderr: 'HTTP 502 Bad Gateway' };
        }
        throw new Error(`Unexpected gh call: ${args.join(' ')}`);
      },
    }), /502/);

    // 7. fetchGitHubState propagates feed-read errors instead of treating history as empty.
    assert.throws(() => fetchGitHubState({
      repo: 'l1quid8/apex-deck',
      workflow: 'daemon.yml',
      runner: (_cmd, args) => {
        if (args[1].includes('/actions/workflows/')) {
          return { status: 0, stdout: JSON.stringify({ workflow_runs: [{ id: 1, head_branch: 'main', event: 'push', status: 'completed', conclusion: 'success', head_sha: SHA_NEW, created_at: '2026-11-24T01:00:00Z' }] }), stderr: '' };
        }
        if (args[1] === 'repos/l1quid8/apex-deck/releases?per_page=1') {
          return { status: 0, stdout: '[{"tag_name":"nightly"}]', stderr: '' };
        }
        if (args[1] === 'repos/l1quid8/apex-deck/releases/tags/nightly') {
          return { status: 1, stdout: '', stderr: 'gh: Service Unavailable (HTTP 503)' };
        }
        throw new Error(`Unexpected gh call: ${args.join(' ')}`);
      },
    }), /503/);
  } finally {
    fs.rmSync(prev.dir, { recursive: true, force: true });
  }
});

test('failed rolling-feed read aborts CLI plan and publish without touching the rolling feed', () => {
  const next = makeFixture({ commit: SHA_NEW, date: '20261124', buildNumber: 1 });
  const logFile = path.join(next.dir, 'gh-calls.log');
  const outFile = path.join(next.dir, 'github-output.txt');
  try {
    const stubArgs = stubNodeCommand(next.dir, 'gh', `
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logFile)}, args.join(' ') + '\\n');
if (args[0] === 'api' && args[1].includes('/actions/workflows/')) {
  process.stdout.write(JSON.stringify({ workflow_runs: [{ id: 1, head_branch: 'main', event: 'push', status: 'completed', conclusion: 'success', head_sha: ${JSON.stringify(SHA_NEW)}, created_at: '2026-11-24T01:00:00Z' }] }));
  process.exit(0);
}
if (args[0] === 'api' && args[1].includes('/releases?per_page=1')) {
  process.stdout.write('[{"tag_name":"nightly"}]');
  process.exit(0);
}
if (args[0] === 'api' && args[1].includes('/releases/tags/nightly')) {
  process.stderr.write('gh: Internal Server Error (HTTP 500)\\n');
  process.exit(1);
}
process.stderr.write('unexpected gh call: ' + args.join(' ') + '\\n');
process.exit(99);
`);

    // 1. `plan` aborts on 500 and writes nothing to GITHUB_OUTPUT (never resets build_number=1).
    const planRes = spawnSync(process.execPath, [
      ...stubArgs, SCRIPT, 'plan',
      '--repo', 'l1quid8/apex-deck',
      '--date', '20261124',
      '--github-output', outFile,
    ], { encoding: 'utf8' });
    assert.notEqual(planRes.status, 0, 'plan must fail on transient rolling-feed error');
    assert.match(planRes.stderr, /HTTP 500/);
    assert.equal(fs.existsSync(outFile), false, 'failed plan must not write GITHUB_OUTPUT');

    // 2. `publish` aborts before issuing any release create/upload/edit call.
    fs.writeFileSync(logFile, '');
    const pubRes = spawnSync(process.execPath, [
      ...stubArgs, SCRIPT, 'publish',
      '--repo', 'l1quid8/apex-deck',
      '--assets-dir', next.assetsDir,
      '--extra-dir', next.dmgDir,
      '--manifest', next.manifestPath,
    ], { encoding: 'utf8' });
    assert.notEqual(pubRes.status, 0, 'publish must fail on transient rolling-feed error');
    assert.match(pubRes.stderr, /HTTP 500/);
    const calls = fs.readFileSync(logFile, 'utf8');
    assert.doesNotMatch(calls, /release create|release upload|release edit/, 'failed feed read must leave rolling feed untouched');

    // 3. Server error on `gh release view` inside publishNightlyRelease also aborts before creating or uploading.
    const viewErr = publishNightlyRelease({
      manifestPath: next.manifestPath,
      assetsDir: next.assetsDir,
      dmgDir: next.dmgDir,
      currentFeed: null,
      dryRun: false,
      runner: (_cmd, args) => {
        if (args[0] === 'release' && args[1] === 'view') {
          return { status: 1, stdout: '', stderr: 'gh: Service Unavailable (HTTP 503)' };
        }
        throw new Error(`Unexpected gh call after 503: ${args.join(' ')}`);
      },
    });
    assert.equal(viewErr.published, false);
    assert.equal(viewErr.feedAdvanced, false);
    assert.equal(viewErr.stage, 'immutable-tag-check');
    assert.deepEqual(viewErr.commands, []);
  } finally {
    fs.rmSync(next.dir, { recursive: true, force: true });
  }
});

test('nightly-macos workflow schedules green main builds, grants plan actions: read, uploads exact build DMGs, and advances the rolling feed only via nightly-release.mjs', () => {
  const yml = fs.readFileSync(new URL('../.github/workflows/nightly-macos.yml', import.meta.url), 'utf8');
  const codeOnly = yml.replace(/^\s*#.*$/gm, '');
  const parsed = yaml.load(yml);
  assert.equal(parsed.permissions?.contents, 'read');
  assert.equal(parsed.jobs?.plan?.permissions?.contents, 'read', 'plan job needs contents: read for rolling feed checks');
  assert.equal(parsed.jobs?.plan?.permissions?.actions, 'read', 'plan job needs actions: read to query workflow runs in a private repo');
  assert.equal(parsed.jobs?.plan?.outputs?.sha7, '${{ steps.decide.outputs.sha7 }}');
  assert.equal(parsed.jobs?.publish?.permissions?.contents, 'write');
  assert.match(codeOnly, /^\s*schedule:\s*$/m);
  assert.match(codeOnly, /^\s*workflow_dispatch:\s*$/m);
  assert.match(codeOnly, /scripts\/nightly-release\.mjs/);
  assert.match(codeOnly, /scripts\/release-update-manifest\.mjs/);
  assert.match(codeOnly, /Apex-Deck-Nightly_\$\{\{ needs\.plan\.outputs\.date \}\}_\$\{\{ needs\.plan\.outputs\.sha7 \}\}_\*\.dmg/);
  assert.match(codeOnly, /APEX_CHANNEL:\s*nightly/);
  assert.match(codeOnly, /should_build == 'true'/);
  assert.doesNotMatch(codeOnly, /--latest/, 'workflow must never mark a Nightly release as --latest');
});

test('nightly-macos runs only from main, and only build-macos reaches the signing environment', () => {
  const parsed = yaml.load(fs.readFileSync(new URL('../.github/workflows/nightly-macos.yml', import.meta.url), 'utf8'));
  assert.equal(parsed.jobs.plan.if, "github.ref == 'refs/heads/main'");
  for (const [name, job] of Object.entries(parsed.jobs)) {
    const usesSecrets = /secrets\./.test(JSON.stringify(job));
    if (name === 'build-macos') {
      assert.equal(job.environment, 'macos-nightly-signing');
      assert.ok(usesSecrets, 'build-macos imports the signing secrets');
    } else {
      assert.equal(job.environment, undefined, `${name} must not use a signing environment`);
      assert.ok(!usesSecrets, `${name} must not read secrets`);
    }
  }
});
