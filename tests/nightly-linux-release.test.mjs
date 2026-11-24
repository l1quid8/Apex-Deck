import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import {
  LINUX_FEED_NAME,
  appImageName,
  assembleLinuxRelease,
  fetchLinuxFeed,
  parseLinuxFeed,
  planLinuxNightly,
  publishLinuxNightly,
} from '../scripts/nightly-linux-release.mjs';

const yaml = createRequire(import.meta.url)('js-yaml');
const SHA_OLD = '11c1ade33ad9f6dc2d80ff32a68e159d501fde38';
const SHA_NEW = '41702564203e86e178dedda3887abc117a13d246';
const DATE = '20261125';
const TAG = `nightly-${DATE}-${SHA_NEW.slice(0, 7)}`;
const VERSION = '0.9.19';
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'linux-nightly-test-'));

/** One package-linux.mjs output folder (release/nightly) plus the daemon copied beside it. */
function fakeBuild(arch, { buildNumber = 1, commit = SHA_NEW, metadata = {} } = {}) {
  const dir = tmp();
  const tag = `nightly-${DATE}-${commit.slice(0, 7)}`;
  const name = appImageName(tag, arch);
  const image = Buffer.from(`appimage ${arch} ${commit}`);
  fs.writeFileSync(path.join(dir, name), image);
  fs.writeFileSync(path.join(dir, `${name}.sha256`), `${sha256(image)}  ${name}\n`);
  fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify({
    channel: 'nightly', version: VERSION, commit, sourceCommit: commit, buildNumber, tag, date: DATE,
    arch, name, size: image.length, sha256: sha256(image), ...metadata,
  }));
  fs.writeFileSync(path.join(dir, 'apex-daemon'), `daemon ${arch} ${commit}`);
  return dir;
}

function assembled({ buildNumber = 1 } = {}) {
  const out = tmp();
  const feed = assembleLinuxRelease({
    out, date: DATE, commit: SHA_NEW, buildNumber, version: VERSION,
    builds: { x86_64: fakeBuild('x86_64', { buildNumber }), arm64: fakeBuild('arm64', { buildNumber }) },
  });
  return { out, feed };
}

const greenRun = (sha, created = '2026-11-25T06:00:00Z') => ({ head_branch: 'main', status: 'completed', conclusion: 'success', event: 'push', head_sha: sha, created_at: created, id: 1 });

/** A fake `gh` that keeps releases in memory and serves uploaded bytes back. */
function fakeGitHub({ releases = {}, corrupt = null } = {}) {
  const store = structuredClone(releases);
  const files = {};
  const calls = [];
  const flagOf = (args, name) => args[args.indexOf(name) + 1];
  const runner = (command, args) => {
    calls.push(args.join(' '));
    const [group, action, tag] = args;
    if (group === 'release' && action === 'view') {
      const release = store[tag];
      return release ? { status: 0, stdout: JSON.stringify(release), stderr: '' } : { status: 1, stdout: '', stderr: 'release not found' };
    }
    if (group === 'release' && action === 'create') {
      if (store[tag]) return { status: 1, stdout: '', stderr: 'already exists' };
      store[tag] = { isDraft: args.includes('--draft'), targetCommitish: args.includes('--target') ? flagOf(args, '--target') : 'main', assets: [] };
      return { status: 0, stdout: '', stderr: '' };
    }
    if (group === 'release' && action === 'upload') {
      for (const file of args.slice(5).filter((value) => !value.startsWith('--'))) {
        const name = path.basename(file);
        let bytes = fs.readFileSync(file);
        if (corrupt === name) bytes = Buffer.concat([bytes, Buffer.from('x')]);
        files[`${tag}/${name}`] = bytes;
        if (!store[tag].assets.some((asset) => asset.name === name)) store[tag].assets.push({ name });
      }
      return { status: 0, stdout: '', stderr: '' };
    }
    if (group === 'release' && action === 'download') {
      const name = flagOf(args, '--pattern');
      fs.writeFileSync(path.join(flagOf(args, '--dir'), name), files[`${tag}/${name}`]);
      return { status: 0, stdout: '', stderr: '' };
    }
    if (group === 'release' && action === 'edit') {
      store[tag].isDraft = false;
      return { status: 0, stdout: '', stderr: '' };
    }
    throw new Error(`unexpected gh ${args.join(' ')}`);
  };
  return { runner, store, files, calls };
}

