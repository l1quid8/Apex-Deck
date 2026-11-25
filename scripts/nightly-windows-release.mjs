#!/usr/bin/env node
// Plans, assembles, verifies and publishes Windows Nightly builds on their own.
//
//   node scripts/nightly-windows-release.mjs plan [--repo OWNER/REPO] [--sha FULL_SHA]
//     [--force] [--date YYYYMMDD] [--workflow daemon.yml] [--state-file PATH]
//     [--github-output PATH]
//   node scripts/nightly-windows-release.mjs assemble --out DIR --build DIR
//     --date YYYYMMDD --commit FULL_SHA --build-number N
//   node scripts/nightly-windows-release.mjs publish --assets-dir DIR [--repo OWNER/REPO]
//     [--current-feed PATH] [--dry-run] [--force]
//
// Windows owns its feed. It reads and writes only
// `apex-deck-nightly-update-windows.json` on the rolling `nightly` prerelease,
// keeps its own monotonic buildNumber, and never reads, rewrites or waits on
// the macOS or Linux feeds. The signed installer lives on a Windows-only
// release, nightly-windows-YYYYMMDD-<sha7> (the feed's `assetTag`, which the
// installed updater requires). Platforms share only the channel contract and
// the immutable git tag nightly-YYYYMMDD-<sha7> naming the source commit,
// created by whichever platform gets there first. The feed moves only after
// the installer has been verified locally and again after downloading it back.
//
// Runs with APEX_CHANNEL=nightly, so the feed is checked by the same parser
// every installed Windows Nightly uses.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { channel } from '../desktop/channel.mjs';
import { parseManifest, windowsAssetTag, WINDOWS_MANIFEST_NAME } from '../desktop/updater.mjs';
import { formatNightlyTag, sha256File, verifyFiles } from './nightly-linux-release.mjs';

export const DEFAULT_REPO = 'l1quid8/apex-deck';
export const DEFAULT_WORKFLOW = 'daemon.yml';
export const ROLLING_TAG = 'nightly';
export const WINDOWS_FEED_NAME = 'apex-deck-nightly-update-windows.json';
const ASSET_TAG_RE = /^nightly-windows-\d{8}-[0-9a-f]{7}$/;
const SHA40_RE = /^[a-f0-9]{40}$/;
const DATE_RE = /^[0-9]{8}$/;
const SIDECAR_LIMIT = 64 * 1024;

export const installerName = (date, commit) => `Apex-Deck-Nightly_${date}_${commit.slice(0, 7)}_x64-Setup.exe`;

/** Strictly parse a Windows Nightly feed, exactly as installed copies do, plus the naming rules this pipeline promises. */
export function parseWindowsFeed(value) {
  if (!channel.nightly || WINDOWS_MANIFEST_NAME !== WINDOWS_FEED_NAME) throw new Error('Windows Nightly feeds are parsed only with APEX_CHANNEL=nightly.');
  const feed = parseManifest(value, { extension: '.exe' });
  const [, date] = /^nightly-(\d{8})-/.exec(feed.tag);
  if (feed.packages.length !== 1 || feed.packages[0].arch !== 'x64' || feed.packages[0].name !== installerName(date, feed.commit)) {
    throw new Error(`Windows Nightly feed must list exactly ${installerName(date, feed.commit)}.`);
  }
  return { ...feed, date, installer: feed.packages[0] };
}

// daemon.yml runs Linux, macOS and Windows jobs in one run. A Windows Nightly
// needs every shared and Windows job green, and these Windows jobs to have run
// and passed. Naming them keeps a renamed or removed job from silently
// dropping a check: the planner then finds no eligible commit and says why.
export const REQUIRED_WINDOWS_JOBS = [
  'test-windows', 'test-windows-ipc', 'test-windows-checks', 'test-windows-daemon',
  'test-windows-app (1/4)', 'test-windows-app (2/4)', 'test-windows-app (3/4)', 'test-windows-app (4/4)',
];
const OTHER_PLATFORM_JOB = /\((?:ubuntu|macos)[^)]*\)/i;

