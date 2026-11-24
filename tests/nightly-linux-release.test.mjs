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
  linuxJobsGreen,
  loadJobsUntilGreen,
  parseLinuxFeed,
  planLinuxNightly,
  publishLinuxNightly,
} from '../scripts/nightly-linux-release.mjs';

const yaml = createRequire(import.meta.url)('js-yaml');
const SHA_OLD = '11c1ade33ad9f6dc2d80ff32a68e159d501fde38';
const SHA_NEW = '41702564203e86e178dedda3887abc117a13d246';
const DATE = '20261125';
const TAG = `nightly-${DATE}-${SHA_NEW.slice(0, 7)}`;
const ASSET = `nightly-linux-${DATE}-${SHA_NEW.slice(0, 7)}`;
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
function fakeGitHub({ releases = {}, tags = {}, corrupt = null, tagCreateFails = false, tagRaceWinner = null } = {}) {
  const store = structuredClone(releases);
  const refs = { ...tags };
  const files = {};
  const calls = [];
  const flagOf = (args, name) => args[args.indexOf(name) + 1];
  const runner = (command, args) => {
    calls.push(args.join(' '));
    const [group, action, tag] = args;
    if (group === 'api' && /\/git\/ref\/tags\//.test(action)) {
      const name = action.split('/git/ref/tags/')[1];
      return refs[name] ? { status: 0, stdout: JSON.stringify({ object: { type: 'commit', sha: refs[name] } }), stderr: '' } : { status: 1, stdout: '', stderr: 'HTTP 404: Not Found' };
    }
    if (group === 'api' && action === '-X' && args[3].endsWith('/git/refs')) {
      const name = flagOf(args, '-f').replace('ref=refs/tags/', '');
      if (tagCreateFails) return { status: 1, stdout: '', stderr: 'HTTP 500: Internal Server Error' };
      if (tagRaceWinner) refs[name] = tagRaceWinner;
      if (refs[name]) return { status: 1, stdout: '', stderr: 'HTTP 422: Reference already exists' };
      refs[name] = args[args.lastIndexOf('-f') + 1].replace('sha=', '');
      return { status: 0, stdout: '', stderr: '' };
    }
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
  return { runner, store, files, calls, refs };
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
  assert.equal(feed.assetTag, ASSET);
  assert.throws(() => parseLinuxFeed({ ...feed, assetTag: TAG }), /assetTag/);
  assert.throws(() => parseLinuxFeed({ ...feed, assetTag: undefined }), /assetTag/);
  assert.throws(() => parseLinuxFeed({ ...feed, appImages: feed.appImages.slice(1) }), /exactly one appImage/);
  assert.throws(() => parseLinuxFeed({ ...feed, daemons: [...feed.daemons, feed.daemons[0]] }), /exactly one daemon/);
});