test('the Linux feed is strict and platform-scoped', () => {
  const { feed } = assembled();
  assert.equal(parseLinuxFeed(feed).platform, 'linux');
  assert.deepEqual(feed.daemons.map((entry) => entry.name).sort(), ['apex-daemon-nightly-linux-arm64', 'apex-daemon-nightly-linux-x86_64']);
  assert.deepEqual(feed.appImages.map((entry) => entry.name).sort(), [
    `Apex-Deck-Nightly_${DATE}_4170256_arm64.AppImage`, `Apex-Deck-Nightly_${DATE}_4170256_x86_64.AppImage`]);
  assert.throws(() => parseLinuxFeed({ ...feed, channel: 'stable' }), /channel mismatch/);
  assert.throws(() => parseLinuxFeed({ ...feed, platform: undefined }), /platform mismatch/);
  assert.throws(() => parseLinuxFeed({ ...feed, buildNumber: 0 }), /positive/);
  assert.throws(() => parseLinuxFeed({ ...feed, commit: SHA_NEW.slice(0, 12) }), /full lowercase SHA/);
  assert.throws(() => parseLinuxFeed({ ...feed, tag: `nightly-${DATE}-${SHA_OLD.slice(0, 7)}` }), /tag/);
  assert.throws(() => parseLinuxFeed({ ...feed, appImages: feed.appImages.slice(1) }), /exactly one appImage/);
  assert.throws(() => parseLinuxFeed({ ...feed, daemons: [...feed.daemons, feed.daemons[0]] }), /exactly one daemon/);
});

test('a macOS-shaped feed is not mistaken for the Linux feed', () => {
  const mac = { schemaVersion: 1, channel: 'nightly', version: VERSION, buildNumber: 9, commit: SHA_NEW, tag: TAG, packages: [{ arch: 'arm64' }] };
  assert.throws(() => parseLinuxFeed(mac), /platform mismatch/);
});

test('planning reads only the Linux feed and numbers builds per platform', () => {
  const runs = [greenRun(SHA_OLD, '2026-11-24T06:00:00Z'), greenRun(SHA_NEW)];
  const first = planLinuxNightly({ runs, currentFeed: null, date: DATE });
  assert.equal(first.shouldBuild, true);
  assert.equal(first.reason, 'initial');
  assert.equal(first.buildNumber, 1);
  assert.equal(first.tag, TAG);

  const { feed } = assembled({ buildNumber: 4 });
  const unchanged = planLinuxNightly({ runs, currentFeed: feed, date: DATE });
  assert.equal(unchanged.shouldBuild, false);
  assert.equal(unchanged.reason, 'unchanged');

  const forced = planLinuxNightly({ runs, currentFeed: feed, date: DATE, force: true });
  assert.equal(forced.reason, 'forced');
  assert.equal(forced.buildNumber, 5, 'same commit and semver still gets a higher build number');

  assert.equal(planLinuxNightly({ runs: [greenRun(SHA_OLD)], currentFeed: null, date: DATE, targetSha: SHA_NEW }).reason, 'target_not_green');
  assert.equal(planLinuxNightly({ runs: [{ ...greenRun(SHA_NEW), conclusion: 'failure' }], date: DATE }).reason, 'no_green_main');
});

test('assemble refuses a build whose metadata or checksum is wrong', () => {
  const builds = { x86_64: fakeBuild('x86_64', { metadata: { channel: 'stable' } }), arm64: fakeBuild('arm64') };
  assert.throws(() => assembleLinuxRelease({ out: tmp(), date: DATE, commit: SHA_NEW, buildNumber: 1, version: VERSION, builds }), /x86_64: .*channel/);

  const bad = fakeBuild('arm64');
  fs.writeFileSync(path.join(bad, `${appImageName(TAG, 'arm64')}.sha256`), `${'0'.repeat(64)}  ${appImageName(TAG, 'arm64')}\n`);
  assert.throws(() => assembleLinuxRelease({ out: tmp(), date: DATE, commit: SHA_NEW, buildNumber: 1, version: VERSION, builds: { x86_64: fakeBuild('x86_64'), arm64: bad } }), /arm64: .*sha256 does not match/);

  assert.throws(() => assembleLinuxRelease({ out: tmp(), date: DATE, commit: SHA_NEW, buildNumber: 1, version: VERSION, builds: { x86_64: fakeBuild('x86_64') } }), /one --build for each/);
});