/** True when every shared and Windows job finished green (skipped counts) and every required Windows job passed. */
export function windowsJobsGreen(jobs) {
  if (!Array.isArray(jobs)) return false;
  const mine = jobs.filter((job) => job && typeof job.name === 'string' && !OTHER_PLATFORM_JOB.test(job.name));
  return mine.every((job) => job.status === 'completed' && (job.conclusion === 'success' || job.conclusion === 'skipped')) &&
    REQUIRED_WINDOWS_JOBS.every((name) => mine.some((job) => job.name === name && job.conclusion === 'success'));
}

function candidateRuns(runs, targetSha) {
  const list = (Array.isArray(runs) ? runs : []).filter((run) => run && typeof run === 'object' &&
    run.head_branch === 'main' && run.event === 'push' && run.status === 'completed' && SHA40_RE.test(run.head_sha ?? '') &&
    (!targetSha || run.head_sha === targetSha));
  return list.sort((a, b) => (Date.parse(b.created_at ?? '') || 0) - (Date.parse(a.created_at ?? '') || 0) ||
    Number(b.id ?? 0) - Number(a.id ?? 0));
}

/** Newest push run on main whose Windows jobs are green, or the exact target SHA's. Jobs are always checked. */
export function pickGreenMainCommit(runs, { targetSha = '', jobsByRun = {} } = {}) {
  if (targetSha && !SHA40_RE.test(targetSha)) throw new Error(`Invalid target SHA: ${targetSha}`);
  const picked = candidateRuns(runs, targetSha).find((run) => windowsJobsGreen(jobsByRun?.[run.id]));
  return picked ? { commit: picked.head_sha, runId: picked.id ?? null } : null;
}

/** Fetch jobs, newest run first, stopping at the first Windows-green run. */
export function loadJobsUntilGreen(runs, { targetSha = '', fetchJobs }) {
  const jobsByRun = {};
  for (const run of candidateRuns(runs, targetSha)) {
    jobsByRun[run.id] = fetchJobs(run.id);
    if (windowsJobsGreen(jobsByRun[run.id])) break;
  }
  return jobsByRun;
}

/**
 * Decide whether to build, using only the Windows feed for the previous commit
 * and build number. `isNewer(published, candidate)` must say whether the
 * candidate descends from the published commit: a higher build number on older
 * code would look like an upgrade to every installed copy, so it never builds.
 * Undo a bad Nightly with a revert on main instead.
 */
export function planWindowsNightly({ runs, jobsByRun = {}, currentFeed = null, date = utcDateStamp(), targetSha = '', force = false, isNewer = () => false }) {
  if (!DATE_RE.test(date ?? '')) throw new Error('Nightly date must be YYYYMMDD.');
  const published = currentFeed ? parseWindowsFeed(currentFeed) : null;
  const lastCommit = published?.commit ?? null;
  const lastBuildNumber = published?.buildNumber ?? 0;
  const base = { date, lastCommit, lastBuildNumber };
  const candidate = pickGreenMainCommit(runs, { targetSha, jobsByRun });
  if (!candidate) {
    return { ...base, shouldBuild: false, reason: targetSha ? 'target_not_green' : 'no_green_main', commit: targetSha || null, tag: null, buildNumber: null };
  }
  if (!force && lastCommit === candidate.commit) {
    return { ...base, shouldBuild: false, reason: 'unchanged', commit: candidate.commit, tag: published.tag, buildNumber: lastBuildNumber };
  }
  if (lastCommit && lastCommit !== candidate.commit && !isNewer(lastCommit, candidate.commit)) {
    return { ...base, shouldBuild: false, reason: 'not_newer', commit: candidate.commit, tag: null, buildNumber: null };
  }
  return {
    ...base,
    shouldBuild: true,
    reason: lastCommit === candidate.commit ? 'forced' : (lastCommit ? 'changed' : 'initial'),
    commit: candidate.commit,
    tag: formatNightlyTag(date, candidate.commit),
    buildNumber: lastBuildNumber + 1,
  };
}

function regularFile(filePath, limit) {
  let stat;
  try { stat = fs.lstatSync(filePath); } catch { return `missing ${path.basename(filePath)}`; }
  if (!stat.isFile()) return `${path.basename(filePath)} is not a regular file`;
  if (stat.size <= 0 || stat.size > limit) return `${path.basename(filePath)} has invalid size ${stat.size}`;
  return null;
}

/**
 * Collect what the signing job produced (installer, its .sha256 and the feed
 * windows-update-manifest.mjs wrote from that installer) into one folder,
 * after checking the feed names exactly the build that was planned.
 */
