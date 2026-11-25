import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { channel } from '../desktop/channel.mjs';
import {
  REQUIRED_WINDOWS_JOBS,
  WINDOWS_FEED_NAME,
  assembleWindowsRelease,
  fetchWindowsFeed,
  installerName,
  loadJobsUntilGreen,
  planWindowsNightly,
  publishWindowsNightly,
  windowsJobsGreen,
} from '../scripts/nightly-windows-release.mjs';
import { buildWindowsManifest } from '../scripts/windows-update-manifest.mjs';
import { nightlyRelease } from '../scripts/windows-build.mjs';

const yaml = createRequire(import.meta.url)('js-yaml');
const SHA_OLD = '11c1ade33ad9f6dc2d80ff32a68e159d501fde38';
const SHA_NEW = '41702564203e86e178dedda3887abc117a13d246';
const DATE = '20261125';
const TAG = `nightly-${DATE}-${SHA_NEW.slice(0, 7)}`;
const ASSET_TAG = `nightly-windows-${DATE}-${SHA_NEW.slice(0, 7)}`;
const VERSION = '0.9.19';
const nightlyOnly = { skip: channel.nightly ? false : 'Windows Nightly feeds are parsed with APEX_CHANNEL=nightly' };
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'windows-nightly-test-'));

const greenJobs = () => [
  { name: 'changes', status: 'completed', conclusion: 'success' },
  { name: 'versions-agree', status: 'completed', conclusion: 'success' },
  { name: 'protocol-types', status: 'completed', conclusion: 'success' },
  ...REQUIRED_WINDOWS_JOBS.map((name) => ({ name, status: 'completed', conclusion: 'success' })),
  { name: 'test (ubuntu-22.04, daemon)', status: 'completed', conclusion: 'success' },
  { name: 'test (macos-latest, host)', status: 'completed', conclusion: 'success' },
  { name: 'build (ubuntu-22.04, x86_64)', status: 'completed', conclusion: 'success' },
];
const run = (id, sha, created, extra = {}) => ({ id, head_sha: sha, head_branch: 'main', event: 'push', status: 'completed', conclusion: 'success', created_at: created, ...extra });

function feedFor({ commit = SHA_NEW, buildNumber = 2, date = DATE, bytes = Buffer.from('signed installer') } = {}) {
  const nightly = nightlyRelease(commit, String(buildNumber), date);
  return buildWindowsManifest({ version: VERSION, size: bytes.length, sha256: sha256(bytes) }, nightly);
}

/** What the signing job uploads: release/nightly-windows/{Setup.exe, .sha256, nightly/feed}. */
function signedBuild(options = {}) {
  const dir = tmp();
  const bytes = options.bytes ?? Buffer.from('signed installer');
  const feed = feedFor({ ...options, bytes });
  const name = feed.packages[0].name;
  fs.writeFileSync(path.join(dir, name), bytes);
  fs.writeFileSync(path.join(dir, `${name}.sha256`), `${sha256(bytes)}  ${name}\n`);
  fs.mkdirSync(path.join(dir, 'nightly'));
  fs.writeFileSync(path.join(dir, 'nightly', WINDOWS_FEED_NAME), `${JSON.stringify(feed, null, 2)}\n`);
  return { dir, feed, name, bytes };
}

test('Stable test runs still exercise the Nightly feed, publish and updater checks', { skip: channel.nightly ? 'already running as Nightly' : false }, () => {
  const files = ['tests/nightly-windows-release.test.mjs', 'tests/desktop-updater.test.mjs', 'tests/release-update-manifest.test.mjs'];
  const { NODE_TEST_CONTEXT, ...env } = { ...process.env, APEX_CHANNEL: 'nightly' };
  const child = spawnSync(process.execPath, ['--test', ...files], { encoding: 'utf8', env, timeout: 120000 });
  assert.equal(child.status, 0, `${child.stdout}
${child.stderr}`.slice(-4000));
});