test('first publish creates the immutable release and the rolling feed, and writes only the Linux feed', () => {
  const { out } = assembled();
  const gh = fakeGitHub();
  const result = publishLinuxNightly({ assetsDir: out, runner: gh.runner });
  assert.equal(result.published, true, result.errors.join('; '));
  assert.equal(gh.store[TAG].isDraft, false);
  assert.equal(gh.store[TAG].targetCommitish, SHA_NEW);
  const names = gh.store[TAG].assets.map((asset) => asset.name);
  for (const arch of ['x86_64', 'arm64']) {
    for (const suffix of ['', '.sha256', '.json']) assert.ok(names.includes(`${appImageName(TAG, arch)}${suffix}`));
    assert.ok(names.includes(`apex-daemon-nightly-linux-${arch}`));
  }
  assert.ok(names.includes(LINUX_FEED_NAME), 'the immutable release keeps a pinned copy of the Linux feed');
  assert.deepEqual(gh.store.nightly.assets.map((asset) => asset.name), [LINUX_FEED_NAME]);
  assert.ok(gh.calls.every((call) => !call.includes('apex-deck-nightly-update.json')), 'never touches the macOS feed');
});

test('Linux attaches to a release another platform already published, without touching its assets', () => {
  const { out } = assembled();
  const gh = fakeGitHub({ releases: {
    [TAG]: { isDraft: false, targetCommitish: SHA_NEW, assets: [{ name: 'Apex-Deck-Nightly_arm64.pkg' }] },
    nightly: { isDraft: false, assets: [{ name: 'apex-deck-nightly-update.json' }] },
  } });
  const result = publishLinuxNightly({ assetsDir: out, runner: gh.runner });
  assert.equal(result.published, true, result.errors.join('; '));
  const upload = gh.calls.find((call) => call.startsWith(`release upload ${TAG}`));
  assert.doesNotMatch(upload, /--clobber/, 'a published release is never clobbered');
  assert.ok(!gh.calls.some((call) => call.startsWith(`release edit ${TAG}`)), 'leaves another platform\'s published release alone');
  assert.ok(!gh.calls.some((call) => call.startsWith('release create')));
  assert.deepEqual(gh.store.nightly.assets.map((asset) => asset.name).sort(), [LINUX_FEED_NAME, 'apex-deck-nightly-update.json'].sort());
});

test('Linux refuses to overwrite its own asset on a published release, or attach to another commit', () => {
  const { out } = assembled();
  const name = appImageName(TAG, 'x86_64');
  const clash = fakeGitHub({ releases: { [TAG]: { isDraft: false, targetCommitish: SHA_NEW, assets: [{ name }] } } });
  clash.files[`${TAG}/${name}`] = Buffer.from('a different AppImage');
  const held = publishLinuxNightly({ assetsDir: out, runner: clash.runner });
  assert.equal(held.stage, 'immutable-tag');
  assert.match(held.errors[0], /refusing to overwrite/);

  const other = fakeGitHub({ releases: { [TAG]: { isDraft: true, targetCommitish: SHA_OLD, assets: [] } } });
  assert.equal(publishLinuxNightly({ assetsDir: out, runner: other.runner }).stage, 'immutable-tag');
  for (const gh of [clash, other]) assert.ok(!gh.calls.some((call) => call.includes('release upload')));
  assert.ok(!clash.calls.some((call) => call.startsWith('release edit')));
});

test('a retry keeps identical Linux files already on a published release and refuses different ones', () => {
  const { out } = assembled();
  const first = fakeGitHub({ releases: { [TAG]: { isDraft: false, targetCommitish: SHA_NEW, assets: [{ name: 'Apex-Deck-Nightly_arm64.pkg' }] } } });
  // The first attempt uploaded and verified everything but failed before the feed moved.
  assert.equal(publishLinuxNightly({ assetsDir: out, runner: first.runner }).published, true);
  delete first.store.nightly;
  first.calls.length = 0;
  const retry = publishLinuxNightly({ assetsDir: out, runner: first.runner });
  assert.equal(retry.published, true, retry.errors.join('; '));
  assert.ok(!first.calls.some((call) => call.startsWith(`release upload ${TAG}`)), 'nothing is re-uploaded');
  assert.deepEqual(first.store.nightly.assets.map((asset) => asset.name), [LINUX_FEED_NAME]);

  const name = 'apex-daemon-nightly-linux-x86_64';
  first.files[`${TAG}/${name}`] = Buffer.from('someone else');
  delete first.store.nightly;
  const held = publishLinuxNightly({ assetsDir: out, runner: first.runner });
  assert.equal(held.stage, 'immutable-tag');
  assert.match(held.errors[0], /different .*refusing to overwrite/);
  assert.equal(first.store.nightly, undefined);
});