export function assembleWindowsRelease({ out, build, date, commit, buildNumber, version }) {
  const tag = formatNightlyTag(date, commit);
  const name = installerName(date, commit);
  const files = { installer: path.join(build, name), sidecar: path.join(build, `${name}.sha256`), feed: path.join(build, 'nightly', WINDOWS_FEED_NAME) };
  const errors = [regularFile(files.installer, 4 * 1024 ** 3), regularFile(files.sidecar, SIDECAR_LIMIT), regularFile(files.feed, SIDECAR_LIMIT)].filter(Boolean);
  if (errors.length) throw new Error(`Windows Nightly build check failed: ${errors.join('; ')}`);
  const feed = parseWindowsFeed(JSON.parse(fs.readFileSync(files.feed, 'utf8')));
  const expected = { version, commit, buildNumber, tag, assetTag: windowsAssetTag(tag) };
  const wrong = Object.keys(expected).filter((key) => feed[key] !== expected[key]);
  if (wrong.length) throw new Error(`The Windows feed does not match the planned build: ${wrong.join(', ')}`);
  const sha256 = sha256File(files.installer);
  const size = fs.statSync(files.installer).size;
  if (feed.installer.sha256 !== sha256 || feed.installer.size !== size) throw new Error(`The Windows feed does not describe ${name}.`);
  const [sidecarHash, sidecarName] = fs.readFileSync(files.sidecar, 'utf8').trim().split(/\s+/);
  if (sidecarHash !== sha256 || sidecarName !== name) throw new Error(`${name}.sha256 does not match ${name}.`);
  fs.mkdirSync(out, { recursive: true });
  fs.copyFileSync(files.installer, path.join(out, name));
  fs.copyFileSync(files.sidecar, path.join(out, `${name}.sha256`));
  fs.copyFileSync(files.feed, path.join(out, WINDOWS_FEED_NAME));
  return feed;
}

/** Every file Windows uploads to its release, with the size and hash it must have. */
export function releaseFiles(feed, dir) {
  const { name, size, sha256 } = feed.installer;
  const extra = [`${name}.sha256`, WINDOWS_FEED_NAME].map((file) => {
    const problem = regularFile(path.join(dir, file), SIDECAR_LIMIT);
    return problem ? { name: file, problem } : { name: file, size: fs.statSync(path.join(dir, file)).size, sha256: sha256File(path.join(dir, file)) };
  });
  return [{ name, size, sha256 }, ...extra];
}

function failure(command, args, result) {
  return `${command} ${args.join(' ')} failed (${result.status}): ${(result.stderr || result.stdout || '').trim()}`;
}
const notFound = (result) => /release not found|HTTP 404/i.test(`${result.stderr ?? ''}${result.stdout ?? ''}`);

function defaultRunner(command, args, { allowFailure = false } = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) throw new Error(failure(command, args, result));
  return result;
}

function viewRelease(runner, repo, tag) {
  const args = ['release', 'view', tag, '--repo', repo, '--json', 'isDraft,targetCommitish,assets'];
  const result = runner('gh', args, { allowFailure: true });
  if (result.status === 0) return JSON.parse(result.stdout || '{}');
  if (notFound(result)) return null;
  throw new Error(failure('gh', args, result));
}

function tagCommit(runner, repo, tag) {
  const args = ['api', `repos/${repo}/git/ref/tags/${tag}`];
  const result = runner('gh', args, { allowFailure: true });
  if (result.status !== 0) {
    if (/HTTP 404|Not Found/i.test(`${result.stderr ?? ''}${result.stdout ?? ''}`)) return null;
    throw new Error(failure('gh', args, result));
  }
  let object = JSON.parse(result.stdout || 'null')?.object;
  if (object?.type === 'tag') object = JSON.parse(runner('gh', ['api', `repos/${repo}/git/tags/${object.sha}`]).stdout || 'null')?.object;
  if (object?.type !== 'commit' || !SHA40_RE.test(object.sha ?? '')) throw new Error(`Tag ${tag} does not resolve to a commit.`);
  return object.sha;
}

/**
 * Publish one Windows Nightly. Order: local verify -> Windows-only draft
 * release -> upload -> download back and verify -> make sure the shared source
 * tag points at this commit -> publish the Windows release -> advance only the
 * Windows feed. Files the live feed has advertised are never replaced.
 */