test('a Windows Nightly needs every shared and Windows job green, whatever Linux and macOS did', () => {
  assert.equal(windowsJobsGreen(greenJobs()), true);
  const otherPlatformsFailed = greenJobs().map((job) => (/ubuntu|macos/.test(job.name) ? { ...job, conclusion: 'failure' } : job));
  assert.equal(windowsJobsGreen(otherPlatformsFailed), true);
  for (const name of [...REQUIRED_WINDOWS_JOBS, 'versions-agree']) {
    assert.equal(windowsJobsGreen(greenJobs().map((job) => (job.name === name ? { ...job, conclusion: 'failure' } : job))), false, name);
  }
  // A skipped or renamed Windows job is missing evidence, not a pass.
  assert.equal(windowsJobsGreen(greenJobs().map((job) => (job.name === 'test-windows' ? { ...job, conclusion: 'skipped' } : job))), false);
  assert.equal(windowsJobsGreen(greenJobs().map((job) => (job.name === 'test-windows-daemon' ? { ...job, name: 'windows-daemon' } : job))), false);
  assert.equal(windowsJobsGreen(greenJobs().map((job) => (job.name === 'changes' ? { ...job, status: 'in_progress', conclusion: null } : job))), false);
  assert.equal(windowsJobsGreen(null), false);
});

test('jobs are checked even for a run GitHub calls a success, newest first', () => {
  const runs = [run(1, SHA_OLD, '2026-11-24T01:00:00Z'), run(2, SHA_NEW, '2026-11-25T01:00:00Z'), run(3, 'f'.repeat(40), '2026-11-26T01:00:00Z', { event: 'pull_request' })];
  const fetched = [];
  const jobsByRun = loadJobsUntilGreen(runs, { fetchJobs: (id) => { fetched.push(id); return id === 2 ? [{ name: 'test-windows', status: 'completed', conclusion: 'success' }] : greenJobs(); } });
  assert.deepEqual(fetched, [2, 1], 'pull request runs never count, and every candidate run has its jobs read');
  const plan = planWindowsNightly({ runs, jobsByRun, date: DATE });
  assert.equal(plan.commit, SHA_OLD, 'a run missing Windows evidence is passed over');
});

test('build numbers come only from the Windows feed and only go up', nightlyOnly, () => {
  const runs = [run(2, SHA_NEW, '2026-11-25T01:00:00Z')];
  const jobsByRun = { 2: greenJobs() };
  const first = planWindowsNightly({ runs, jobsByRun, date: DATE });
  assert.deepEqual([first.shouldBuild, first.reason, first.buildNumber, first.tag], [true, 'initial', 1, TAG]);
  const published = feedFor({ commit: SHA_OLD, buildNumber: 41, date: '20261124' });
  const newer = (from, to) => from === SHA_OLD && to === SHA_NEW;
  assert.deepEqual(planWindowsNightly({ runs, jobsByRun, currentFeed: published, date: DATE, isNewer: newer }).buildNumber, 42);
  // An older or unrelated commit never ships under a higher build number, even forced.
  const rollback = planWindowsNightly({ runs, jobsByRun, currentFeed: published, date: DATE, force: true, isNewer: () => false });
  assert.deepEqual([rollback.shouldBuild, rollback.reason], [false, 'not_newer']);
  const same = feedFor({ commit: SHA_NEW, buildNumber: 42 });
  assert.equal(planWindowsNightly({ runs, jobsByRun, currentFeed: same, date: DATE }).reason, 'unchanged');
  assert.equal(planWindowsNightly({ runs, jobsByRun, currentFeed: same, date: DATE, force: true }).buildNumber, 43);
  assert.equal(planWindowsNightly({ runs, jobsByRun, date: DATE, targetSha: SHA_OLD }).reason, 'target_not_green');
  assert.throws(() => planWindowsNightly({ runs, jobsByRun, date: DATE, targetSha: 'main' }), /Invalid target SHA/);
});

test('assemble takes only the installer the feed describes, for the planned build', nightlyOnly, () => {
  const { dir, name } = signedBuild();
  const out = tmp();
  const feed = assembleWindowsRelease({ out, build: dir, date: DATE, commit: SHA_NEW, buildNumber: 2, version: VERSION });
  assert.equal(feed.assetTag, ASSET_TAG);
  assert.deepEqual(fs.readdirSync(out).sort(), [name, `${name}.sha256`, WINDOWS_FEED_NAME].sort());
  assert.throws(() => assembleWindowsRelease({ out: tmp(), build: dir, date: DATE, commit: SHA_NEW, buildNumber: 3, version: VERSION }), /buildNumber/);
  fs.writeFileSync(path.join(dir, name), 'swapped after the feed was written');
  assert.throws(() => assembleWindowsRelease({ out: tmp(), build: dir, date: DATE, commit: SHA_NEW, buildNumber: 2, version: VERSION }), /does not describe/);
});