test('a macOS-shaped feed is not mistaken for the Linux feed', () => {
  const mac = { schemaVersion: 1, channel: 'nightly', version: VERSION, buildNumber: 9, commit: SHA_NEW, tag: TAG, assetTag: ASSET, packages: [{ arch: 'arm64' }] };
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

const job = (name, conclusion = 'success') => ({ name, status: 'completed', conclusion });
const linuxGreen = [job('changes'), job('versions-agree'), job('test (ubuntu-22.04, daemon)'), job('test (ubuntu-22.04-arm, host)'), job('build (ubuntu-22.04, x86_64)')];

test('Linux eligibility ignores macOS and Windows jobs in daemon.yml', () => {
  assert.equal(linuxJobsGreen([...linuxGreen, job('test (macos-latest, daemon)', 'cancelled'), job('test-windows-app (2/4)', 'failure')]), true);
  assert.equal(linuxJobsGreen([...linuxGreen.slice(1), job('changes', 'failure')]), false, 'a shared job still gates Linux');
  assert.equal(linuxJobsGreen([...linuxGreen, job('test (ubuntu-22.04, updater)', 'cancelled')]), false);
  assert.equal(linuxJobsGreen([job('changes'), job('protocol-types', 'skipped'), ...linuxGreen.slice(2)]), true, 'a skipped shared job is fine');
  assert.equal(linuxJobsGreen([job('changes'), job('test (ubuntu-22.04, daemon)', 'skipped'), job('build (ubuntu-22.04, x86_64)', 'skipped')]), false, 'skipped Linux suites are no evidence when the run did not pass');
  assert.equal(linuxJobsGreen([job('test (macos-latest, daemon)')]), false, 'a run with no Linux jobs is not Linux evidence');
  assert.equal(linuxJobsGreen(undefined), false);

  const macCancelled = { ...greenRun(SHA_NEW), conclusion: 'cancelled', id: 2 };
  const runs = [greenRun(SHA_OLD, '2026-11-24T06:00:00Z'), macCancelled];
  const fetched = [];
  const jobsByRun = loadJobsUntilGreen(runs, { fetchJobs: (id) => { fetched.push(id); return [...linuxGreen, job('test (macos-latest, daemon)', 'cancelled')]; } });
  assert.deepEqual(fetched, [2], 'jobs are fetched only for the newest run that is not wholly green');
  const plan = planLinuxNightly({ runs, jobsByRun, date: DATE });
  assert.equal(plan.commit, SHA_NEW, 'a macOS cancellation does not hold a healthy Linux commit out of Nightly');

  const linuxFailed = loadJobsUntilGreen(runs, { fetchJobs: () => [...linuxGreen, job('test (ubuntu-22.04, host)', 'failure')] });
  assert.equal(planLinuxNightly({ runs, jobsByRun: linuxFailed, date: DATE }).commit, SHA_OLD, 'a Linux failure falls back to the last Linux-green commit');
  assert.equal(planLinuxNightly({ runs, jobsByRun, date: DATE, targetSha: SHA_NEW }).commit, SHA_NEW);
});

const releaseCalls = (gh, tag) => gh.calls.filter((call) => call.startsWith('release ') && call.split(' ')[2] === tag);

test('first publish uses a Linux-only release, creates the source tag, and writes only the Linux feed', () => {
  const { out } = assembled();
  const gh = fakeGitHub();
  const result = publishLinuxNightly({ assetsDir: out, runner: gh.runner });
  assert.equal(result.published, true, result.errors.join('; '));
  assert.equal(gh.store[ASSET].isDraft, false);
  assert.equal(gh.store[ASSET].targetCommitish, SHA_NEW);
  assert.equal(gh.store[TAG], undefined, 'Linux never creates the shared nightly-YYYYMMDD-<sha7> release');
  assert.equal(gh.refs[TAG], SHA_NEW, 'the shared source tag the VPS updater builds from points at the commit');
  const names = gh.store[ASSET].assets.map((asset) => asset.name);
  for (const arch of ['x86_64', 'arm64']) {
    for (const suffix of ['', '.sha256', '.json']) assert.ok(names.includes(`${appImageName(TAG, arch)}${suffix}`));
    assert.ok(names.includes(`apex-daemon-nightly-linux-${arch}`));
  }
  assert.ok(names.includes(LINUX_FEED_NAME), 'the Linux release keeps a pinned copy of the Linux feed');
  assert.deepEqual(gh.store.nightly.assets.map((asset) => asset.name), [LINUX_FEED_NAME]);
  assert.ok(gh.calls.every((call) => !call.includes('apex-deck-nightly-update.json')), 'never touches the macOS feed');
});

test('an overlapping macOS publication is never touched, published or blocked by Linux', () => {
  const { out } = assembled();
  // macOS has uploaded to its draft and is still verifying when Linux runs.
  const macDraft = { isDraft: true, targetCommitish: SHA_NEW, assets: [{ name: 'Apex-Deck-Nightly_arm64.pkg' }] };
  const gh = fakeGitHub({ releases: { [TAG]: macDraft, nightly: { isDraft: false, assets: [{ name: 'apex-deck-nightly-update.json' }] } } });
  const result = publishLinuxNightly({ assetsDir: out, runner: gh.runner });
  assert.equal(result.published, true, result.errors.join('; '));
  assert.deepEqual(releaseCalls(gh, TAG), [], 'Linux never views, uploads to, or publishes the macOS release');
  assert.deepEqual(gh.store[TAG], macDraft, 'the macOS draft stays a draft with only its own assets');
  assert.deepEqual(gh.store.nightly.assets.map((asset) => asset.name).sort(), [LINUX_FEED_NAME, 'apex-deck-nightly-update.json'].sort());

  // macOS published first: the source tag already exists at the same commit, so Linux only checks it.
  const after = fakeGitHub({ releases: { [TAG]: { isDraft: false, targetCommitish: SHA_NEW, assets: [] } }, tags: { [TAG]: SHA_NEW } });
  assert.equal(publishLinuxNightly({ assetsDir: out, runner: after.runner }).published, true);
  assert.ok(!after.calls.some((call) => call.includes('/git/refs')));
  assert.deepEqual(releaseCalls(after, TAG), []);
});

test('Linux holds when the shared source tag or its own release points at another commit', () => {
  const { out } = assembled();
  const moved = fakeGitHub({ tags: { [TAG]: SHA_OLD } });
  const held = publishLinuxNightly({ assetsDir: out, runner: moved.runner });
  assert.equal(held.stage, 'source-tag');
  assert.ok(!moved.calls.some((call) => call.startsWith('release ')), 'nothing is created or uploaded');

  const other = fakeGitHub({ releases: { [ASSET]: { isDraft: true, targetCommitish: SHA_OLD, assets: [] } } });
  assert.equal(publishLinuxNightly({ assetsDir: out, runner: other.runner }).stage, 'immutable-tag');
  assert.ok(!other.calls.some((call) => call.includes('release upload')));
});

test('a retry replaces Linux files the feed never pointed at, and refuses files the feed already points at', () => {
  const { out, feed } = assembled();
  // An earlier attempt published the Linux release but failed before the feed moved; the rerun rebuilt different bytes.
  const gh = fakeGitHub();
  assert.equal(publishLinuxNightly({ assetsDir: out, runner: gh.runner }).published, true);
  delete gh.store.nightly;
  const name = 'apex-daemon-nightly-linux-x86_64';
  gh.files[`${ASSET}/${name}`] = Buffer.from('an earlier, unreferenced build');
  gh.calls.length = 0;
  const retry = publishLinuxNightly({ assetsDir: out, runner: gh.runner });
  assert.equal(retry.published, true, retry.errors.join('; '));
  assert.match(gh.calls.find((call) => call.startsWith(`release upload ${ASSET}`)), /--clobber/);
  assert.deepEqual(gh.store.nightly.assets.map((asset) => asset.name), [LINUX_FEED_NAME]);

  // A published Linux release the feed may already have advertised is never replaced, even after the feed moved on.
  const advertised = fakeGitHub();
  assert.equal(publishLinuxNightly({ assetsDir: out, runner: advertised.runner }).published, true);
  const laterFeed = { ...feed, buildNumber: 2, commit: SHA_OLD, tag: `nightly-${DATE}-${SHA_OLD.slice(0, 7)}`, assetTag: `nightly-linux-${DATE}-${SHA_OLD.slice(0, 7)}` };
  laterFeed.appImages = laterFeed.appImages.map((entry) => ({ ...entry, name: appImageName(laterFeed.tag, entry.arch) }));
  advertised.calls.length = 0;
  const stale = publishLinuxNightly({ assetsDir: assembled({ buildNumber: 3 }).out, currentFeed: laterFeed, force: true, runner: advertised.runner });
  assert.equal(stale.stage, 'immutable-tag');
  assert.match(stale.errors[0], /may have advertised/);
  assert.ok(!advertised.calls.some((call) => call.includes('release upload')));

  // With a live feed at build 2, an unadvertised earlier attempt at build 3 is still replaceable.
  const pending = fakeGitHub();
  const attempt = assembled({ buildNumber: 3 });
  assert.equal(publishLinuxNightly({ assetsDir: attempt.out, currentFeed: laterFeed, runner: pending.runner }).published, true);
  delete pending.store.nightly;
  pending.files[`${ASSET}/${name}`] = Buffer.from('a failed attempt');
  const resumed = publishLinuxNightly({ assetsDir: attempt.out, currentFeed: laterFeed, runner: pending.runner });
  assert.equal(resumed.published, true, resumed.errors.join('; '));

  // Once the live Linux feed points at this release, a forced same-day rebuild is refused before anything changes.
  const forced = assembled({ buildNumber: 2 });
  gh.calls.length = 0;
  const refused = publishLinuxNightly({ assetsDir: forced.out, currentFeed: feed, force: true, runner: gh.runner });
  assert.equal(refused.stage, 'immutable-tag');
  assert.match(refused.errors[0], /already points at .*refusing to overwrite/);
  assert.ok(!gh.calls.some((call) => call.includes('release upload') || call.includes('release edit')));
});

test('a corrupted upload holds the Linux feed, leaves the Linux release a draft, and creates no source tag', () => {
  const { out } = assembled();
  const gh = fakeGitHub({ corrupt: 'apex-daemon-nightly-linux-arm64' });
  const result = publishLinuxNightly({ assetsDir: out, runner: gh.runner });
  assert.equal(result.stage, 'download-verify');
  assert.equal(gh.store[ASSET].isDraft, true);
  assert.equal(gh.store.nightly, undefined);
  assert.equal(gh.refs[TAG], undefined);
});

test('a first publish whose source tag cannot be created leaves the Linux release unpublished and the feed unmoved', () => {
  const { out } = assembled();
  for (const [mode, options] of [['create fails', { tagCreateFails: true }], ['another commit wins the race', { tagRaceWinner: SHA_OLD }]]) {
    const gh = fakeGitHub(options);
    const result = publishLinuxNightly({ assetsDir: out, runner: gh.runner });
    assert.equal(result.stage, 'source-tag', mode);
    assert.equal(result.published, false);
    assert.equal(gh.store[ASSET].isDraft, true, `${mode}: the Linux release stays a draft`);
    assert.ok(!gh.calls.some((call) => call.startsWith(`release edit ${ASSET}`)), `${mode}: never un-drafted`);
    assert.equal(gh.store.nightly, undefined, `${mode}: the rolling feed is never written`);
    // A draft is not Linux release history, so feed recovery has nothing to point VPS clients at.
    const listed = (command, args) => (args[1] === '--paginate'
      ? { status: 0, stdout: Object.entries(gh.store).filter(([, release]) => !release.isDraft).map(([tag]) => `${tag}\n`).join(''), stderr: '' }
      : { status: 1, stdout: '', stderr: 'HTTP 404: Not Found' });
    assert.equal(fetchLinuxFeed({ runner: listed }), null, `${mode}: recovery sees no published Linux release`);
  }
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
  const oldTag = `nightly-${DATE}-${SHA_OLD.slice(0, 7)}`;
  const published = { ...assembled({ buildNumber: 3 }).feed, commit: SHA_OLD, tag: oldTag, assetTag: `nightly-linux-${DATE}-${SHA_OLD.slice(0, 7)}` };
  published.appImages = published.appImages.map((entry) => ({ ...entry, name: appImageName(published.tag, entry.arch) }));
  assert.equal(publishLinuxNightly({ assetsDir: out, currentFeed: published, runner: fakeGitHub().runner }).stage, 'monotonic-check');
  const same = assembled({ buildNumber: 3 });
  assert.equal(publishLinuxNightly({ assetsDir: same.out, currentFeed: same.feed, runner: fakeGitHub().runner }).stage, 'unchanged');
});

test('fetchLinuxFeed treats a missing Linux feed as absent but fails closed on errors', () => {
  const history = (tags) => ({ status: 0, stdout: tags.map((tag) => `${tag}\n`).join(''), stderr: '' });
  const isList = (args) => args.includes('--paginate');
  const withRolling = (assets, tags = []) => (command, args) => (isList(args) ? history(tags)
    : { status: 0, stdout: JSON.stringify({ assets }), stderr: '' });
  assert.equal(fetchLinuxFeed({ runner: withRolling([{ name: 'apex-deck-nightly-update.json' }], [TAG]) }), null,
    'a macOS-only rolling release has no Linux feed yet, and the shared source tag is not Linux history');
  assert.equal(fetchLinuxFeed({ runner: (command, args) => (isList(args) ? history([]) : { status: 1, stdout: '', stderr: 'HTTP 404' }) }), null);
  assert.throws(() => fetchLinuxFeed({ runner: (command, args) => (isList(args) ? history([]) : { status: 1, stdout: '', stderr: 'HTTP 502' }) }), /failed/);
  assert.throws(() => fetchLinuxFeed({ runner: () => { throw new Error('gh api failed (1): HTTP 502'); } }), /502/,
    'an unreadable release history never counts as "no Linux Nightly yet"');
});

test('an interrupted rolling-feed upload never restarts Linux build numbers', () => {
  // `gh release upload --clobber` deletes the old feed before uploading. If the
  // upload then fails, the rolling release has no Linux feed, but a published
  // Linux release from an earlier run still exists.
  const history = { status: 0, stdout: `${ASSET}\nnightly-linux-20261124-11c1ade\n`, stderr: '' };
  const runner = (command, args) => (args.includes('--paginate') ? history
    : { status: 0, stdout: JSON.stringify({ assets: [{ name: 'apex-deck-nightly-update.json' }] }), stderr: '' });
  assert.throws(() => fetchLinuxFeed({ runner }), new RegExp(`missing.*${ASSET}.*Refusing to restart build numbers`));
  const noRolling = (command, args) => (args.includes('--paginate') ? history : { status: 1, stdout: '', stderr: 'HTTP 404' });
  assert.throws(() => fetchLinuxFeed({ runner: noRolling }), /Refusing to restart build numbers/);
  const draftsOnly = (command, args) => (args.includes('--paginate') ? { status: 0, stdout: '', stderr: '' } : runner(command, args));
  assert.equal(fetchLinuxFeed({ runner: draftsOnly }), null, 'an unpublished draft from a failed first run is not history');
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