export function publishWindowsNightly({ assetsDir, currentFeed = null, repo = DEFAULT_REPO, dryRun = false, force = false, runner = defaultRunner }) {
  const feed = parseWindowsFeed(JSON.parse(fs.readFileSync(path.join(assetsDir, WINDOWS_FEED_NAME), 'utf8')));
  const published = currentFeed ? parseWindowsFeed(currentFeed) : null;
  const commands = [];
  const result = (stage, extra = {}) => ({ stage, tag: feed.tag, assetTag: feed.assetTag, commit: feed.commit, buildNumber: feed.buildNumber, published: false, skipped: false, errors: [], commands, ...extra });

  if (published && !force && published.commit === feed.commit) {
    return result('unchanged', { skipped: true, reason: `Commit ${feed.commit} is already on the Windows Nightly feed.` });
  }
  if (published && feed.buildNumber <= published.buildNumber) {
    return result('monotonic-check', { errors: [`Windows buildNumber ${feed.buildNumber} must be greater than published ${published.buildNumber}.`] });
  }
  if (published?.assetTag === feed.assetTag) {
    return result('immutable-tag', { errors: [`The Windows feed already points at ${feed.assetTag}; refusing to overwrite it. A same-day rebuild of the same commit is never allowed; rebuild on a later commit or day.`] });
  }

  const expected = releaseFiles(feed, assetsDir);
  const localErrors = verifyFiles(expected, assetsDir);
  if (localErrors.length) return result('local-verify', { errors: localErrors });

  const step = (args, opts) => {
    commands.push(['gh', ...args]);
    return dryRun ? { status: 0, stdout: '', stderr: '' } : runner('gh', args, opts);
  };

  const sourceCommit = dryRun ? null : tagCommit(runner, repo, feed.tag);
  if (sourceCommit && sourceCommit !== feed.commit) {
    return result('source-tag', { errors: [`Tag ${feed.tag} points at ${sourceCommit}, not ${feed.commit}.`] });
  }

  let release = dryRun ? null : viewRelease(runner, repo, feed.assetTag);
  if (release && release.targetCommitish && release.targetCommitish !== feed.commit) {
    return result('immutable-tag', { errors: [`Release ${feed.assetTag} targets ${release.targetCommitish}, not ${feed.commit}.`] });
  }
  // A published Windows release from an earlier attempt may be replaced only if
  // the feed never advertised it: its pinned feed copy must carry a build
  // number the live feed has not reached.
  if (release && !release.isDraft && published && (release.assets ?? []).some((asset) => asset?.name === WINDOWS_FEED_NAME)) {
    const check = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-windows-nightly-pinned-'));
    let pinned;
    try {
      runner('gh', ['release', 'download', feed.assetTag, '--repo', repo, '--dir', check, '--pattern', WINDOWS_FEED_NAME, '--clobber']);
      pinned = parseWindowsFeed(JSON.parse(fs.readFileSync(path.join(check, WINDOWS_FEED_NAME), 'utf8')));
    } finally {
      fs.rmSync(check, { recursive: true, force: true });
    }
    if (pinned.buildNumber <= published.buildNumber) {
      return result('immutable-tag', { errors: [`${feed.assetTag} holds Windows build ${pinned.buildNumber}, which the Windows feed (build ${published.buildNumber}) may have advertised; refusing to overwrite it.`] });
    }
  }
  if (!release) {
    const create = step(['release', 'create', feed.assetTag, '--repo', repo, '--target', feed.commit, '--draft', '--prerelease',
      '--title', `Apex Deck Nightly ${feed.tag} (Windows)`,
      '--notes', `Windows Nightly installer for ${feed.commit}, build ${feed.buildNumber}, listed in ${WINDOWS_FEED_NAME} on the rolling nightly prerelease.`]);
    if (create.status !== 0) throw new Error(failure('gh', commands.at(-1).slice(1), create));
    release = { isDraft: true };
  }
  step(['release', 'upload', feed.assetTag, '--repo', repo, '--clobber', ...expected.map((entry) => path.join(assetsDir, entry.name))]);

  const scratch = dryRun ? assetsDir : fs.mkdtempSync(path.join(os.tmpdir(), 'apex-windows-nightly-verify-'));
  try {
    for (const entry of expected) {
      step(['release', 'download', feed.assetTag, '--repo', repo, '--dir', scratch, '--pattern', entry.name, '--clobber']);
    }
    const downloadErrors = verifyFiles(expected, scratch);
    if (downloadErrors.length) return result('download-verify', { errors: downloadErrors });
  } finally {
    if (!dryRun) fs.rmSync(scratch, { recursive: true, force: true });
  }

  if (!dryRun && !sourceCommit) {
    const create = step(['api', '-X', 'POST', `repos/${repo}/git/refs`, '-f', `ref=refs/tags/${feed.tag}`, '-f', `sha=${feed.commit}`], { allowFailure: true });
    if (create.status !== 0) {
      const now = tagCommit(runner, repo, feed.tag);
      if (now !== feed.commit) {
        return result('source-tag', { errors: [now ? `Tag ${feed.tag} points at ${now}, not ${feed.commit}.` : failure('gh', commands.at(-1).slice(1), create)] });
      }
    }
  }

  if (release.isDraft) step(['release', 'edit', feed.assetTag, '--repo', repo, '--draft=false', '--prerelease']);

  const rolling = dryRun ? true : viewRelease(runner, repo, ROLLING_TAG);
  if (!rolling) {
    const create = step(['release', 'create', ROLLING_TAG, '--repo', repo, '--prerelease', '--title', 'Apex Deck Nightly',
      '--notes', 'Rolling Nightly feeds, one per platform. Each feed names the release that holds its assets.'],
    { allowFailure: true });
    if (create.status !== 0 && !viewRelease(runner, repo, ROLLING_TAG)) throw new Error(failure('gh', commands.at(-1).slice(1), create));
  }
  // Only the Windows feed: --clobber replaces just this one asset name.
  step(['release', 'upload', ROLLING_TAG, '--repo', repo, '--clobber', path.join(assetsDir, WINDOWS_FEED_NAME)]);
  return result('done', { published: !dryRun, dryRun });
}