/** A fake gh that serves uploads back from memory. */
function fakeGitHub({ releases = {}, tags = {}, corrupt = false } = {}) {
  const uploaded = {};
  const calls = [];
  const runner = (command, args) => {
    calls.push(args);
    const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
    if (args[0] === 'api' && args[1].includes('/git/ref/tags/')) {
      const sha = tags[args[1].split('/git/ref/tags/')[1]];
      return sha ? ok(JSON.stringify({ object: { type: 'commit', sha } })) : { status: 1, stdout: '', stderr: 'HTTP 404: Not Found' };
    }
    if (args[0] === 'api' && args.includes('POST')) { tags[args.find((a) => a.startsWith('ref=')).slice('ref=refs/tags/'.length)] = args.find((a) => a.startsWith('sha=')).slice(4); return ok('{}'); }
    if (args[0] === 'release' && args[1] === 'view') {
      return releases[args[2]] ? ok(JSON.stringify(releases[args[2]])) : { status: 1, stdout: '', stderr: 'release not found' };
    }
    if (args[0] === 'release' && args[1] === 'create') { releases[args[2]] = { isDraft: args.includes('--draft'), assets: [] }; return ok(); }
    if (args[0] === 'release' && args[1] === 'upload') {
      for (const file of args.slice(args.indexOf('--clobber') + 1)) (uploaded[args[2]] ??= {})[path.basename(file)] = fs.readFileSync(file);
      return ok();
    }
    if (args[0] === 'release' && args[1] === 'download') {
      const name = args[args.indexOf('--pattern') + 1];
      const bytes = uploaded[args[2]]?.[name];
      fs.writeFileSync(path.join(args[args.indexOf('--dir') + 1], name), corrupt && name.endsWith('.exe') ? Buffer.from('tampered') : bytes);
      return ok();
    }
    if (args[0] === 'release' && args[1] === 'edit') { releases[args[2]].isDraft = false; return ok(); }
    throw new Error(`unexpected gh ${args.join(' ')}`);
  };
  return { runner, uploaded, calls, tags, releases };
}

function assembled(options) {
  const { dir } = signedBuild(options);
  const out = tmp();
  assembleWindowsRelease({ out, build: dir, date: options?.date ?? DATE, commit: options?.commit ?? SHA_NEW, buildNumber: options?.buildNumber ?? 2, version: VERSION });
  return out;
}

test('publish verifies the download, tags the source, then moves only the Windows feed', nightlyOnly, () => {
  const assetsDir = assembled();
  const gh = fakeGitHub({ releases: { nightly: { isDraft: false, assets: [] } } });
  const outcome = publishWindowsNightly({ assetsDir, currentFeed: feedFor({ commit: SHA_OLD, buildNumber: 1, date: '20261124' }), runner: gh.runner });
  assert.equal(outcome.published, true, outcome.errors.join('; '));
  assert.deepEqual(Object.keys(gh.uploaded.nightly), [WINDOWS_FEED_NAME], 'the rolling release gets the Windows feed and nothing else');
  assert.equal(gh.tags[TAG], SHA_NEW);
  assert.equal(gh.releases[ASSET_TAG].isDraft, false);
  const order = gh.calls.map((args) => args.slice(0, 3).join(' ') + ' ');
  const at = (prefix) => { const found = order.indexOf(prefix); assert.notEqual(found, -1, prefix); return found; };
  assert.ok(at(`release create ${ASSET_TAG} `) < at(`release download ${ASSET_TAG} `));
  assert.ok(at(`release download ${ASSET_TAG} `) < at('api -X POST '));
  assert.ok(at('api -X POST ') < at(`release edit ${ASSET_TAG} `));
  assert.ok(at(`release edit ${ASSET_TAG} `) < at('release upload nightly '));
  assert.ok(!gh.calls.flat().includes('--latest'), 'Nightly never becomes GitHub latest');
});

test('any failed check holds the Windows feed', nightlyOnly, () => {
  const current = feedFor({ commit: SHA_OLD, buildNumber: 5, date: '20261124' });
  const corrupt = fakeGitHub();
  const bad = publishWindowsNightly({ assetsDir: assembled(), currentFeed: current, runner: corrupt.runner });
  assert.equal(bad.published, false); assert.equal(bad.stage, 'monotonic-check');

  const tampered = fakeGitHub({ corrupt: true });
  const held = publishWindowsNightly({ assetsDir: assembled({ buildNumber: 6 }), currentFeed: current, runner: tampered.runner });
  assert.equal(held.stage, 'download-verify');
  assert.equal(tampered.uploaded.nightly, undefined);

  const wrongTag = fakeGitHub({ tags: { [TAG]: SHA_OLD } });
  assert.equal(publishWindowsNightly({ assetsDir: assembled({ buildNumber: 6 }), currentFeed: current, runner: wrongTag.runner }).stage, 'source-tag');

  const live = feedFor({ commit: SHA_NEW, buildNumber: 6 });
  const again = publishWindowsNightly({ assetsDir: assembled({ buildNumber: 7 }), currentFeed: live, runner: fakeGitHub().runner, force: true });
  assert.equal(again.stage, 'immutable-tag', 'files the live feed advertised are never replaced');
});

