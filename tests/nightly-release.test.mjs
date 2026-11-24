import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  NIGHTLY_MANIFEST_NAME,
  formatNightlyTag,
  parseNightlyFeed,
  pickGreenMainCommit,
  planNightlyRelease,
  publishNightlyRelease,
  verifyAssetFiles,
} from '../scripts/nightly-release.mjs';

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
} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-nightly-release-'));
  const assetsDir = path.join(dir, 'assets');
  fs.mkdirSync(assetsDir, { recursive: true });
  const tag = formatNightlyTag(date, commit);
  const pkgName = `Apex-Deck-Nightly_${date}_${commit.slice(0, 7)}_arm64.pkg`;
  const pkgBytes = Buffer.from(`fake-pkg-${tag}-${buildNumber}`);
  const armBytes = Buffer.from(`fake-linux-arm64-${tag}-${buildNumber}`);
  const x64Bytes = Buffer.from(`fake-linux-x86_64-${tag}-${buildNumber}`);
  fs.writeFileSync(path.join(assetsDir, pkgName), pkgBytes);
  fs.writeFileSync(path.join(assetsDir, 'apex-daemon-nightly-linux-arm64'), armBytes);
  fs.writeFileSync(path.join(assetsDir, 'apex-daemon-nightly-linux-x86_64'), x64Bytes);
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
  return { dir, assetsDir, manifestPath, manifest, pkgName };
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
    // 1. Clean dry run passes and never touches --latest.
    const clean = publishNightlyRelease({
      manifestPath: next.manifestPath,
      assetsDir: next.assetsDir,
      currentFeed: prev.manifest,
      dryRun: true,
    });
    assert.equal(clean.published, true);
    assert.equal(clean.feedAdvanced, true);
    const flatClean = clean.commands.map((args) => args.join(' ')).join('\n');
    assert.doesNotMatch(flatClean, /--latest/);
    assert.match(flatClean, /gh release edit nightly-20261124-4170256 .*--draft=false --prerelease/);
    assert.match(flatClean, /gh release upload nightly .*apex-deck-nightly-update\.json/);

    // 2. Tampered post-upload download check holds the rolling feed and refuses --draft=false.
    const badDownloadDir = path.join(next.dir, 'bad-download');
    fs.cpSync(next.assetsDir, badDownloadDir, { recursive: true });
    fs.writeFileSync(path.join(badDownloadDir, next.pkgName), Buffer.from('corrupted-pkg-bytes'));
    const heldDownload = publishNightlyRelease({
      manifestPath: next.manifestPath,
      assetsDir: next.assetsDir,
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

test('live-mode publish refuses overwriting an immutable published tag and holds feed on bad download', () => {
  const prev = makeFixture({ commit: SHA_OLD, date: '20261123', buildNumber: 42 });
  const next = makeFixture({ commit: SHA_NEW, date: '20261124', buildNumber: 43 });
  try {
    // Already-published immutable tag must never be overwritten.
    const alreadyPublished = publishNightlyRelease({
      manifestPath: next.manifestPath,
      assetsDir: next.assetsDir,
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

    // Download-back returns tampered bytes -> must hold feed (no --draft=false, no nightly upload).
    const seen = [];
    const tamperedLive = publishNightlyRelease({
      manifestPath: next.manifestPath,
      assetsDir: next.assetsDir,
      currentFeed: prev.manifest,
      dryRun: false,
      runner: (_cmd, args) => {
        seen.push(args.join(' '));
        if (args[0] === 'release' && args[1] === 'view') return { status: 1, stdout: '', stderr: 'not found' };
        if (args[0] === 'release' && args[1] === 'download') {
          const dir = args[args.indexOf('--dir') + 1];
          const pattern = args[args.indexOf('--pattern') + 1];
          fs.writeFileSync(path.join(dir, pattern), pattern === next.pkgName ? Buffer.from('bad-download') : fs.readFileSync(path.join(next.assetsDir, pattern)));
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

test('nightly-macos workflow schedules green main builds and advances the rolling feed only via nightly-release.mjs', () => {
  const yml = fs.readFileSync(new URL('../.github/workflows/nightly-macos.yml', import.meta.url), 'utf8');
  const codeOnly = yml.replace(/^\s*#.*$/gm, '');
  assert.match(codeOnly, /^\s*schedule:\s*$/m);
  assert.match(codeOnly, /^\s*workflow_dispatch:\s*$/m);
  assert.match(codeOnly, /scripts\/nightly-release\.mjs/);
  assert.match(codeOnly, /scripts\/release-update-manifest\.mjs/);
  assert.match(codeOnly, /APEX_CHANNEL:\s*nightly/);
  assert.match(codeOnly, /should_build == 'true'/);
  assert.doesNotMatch(codeOnly, /--latest/, 'workflow must never mark a Nightly release as --latest');
});