function publishedWindowsReleaseTags(runner, repo) {
  const result = runner('gh', ['api', '--paginate', `repos/${repo}/releases?per_page=100`, '--jq', '.[] | select(.draft == false) | .tag_name']);
  return (result.stdout ?? '').split('\n').map((line) => line.trim()).filter((tag) => ASSET_TAG_RE.test(tag));
}

/**
 * Read the published Windows feed. Null only when no Windows Nightly has ever
 * been published; if Windows releases exist but the feed is gone, this throws
 * so build numbers never restart at 1.
 */
export function fetchWindowsFeed({ repo = DEFAULT_REPO, runner = defaultRunner } = {}) {
  const history = publishedWindowsReleaseTags(runner, repo);
  const missing = () => {
    if (!history.length) return null;
    throw new Error(`The Windows Nightly feed ${WINDOWS_FEED_NAME} is missing from the ${ROLLING_TAG} release, but published Windows release ${history[0]} exists. ` +
      `Refusing to restart build numbers. Restore it with: gh release download ${history[0]} --repo ${repo} --pattern ${WINDOWS_FEED_NAME} && ` +
      `gh release upload ${ROLLING_TAG} --repo ${repo} ${WINDOWS_FEED_NAME}`);
  };
  const args = ['api', `repos/${repo}/releases/tags/${ROLLING_TAG}`];
  const tagResult = runner('gh', args, { allowFailure: true });
  if (tagResult.status !== 0) {
    if (/HTTP 404/.test(`${tagResult.stderr}${tagResult.stdout}`)) return missing();
    throw new Error(failure('gh', args, tagResult));
  }
  const rolling = JSON.parse(tagResult.stdout || 'null');
  if (!rolling || !Array.isArray(rolling.assets)) throw new Error('Malformed rolling Nightly release metadata.');
  if (!rolling.assets.some((asset) => asset?.name === WINDOWS_FEED_NAME)) return missing();
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-windows-nightly-feed-'));
  try {
    runner('gh', ['release', 'download', ROLLING_TAG, '--repo', repo, '--dir', scratch, '--pattern', WINDOWS_FEED_NAME]);
    return JSON.parse(fs.readFileSync(path.join(scratch, WINDOWS_FEED_NAME), 'utf8'));
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

function utcDateStamp() {
  return new Date().toISOString().slice(0, 10).replaceAll('-', '');
}
const flag = (argv, name) => { const at = argv.indexOf(name); return at >= 0 ? (argv[at + 1] ?? '') : ''; };
const has = (argv, name) => argv.includes(name);

function main(argv) {
  const [command, ...rest] = argv;
  const repo = flag(rest, '--repo') || DEFAULT_REPO;
  if (command === 'plan') {
    const workflow = flag(rest, '--workflow') || DEFAULT_WORKFLOW;
    const targetSha = flag(rest, '--sha').trim();
    const stateFile = flag(rest, '--state-file');
    let state;
    if (stateFile) {
      state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    } else {
      const runs = JSON.parse(defaultRunner('gh', ['api', `repos/${repo}/actions/workflows/${workflow}/runs?branch=main&event=push&status=completed&per_page=30`]).stdout || '{}').workflow_runs ?? [];
      const fetchJobs = (id) => {
        const body = JSON.parse(defaultRunner('gh', ['api', `repos/${repo}/actions/runs/${id}/jobs?filter=latest&per_page=100`]).stdout || 'null');
        if (!body || !Array.isArray(body.jobs)) throw new Error(`Malformed job list for run ${id}.`);
        return body.jobs.map(({ name, status, conclusion }) => ({ name, status, conclusion }));
      };
      state = { runs, jobsByRun: loadJobsUntilGreen(runs, { targetSha, fetchJobs }), currentFeed: fetchWindowsFeed({ repo }) };
    }
    // GitHub's compare says "ahead" only when the candidate descends from the published commit.
    const isNewer = state.ahead ? (from, to) => state.ahead.includes(`${from}...${to}`)
      : (from, to) => defaultRunner('gh', ['api', `repos/${repo}/compare/${from}...${to}`, '--jq', '.status']).stdout.trim() === 'ahead';
    const plan = planWindowsNightly({ runs: state.runs ?? [], jobsByRun: state.jobsByRun ?? {}, currentFeed: state.currentFeed ?? null, date: flag(rest, '--date') || utcDateStamp(), targetSha, force: has(rest, '--force'), isNewer });
    const output = flag(rest, '--github-output');
    if (output) {
      fs.appendFileSync(output, `${[
        `should_build=${plan.shouldBuild}`, `reason=${plan.reason}`, `commit=${plan.commit ?? ''}`,
        `date=${plan.date}`, `tag=${plan.tag ?? ''}`, `build_number=${plan.buildNumber ?? ''}`,
      ].join('\n')}\n`);
    }
    console.log(JSON.stringify(plan, null, 2));
    if (targetSha && plan.reason === 'target_not_green') throw new Error(`Target SHA ${targetSha} has no Windows-green ${workflow} push run on main.`);
    if (targetSha && plan.reason === 'not_newer') throw new Error(`Target SHA ${targetSha} is not newer than ${plan.lastCommit} on the Windows feed; revert on main instead of rolling back.`);
    return;
  }
  if (command === 'assemble') {
    const { version } = JSON.parse(fs.readFileSync('package.json', 'utf8'));
    const feed = assembleWindowsRelease({
      out: path.resolve(flag(rest, '--out')), build: path.resolve(flag(rest, '--build')), date: flag(rest, '--date'),
      commit: flag(rest, '--commit'), buildNumber: Number(flag(rest, '--build-number')), version,
    });
    console.log(JSON.stringify(feed, null, 2));
    return;
  }
  if (command === 'publish') {
    const dryRun = has(rest, '--dry-run');
    const currentFile = flag(rest, '--current-feed');
    const currentFeed = currentFile ? JSON.parse(fs.readFileSync(currentFile, 'utf8')) : fetchWindowsFeed({ repo });
    const outcome = publishWindowsNightly({ assetsDir: path.resolve(flag(rest, '--assets-dir')), currentFeed, repo, dryRun, force: has(rest, '--force') });
    console.log(JSON.stringify(outcome, null, 2));
    if (!outcome.published && !outcome.skipped && !outcome.dryRun) throw new Error(`Windows Nightly feed held at ${outcome.stage}: ${outcome.errors.join('; ')}`);
    return;
  }
  throw new Error('Usage: node scripts/nightly-windows-release.mjs <plan|assemble|publish> [options]');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`nightly-windows-release: ${error.message}`);
    process.exitCode = 1;
  }
}