test('a dry run uploads nothing and says what it would do', nightlyOnly, () => {
  const gh = fakeGitHub();
  const outcome = publishWindowsNightly({ assetsDir: assembled(), runner: gh.runner, dryRun: true });
  assert.deepEqual([outcome.stage, outcome.published, outcome.dryRun], ['done', false, true]);
  assert.deepEqual(gh.calls, []);
  assert.ok(outcome.commands.some((args) => args.join(' ').startsWith(`gh release upload nightly --repo l1quid8/apex-deck --clobber`)));
});

test('a missing Windows feed never restarts build numbers once one has shipped', () => {
  const runner = (command, args) => {
    if (args.includes('--paginate')) return { status: 0, stdout: `nightly-linux-20261125-46b0fc7\n${ASSET_TAG}\n`, stderr: '' };
    return { status: 0, stdout: JSON.stringify({ assets: [{ name: 'apex-deck-nightly-update-linux.json' }] }), stderr: '' };
  };
  assert.throws(() => fetchWindowsFeed({ runner }), /Refusing to restart build numbers/);
  const fresh = (command, args) => (args.includes('--paginate') ? { status: 0, stdout: 'nightly-linux-20261125-46b0fc7\n', stderr: '' } : { status: 1, stdout: '', stderr: 'HTTP 404' });
  assert.equal(fetchWindowsFeed({ runner: fresh }), null);
});

test('the required Windows jobs are the ones daemon.yml really runs', () => {
  const daemon = yaml.load(fs.readFileSync('.github/workflows/daemon.yml', 'utf8'));
  const names = Object.entries(daemon.jobs).flatMap(([id, job]) => (job.strategy?.matrix?.shard
    ? job.strategy.matrix.shard.map((shard) => job.name.replace('${{ matrix.shard }}', shard))
    : [job.name ?? id]));
  for (const name of REQUIRED_WINDOWS_JOBS) assert.ok(names.includes(name), `${name} is not a daemon.yml job`);
});

test('installer names match the merged Windows packager', () => {
  assert.equal(installerName(DATE, SHA_NEW), nightlyRelease(SHA_NEW, '1', DATE).asset);
});

test('only the signing job can reach Azure, and only from main through its environment', () => {
  const workflow = yaml.load(fs.readFileSync('.github/workflows/nightly-windows.yml', 'utf8'));
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.equal(workflow.jobs.plan.if, "github.ref == 'refs/heads/main'");
  for (const [name, job] of Object.entries(workflow.jobs)) {
    const steps = JSON.stringify(job.steps);
    if (name === 'sign') {
      assert.equal(job.environment, 'windows-nightly-signing');
      assert.deepEqual(job.permissions, { contents: 'read', 'id-token': 'write' });
      assert.match(steps, /npm ci --ignore-scripts/);
      const index = (pattern) => job.steps.findIndex((step) => pattern.test(JSON.stringify(step)));
      assert.ok(index(/npm ci --ignore-scripts/) < index(/azure\/login/), 'packages are installed before the Azure login exists');
      assert.equal(job.steps.find((step) => /actions\/checkout/.test(step.uses ?? '')).with['persist-credentials'], false);
      assert.doesNotMatch(steps, /npm run|npm test/);
      assert.doesNotMatch(steps, /package-win\.mjs --compile|"npm ci"|cargo /, 'the signing job builds nothing');
      continue;
    }
    assert.ok(!JSON.stringify(job).includes('id-token'), `${name} has no OIDC token`);
    assert.doesNotMatch(steps, /azure\/login/, `${name} never signs in to Azure`);
  }
  assert.deepEqual(workflow.jobs.publish.permissions, { contents: 'write' });
  for (const job of Object.values(workflow.jobs)) {
    for (const step of job.steps.filter((s) => s.uses)) assert.match(step.uses, /@[0-9a-f]{40}$/, `${step.uses} is pinned`);
  }
  assert.ok(workflow.on.workflow_dispatch.inputs.dry_run);
  for (const job of ['build', 'sign', 'publish']) {
    assert.ok(JSON.stringify(workflow.jobs[job].steps).includes('needs.plan.outputs.commit'), `${job} checks out the planned commit`);
  }
});