test('a corrupted upload holds the Linux feed and leaves the release a draft', () => {
  const { out } = assembled();
  const gh = fakeGitHub({ corrupt: 'apex-daemon-nightly-linux-arm64' });
  const result = publishLinuxNightly({ assetsDir: out, runner: gh.runner });
  assert.equal(result.stage, 'download-verify');
  assert.equal(gh.store[TAG].isDraft, true);
  assert.equal(gh.store.nightly, undefined);
});

test('a missing local sidecar is caught before anything is uploaded', () => {
  const { out } = assembled();
  fs.rmSync(path.join(out, `${appImageName(TAG, 'arm64')}.json`));
  const gh = fakeGitHub();
  const result = publishLinuxNightly({ assetsDir: out, runner: gh.runner });
  assert.equal(result.stage, 'local-verify');
  assert.equal(gh.calls.length, 0);
});

test('build numbers only move forward on the Linux feed', () => {
  const { out } = assembled({ buildNumber: 3 });
  const published = { ...assembled({ buildNumber: 3 }).feed, commit: SHA_OLD, tag: `nightly-${DATE}-${SHA_OLD.slice(0, 7)}` };
  published.appImages = published.appImages.map((entry) => ({ ...entry, name: appImageName(published.tag, entry.arch) }));
  assert.equal(publishLinuxNightly({ assetsDir: out, currentFeed: published, runner: fakeGitHub().runner }).stage, 'monotonic-check');
  const same = assembled({ buildNumber: 3 });
  assert.equal(publishLinuxNightly({ assetsDir: same.out, currentFeed: same.feed, runner: fakeGitHub().runner }).stage, 'unchanged');
});

test('fetchLinuxFeed treats a missing Linux feed as absent but fails closed on errors', () => {
  const ok = { status: 0, stdout: '[]', stderr: '' };
  const withRolling = (assets) => (command, args) => (args[1].startsWith('repos/') && args[1].includes('releases?') ? ok
    : { status: 0, stdout: JSON.stringify({ assets }), stderr: '' });
  assert.equal(fetchLinuxFeed({ runner: withRolling([{ name: 'apex-deck-nightly-update.json' }]) }), null, 'a macOS-only rolling release has no Linux feed yet');
  assert.equal(fetchLinuxFeed({ runner: (command, args) => (args[1].includes('releases?') ? ok : { status: 1, stdout: '', stderr: 'HTTP 404' }) }), null);
  assert.throws(() => fetchLinuxFeed({ runner: (command, args) => (args[1].includes('releases?') ? ok : { status: 1, stdout: '', stderr: 'HTTP 502' }) }), /failed/);
});

test('the Linux workflow needs no Apple or Windows secrets and writes only the Linux feed', () => {
  const text = fs.readFileSync(new URL('../.github/workflows/nightly-linux.yml', import.meta.url), 'utf8');
  const workflow = yaml.load(text);
  assert.deepEqual(Object.keys(workflow.jobs), ['plan', 'build', 'publish']);
  assert.doesNotMatch(text, /secrets\.|MACOS_|APPLE_|WINDOWS_/);
  assert.doesNotMatch(text, /nightly-release\.mjs|nightly-macos/);
  assert.equal(workflow.concurrency.group, 'nightly-linux');
  const build = workflow.jobs.build;
  assert.deepEqual(build.strategy.matrix.include.map((row) => row.arch), ['x86_64', 'arm64']);
  assert.equal(build.env.APEX_BUILD_NUMBER, '${{ needs.plan.outputs.build_number }}');
  assert.equal(build.env.APEX_NIGHTLY_COMMIT, '${{ needs.plan.outputs.commit }}');
  assert.deepEqual(workflow.jobs.publish.needs, ['plan', 'build']);
});
