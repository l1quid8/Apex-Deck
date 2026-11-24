#!/usr/bin/env node
// Plans, assembles, verifies and publishes Linux Nightly builds on their own.
//
//   node scripts/nightly-linux-release.mjs plan [--repo OWNER/REPO] [--sha FULL_SHA]
//     [--force] [--date YYYYMMDD] [--workflow daemon.yml] [--state-file PATH]
//     [--github-output PATH]
//   node scripts/nightly-linux-release.mjs assemble --out DIR --date YYYYMMDD
//     --commit FULL_SHA --build-number N --build ARCH=DIR [--build ARCH=DIR] [--notes TEXT]
//   node scripts/nightly-linux-release.mjs publish --assets-dir DIR [--repo OWNER/REPO]
//     [--current-feed PATH] [--dry-run] [--force]
//
// Linux owns its feed. It reads and writes only `apex-deck-nightly-update-linux.json`
// on the rolling `nightly` prerelease, keeps its own monotonic buildNumber, and
// never reads, rewrites or waits on the macOS or Windows feeds. Platforms share
// the channel contract (channels.json, signing domains) and the immutable git
// tag nightly-YYYYMMDD-<sha7>, which names the source commit and is created by
// whichever platform gets there first. Linux assets live on a Linux-only
// release, nightly-linux-YYYYMMDD-<sha7> (the feed's `assetTag`), so no
// platform ever publishes, edits or waits on another platform's release. The
// rolling feed moves only after every Linux asset has been verified locally and
// again after downloading it back from GitHub.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const DEFAULT_REPO = 'l1quid8/apex-deck';
export const DEFAULT_WORKFLOW = 'daemon.yml';
export const ROLLING_TAG = 'nightly';
export const LINUX_FEED_NAME = 'apex-deck-nightly-update-linux.json';
export const ARCHES = ['x86_64', 'arm64'];

const SHA40_RE = /^[a-f0-9]{40}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const DATE_RE = /^[0-9]{8}$/;
const TAG_RE = /^nightly-([0-9]{8})-([a-f0-9]{7})$/;
const ASSET_TAG_PREFIX = 'nightly-linux-';
const VERSION_RE = /^\d+\.\d+\.\d+$/;
const ASSET_LIMIT = 4 * 1024 ** 3;
const SIDECAR_LIMIT = 64 * 1024;

export const daemonName = (arch) => `apex-daemon-nightly-linux-${arch}`;
export function appImageName(tag, arch) {
  const [, date, sha7] = TAG_RE.exec(tag) ?? [];
  if (!date) throw new Error(`Invalid Nightly tag: ${tag}`);
  return `Apex-Deck-Nightly_${date}_${sha7}_${arch}.AppImage`;
}
/** The Linux-only release that holds this Nightly's Linux assets. */
export function linuxAssetTag(tag) {
  const [, date, sha7] = TAG_RE.exec(tag ?? '') ?? [];
  if (!date) throw new Error(`Invalid Nightly tag: ${tag}`);
  return `${ASSET_TAG_PREFIX}${date}-${sha7}`;
}
export function formatNightlyTag(date, commit) {
  if (!DATE_RE.test(date ?? '')) throw new Error('Nightly date must be YYYYMMDD.');
  if (!SHA40_RE.test(commit ?? '')) throw new Error('Nightly commit must be a full lowercase SHA.');
  return `nightly-${date}-${commit.slice(0, 7)}`;
}

function assetEntry(entry, kind, expectedName) {
  const ok = entry && typeof entry === 'object' && ARCHES.includes(entry.arch) &&
    entry.name === expectedName(entry.arch) && Number.isSafeInteger(entry.size) &&
    entry.size > 0 && entry.size <= ASSET_LIMIT && SHA256_RE.test(entry.sha256 ?? '');
  if (!ok) throw new Error(`Linux Nightly feed has a malformed ${kind} entry: ${JSON.stringify(entry)}`);
  return { arch: entry.arch, name: entry.name, size: entry.size, sha256: entry.sha256 };
}

function assetList(value, kind, expectedName) {
  if (!Array.isArray(value)) throw new Error(`Linux Nightly feed must list ${kind}s.`);
  const list = value.map((entry) => assetEntry(entry, kind, expectedName));
  const arches = list.map((entry) => entry.arch).sort();
  if (arches.join() !== [...ARCHES].sort().join()) {
    throw new Error(`Linux Nightly feed must list exactly one ${kind} for each of ${ARCHES.join(', ')}.`);
  }
  return list;
}

/** Strictly parse the Linux Nightly feed. Every field the VPS and phone installers read is checked. */
export function parseLinuxFeed(value) {
  if (!value || typeof value !== 'object') throw new Error('Linux Nightly feed is not an object.');
  if (value.schemaVersion !== 1) throw new Error('Linux Nightly feed schemaVersion must be 1.');
  if (value.channel !== 'nightly') throw new Error(`Linux Nightly feed channel mismatch: ${String(value.channel ?? 'missing')}.`);
  if (value.platform !== 'linux') throw new Error(`Linux Nightly feed platform mismatch: ${String(value.platform ?? 'missing')}.`);
  if (typeof value.version !== 'string' || !VERSION_RE.test(value.version)) throw new Error('Linux Nightly feed version is malformed.');
  if (!Number.isSafeInteger(value.buildNumber) || value.buildNumber <= 0) throw new Error('Linux Nightly feed buildNumber must be a positive integer.');
  if (typeof value.commit !== 'string' || !SHA40_RE.test(value.commit)) throw new Error('Linux Nightly feed commit must be a full lowercase SHA.');
  if (typeof value.tag !== 'string' || !TAG_RE.test(value.tag) || !value.tag.endsWith(`-${value.commit.slice(0, 7)}`)) {
    throw new Error('Linux Nightly feed tag must be nightly-YYYYMMDD-<sha7> for its commit.');
  }
  if (value.assetTag !== linuxAssetTag(value.tag)) throw new Error(`Linux Nightly feed assetTag must be ${linuxAssetTag(value.tag)}.`);
  if (value.notes !== undefined && typeof value.notes !== 'string') throw new Error('Linux Nightly feed notes are malformed.');
  return {
    schemaVersion: 1,
    channel: 'nightly',
    platform: 'linux',
    version: value.version,
    buildNumber: value.buildNumber,
    commit: value.commit,
    tag: value.tag,
    assetTag: value.assetTag,
    notes: value.notes ?? '',
    daemons: assetList(value.daemons, 'daemon', daemonName),
    appImages: assetList(value.appImages, 'appImage', (arch) => appImageName(value.tag, arch)),
  };
}

// daemon.yml runs Linux, macOS and Windows jobs in one run. Linux eligibility
// looks only at the jobs that are not macOS or Windows, so another platform's
// failure or cancellation never holds a healthy Linux commit out of Nightly.
const OTHER_PLATFORM_JOB = /windows|macos/i;

/** True when every platform-neutral and Linux job finished green (skipped counts) and at least one succeeded. */
export function linuxJobsGreen(jobs) {
  if (!Array.isArray(jobs)) return false;
  const linux = jobs.filter((job) => job && typeof job.name === 'string' && !OTHER_PLATFORM_JOB.test(job.name));
  return linux.length > 0 &&
    linux.every((job) => job.status === 'completed' && (job.conclusion === 'success' || job.conclusion === 'skipped')) &&
    linux.some((job) => job.conclusion === 'success');
}

function candidateRuns(runs, targetSha) {
  const list = (Array.isArray(runs) ? runs : []).filter((run) => run && typeof run === 'object' &&
    run.head_branch === 'main' && run.status === 'completed' && SHA40_RE.test(run.head_sha ?? '') &&
    (targetSha ? run.head_sha === targetSha : (!run.event || run.event === 'push')));
  return list.sort((a, b) => (Date.parse(b.created_at ?? '') || 0) - (Date.parse(a.created_at ?? '') || 0) ||
    Number(b.id ?? 0) - Number(a.id ?? 0));
}

const runGreenForLinux = (run, jobsByRun) => run.conclusion === 'success' || linuxJobsGreen(jobsByRun?.[run.id]);

/**
 * Pick the newest completed push run on `main` whose Linux jobs are green, or
 * require the exact target SHA to have one. `jobsByRun` maps run id to its jobs
 * and is consulted only for runs whose overall conclusion is not success.
 */
export function pickGreenMainCommit(runs, { targetSha = '', jobsByRun = {} } = {}) {
  if (targetSha && !SHA40_RE.test(targetSha)) throw new Error(`Invalid target SHA: ${targetSha}`);
  const picked = candidateRuns(runs, targetSha).find((run) => runGreenForLinux(run, jobsByRun));
  return picked ? { commit: picked.head_sha, runId: picked.id ?? null } : null;
}

/** Fetch jobs, newest run first, only for runs that need them, stopping at the first Linux-green run. */
export function loadJobsUntilGreen(runs, { targetSha = '', fetchJobs }) {
  const jobsByRun = {};
  for (const run of candidateRuns(runs, targetSha)) {
    if (run.conclusion === 'success') break;
    jobsByRun[run.id] = fetchJobs(run.id);
    if (linuxJobsGreen(jobsByRun[run.id])) break;
  }
  return jobsByRun;
}

/** Decide whether to build, using only the Linux feed for the previous commit and build number. */
export function planLinuxNightly({ runs, jobsByRun = {}, currentFeed = null, date = utcDateStamp(), targetSha = '', force = false }) {
  if (!DATE_RE.test(date ?? '')) throw new Error('Nightly date must be YYYYMMDD.');
  const published = currentFeed ? parseLinuxFeed(currentFeed) : null;
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
  return {
    ...base,
    shouldBuild: true,
    reason: lastCommit === candidate.commit ? 'forced' : (lastCommit ? 'changed' : 'initial'),
    commit: candidate.commit,
    tag: formatNightlyTag(date, candidate.commit),
    buildNumber: lastBuildNumber + 1,
  };
}

export function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let read;
    while ((read = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, read));
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function regularFile(filePath, limit) {
  let stat;
  try { stat = fs.lstatSync(filePath); } catch { return `missing ${path.basename(filePath)}`; }
  if (!stat.isFile()) return `${path.basename(filePath)} is not a regular file`;
  if (stat.size <= 0 || stat.size > limit) return `${path.basename(filePath)} has invalid size ${stat.size}`;
  return null;
}

/**
 * Check one packaged AppImage folder (release/nightly from package-linux.mjs):
 * the AppImage, its .sha256 sidecar, its .json metadata, and the daemon that
 * was built into it. Returns the feed entries, or errors.
 */
export function inspectBuild(dir, { arch, version, commit, buildNumber, tag }) {
  const name = appImageName(tag, arch);
  const image = path.join(dir, name);
  const daemon = path.join(dir, 'apex-daemon');
  const errors = [image, daemon].map((file) => regularFile(file, ASSET_LIMIT))
    .concat([`${image}.sha256`, `${image}.json`].map((file) => regularFile(file, SIDECAR_LIMIT)))
    .filter(Boolean);
  if (errors.length) return { errors };
  const sha256 = sha256File(image);
  const size = fs.statSync(image).size;
  const [sidecarHash, sidecarName] = fs.readFileSync(`${image}.sha256`, 'utf8').trim().split(/\s+/);
  if (sidecarHash !== sha256 || sidecarName !== name) errors.push(`${name}.sha256 does not match ${name}`);
  let metadata = null;
  try { metadata = JSON.parse(fs.readFileSync(`${image}.json`, 'utf8')); } catch (error) { errors.push(`${name}.json is not JSON: ${error.message}`); }
  if (metadata) {
    const expected = { channel: 'nightly', version, commit, sourceCommit: commit, buildNumber, tag, name, size, sha256 };
    const wrong = Object.keys(expected).filter((key) => metadata[key] !== expected[key]);
    if (wrong.length) errors.push(`${name}.json does not match this Linux Nightly build: ${wrong.join(', ')}`);
  }
  return {
    errors,
    appImage: { arch, name, size, sha256 },
    daemon: { arch, name: daemonName(arch), size: fs.statSync(daemon).size, sha256: sha256File(daemon) },
    files: { image, daemon },
  };
}

/** Copy each architecture's build into one folder and write the Linux feed beside it. */
export function assembleLinuxRelease({ out, date, commit, buildNumber, version, notes = '', builds }) {
  const tag = formatNightlyTag(date, commit);
  if (!Number.isSafeInteger(buildNumber) || buildNumber <= 0) throw new Error('buildNumber must be a positive integer.');
  const archList = Object.keys(builds).sort();
  if (archList.join() !== [...ARCHES].sort().join()) throw new Error(`assemble needs one --build for each of ${ARCHES.join(', ')}.`);
  fs.mkdirSync(out, { recursive: true });
  const daemons = [];
  const appImages = [];
  const errors = [];
  for (const arch of ARCHES) {
    const result = inspectBuild(builds[arch], { arch, version, commit, buildNumber, tag });
    if (result.errors.length) { errors.push(...result.errors.map((error) => `${arch}: ${error}`)); continue; }
    fs.copyFileSync(result.files.daemon, path.join(out, result.daemon.name));
    for (const suffix of ['', '.sha256', '.json']) {
      fs.copyFileSync(`${result.files.image}${suffix}`, path.join(out, `${result.appImage.name}${suffix}`));
    }
    daemons.push(result.daemon);
    appImages.push(result.appImage);
  }
  if (errors.length) throw new Error(`Linux Nightly build check failed: ${errors.join('; ')}`);
  const feed = parseLinuxFeed({
    schemaVersion: 1, channel: 'nightly', platform: 'linux', version, buildNumber, commit, tag,
    assetTag: linuxAssetTag(tag), notes: notes || `Linux Nightly build ${buildNumber} (${tag}).`, daemons, appImages,
  });
  fs.writeFileSync(path.join(out, LINUX_FEED_NAME), `${JSON.stringify(feed, null, 2)}\n`);
  return feed;
}

/** Every file Linux uploads to the immutable release, with the size and hash it must have. */
export function releaseFiles(feed, dir) {
  const listed = [...feed.daemons, ...feed.appImages].map(({ name, size, sha256 }) => ({ name, size, sha256 }));
  const sidecars = feed.appImages.flatMap(({ name }) => [`${name}.sha256`, `${name}.json`]);
  const extra = [...sidecars, LINUX_FEED_NAME].map((name) => {
    const filePath = path.join(dir, name);
    const problem = regularFile(filePath, SIDECAR_LIMIT);
    return problem ? { name, problem } : { name, size: fs.statSync(filePath).size, sha256: sha256File(filePath) };
  });
  return [...listed, ...extra];
}

export function verifyFiles(expected, dir) {
  const errors = [];
  for (const entry of expected) {
    if (entry.problem) { errors.push(entry.problem); continue; }
    const filePath = path.join(dir, entry.name);
    const problem = regularFile(filePath, ASSET_LIMIT);
    if (problem) { errors.push(problem); continue; }
    const size = fs.statSync(filePath).size;
    if (size !== entry.size) { errors.push(`${entry.name} size ${size} != ${entry.size}`); continue; }
    if (sha256File(filePath) !== entry.sha256) errors.push(`${entry.name} SHA-256 mismatch`);
  }
  return errors;
}

function failure(command, args, result) {
  return `${command} ${args.join(' ')} failed (${result.status}): ${(result.stderr || result.stdout || '').trim()}`;
}
const notFound = (result) => /not found|HTTP 404|release not found/i.test(`${result.stderr ?? ''}${result.stdout ?? ''}`);

function defaultRunner(command, args, { allowFailure = false } = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) throw new Error(failure(command, args, result));
  return result;
}

/** Read a release, or null when it doesn't exist yet. */
function viewRelease(runner, repo, tag) {
  const args = ['release', 'view', tag, '--repo', repo, '--json', 'isDraft,targetCommitish,assets'];
  const result = runner('gh', args, { allowFailure: true });
  if (result.status === 0) return JSON.parse(result.stdout || '{}');
  if (notFound(result)) return null;
  throw new Error(failure('gh', args, result));
}

/** The commit a tag points at, peeling an annotated tag, or null when the tag is absent. */
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
 * Publish one Linux Nightly. Order: local verify -> Linux-only draft release
 * -> upload -> download back and verify -> publish the Linux release -> make
 * sure the shared source tag points at this commit -> advance only the Linux
 * feed. The Linux release is never shared, so a retry may replace its files
 * freely until the Linux feed points at it; after that they are immutable.
 */
export function publishLinuxNightly({ assetsDir, currentFeed = null, repo = DEFAULT_REPO, dryRun = false, force = false, runner = defaultRunner }) {
  const feed = parseLinuxFeed(JSON.parse(fs.readFileSync(path.join(assetsDir, LINUX_FEED_NAME), 'utf8')));
  const published = currentFeed ? parseLinuxFeed(currentFeed) : null;
  const commands = [];
  const result = (stage, extra = {}) => ({ stage, tag: feed.tag, assetTag: feed.assetTag, commit: feed.commit, buildNumber: feed.buildNumber, published: false, skipped: false, errors: [], commands, ...extra });

  if (published && !force && published.commit === feed.commit) {
    return result('unchanged', { skipped: true, reason: `Commit ${feed.commit} is already on the Linux Nightly feed.` });
  }
  if (published && feed.buildNumber <= published.buildNumber) {
    return result('monotonic-check', { errors: [`Linux buildNumber ${feed.buildNumber} must be greater than published ${published.buildNumber}.`] });
  }

  const expected = releaseFiles(feed, assetsDir);
  const localErrors = verifyFiles(expected, assetsDir);
  if (localErrors.length) return result('local-verify', { errors: localErrors });

  const step = (args, opts) => {
    commands.push(['gh', ...args]);
    return dryRun ? { status: 0, stdout: '', stderr: '' } : runner('gh', args, opts);
  };

  // The shared source tag must already point at this commit, or be absent.
  const sourceCommit = dryRun ? null : tagCommit(runner, repo, feed.tag);
  if (sourceCommit && sourceCommit !== feed.commit) {
    return result('source-tag', { errors: [`Tag ${feed.tag} points at ${sourceCommit}, not ${feed.commit}.`] });
  }

  let release = dryRun ? null : viewRelease(runner, repo, feed.assetTag);
  if (release && release.targetCommitish && release.targetCommitish !== feed.commit) {
    return result('immutable-tag', { errors: [`Release ${feed.assetTag} targets ${release.targetCommitish}, not ${feed.commit}.`] });
  }
  // Files the live Linux feed already points at are immutable. A forced
  // rebuild of the same commit on the same day would reuse their names with a
  // new build number inside, so it must wait for another day or commit.
  if (published?.assetTag === feed.assetTag) {
    return result('immutable-tag', { errors: [`The Linux feed already points at ${feed.assetTag}; refusing to overwrite it. Rebuild on a later commit or day.`] });
  }
  if (!release) {
    const create = step(['release', 'create', feed.assetTag, '--repo', repo, '--target', feed.commit, '--draft', '--prerelease',
      '--title', `Apex Deck Nightly ${feed.tag} (Linux)`,
      '--notes', `Linux Nightly assets for ${feed.commit}, listed in ${LINUX_FEED_NAME} on the rolling nightly prerelease.`]);
    if (create.status !== 0) throw new Error(failure('gh', commands.at(-1).slice(1), create));
    release = { isDraft: true };
  }
  step(['release', 'upload', feed.assetTag, '--repo', repo, '--clobber', ...expected.map((entry) => path.join(assetsDir, entry.name))]);

  const scratch = dryRun ? assetsDir : fs.mkdtempSync(path.join(os.tmpdir(), 'apex-linux-nightly-verify-'));
  try {
    for (const entry of expected) {
      step(['release', 'download', feed.assetTag, '--repo', repo, '--dir', scratch, '--pattern', entry.name, '--clobber']);
    }
    const downloadErrors = verifyFiles(expected, scratch);
    if (downloadErrors.length) return result('download-verify', { errors: downloadErrors });
  } finally {
    if (!dryRun) fs.rmSync(scratch, { recursive: true, force: true });
  }

  if (release.isDraft) step(['release', 'edit', feed.assetTag, '--repo', repo, '--draft=false', '--prerelease']);

  // Create the shared source tag if no platform has yet. A lost race is fine
  // as long as the winner points at the same commit.
  if (!dryRun && !sourceCommit) {
    const create = step(['api', '-X', 'POST', `repos/${repo}/git/refs`, '-f', `ref=refs/tags/${feed.tag}`, '-f', `sha=${feed.commit}`], { allowFailure: true });
    if (create.status !== 0) {
      const now = tagCommit(runner, repo, feed.tag);
      if (now !== feed.commit) {
        return result('source-tag', { errors: [now ? `Tag ${feed.tag} points at ${now}, not ${feed.commit}.` : failure('gh', commands.at(-1).slice(1), create)] });
      }
    }
  }

  let rolling = dryRun ? true : viewRelease(runner, repo, ROLLING_TAG);
  if (!rolling) {
    const create = step(['release', 'create', ROLLING_TAG, '--repo', repo, '--prerelease', '--title', 'Apex Deck Nightly',
      '--notes', 'Rolling Nightly feeds, one per platform. Each feed names the release that holds its assets.'],
    { allowFailure: true });
    if (create.status !== 0 && !viewRelease(runner, repo, ROLLING_TAG)) throw new Error(failure('gh', commands.at(-1).slice(1), create));
  }
  step(['release', 'upload', ROLLING_TAG, '--repo', repo, '--clobber', path.join(assetsDir, LINUX_FEED_NAME)]);
  return result('done', { published: true, dryRun });
}

/**
 * Read the published Linux feed. Returns null only when the repository is
 * readable and the rolling release or the Linux feed asset is absent, so a
 * transient error never resets the build number to 1.
 */
export function fetchLinuxFeed({ repo = DEFAULT_REPO, runner = defaultRunner } = {}) {
  const list = JSON.parse(runner('gh', ['api', `repos/${repo}/releases?per_page=1`]).stdout || 'null');
  if (!Array.isArray(list)) throw new Error('Unexpected response while checking release history.');
  const args = ['api', `repos/${repo}/releases/tags/${ROLLING_TAG}`];
  const tagResult = runner('gh', args, { allowFailure: true });
  if (tagResult.status !== 0) {
    if (/HTTP 404/.test(`${tagResult.stderr}${tagResult.stdout}`)) return null;
    throw new Error(failure('gh', args, tagResult));
  }
  const rolling = JSON.parse(tagResult.stdout || 'null');
  if (!rolling || !Array.isArray(rolling.assets)) throw new Error('Malformed rolling Nightly release metadata.');
  if (!rolling.assets.some((asset) => asset?.name === LINUX_FEED_NAME)) return null;
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-linux-nightly-feed-'));
  try {
    runner('gh', ['release', 'download', ROLLING_TAG, '--repo', repo, '--dir', scratch, '--pattern', LINUX_FEED_NAME]);
    return parseLinuxFeed(JSON.parse(fs.readFileSync(path.join(scratch, LINUX_FEED_NAME), 'utf8')));
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

function utcDateStamp() {
  return new Date().toISOString().slice(0, 10).replaceAll('-', '');
}
const flag = (argv, name) => { const at = argv.indexOf(name); return at >= 0 ? (argv[at + 1] ?? '') : ''; };
const flags = (argv, name) => argv.flatMap((value, at) => (value === name ? [argv[at + 1] ?? ''] : []));
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
      const runs = JSON.parse(defaultRunner('gh', ['api', `repos/${repo}/actions/workflows/${workflow}/runs?branch=main&status=completed&per_page=30`]).stdout || '{}').workflow_runs ?? [];
      const fetchJobs = (id) => {
        const body = JSON.parse(defaultRunner('gh', ['api', `repos/${repo}/actions/runs/${id}/jobs?filter=latest&per_page=100`]).stdout || 'null');
        if (!body || !Array.isArray(body.jobs)) throw new Error(`Malformed job list for run ${id}.`);
        return body.jobs.map(({ name, status, conclusion }) => ({ name, status, conclusion }));
      };
      state = { runs, jobsByRun: loadJobsUntilGreen(runs, { targetSha, fetchJobs }), currentFeed: fetchLinuxFeed({ repo }) };
    }
    const plan = planLinuxNightly({ runs: state.runs ?? [], jobsByRun: state.jobsByRun ?? {}, currentFeed: state.currentFeed ?? null, date: flag(rest, '--date') || utcDateStamp(), targetSha, force: has(rest, '--force') });
    const output = flag(rest, '--github-output');
    if (output) {
      fs.appendFileSync(output, `${[
        `should_build=${plan.shouldBuild}`, `reason=${plan.reason}`, `commit=${plan.commit ?? ''}`,
        `date=${plan.date}`, `tag=${plan.tag ?? ''}`, `build_number=${plan.buildNumber ?? ''}`,
      ].join('\n')}\n`);
    }
    console.log(JSON.stringify(plan, null, 2));
    if (targetSha && plan.reason === 'target_not_green') throw new Error(`Target SHA ${targetSha} has no green ${workflow} run on main.`);
    return;
  }
  if (command === 'assemble') {
    const builds = Object.fromEntries(flags(rest, '--build').map((value) => {
      const at = value.indexOf('=');
      if (at <= 0) throw new Error(`--build takes ARCH=DIR, not ${value}`);
      return [value.slice(0, at), path.resolve(value.slice(at + 1))];
    }));
    const { version } = JSON.parse(fs.readFileSync('package.json', 'utf8'));
    const feed = assembleLinuxRelease({
      out: path.resolve(flag(rest, '--out')), date: flag(rest, '--date'), commit: flag(rest, '--commit'),
      buildNumber: Number(flag(rest, '--build-number')), version, notes: flag(rest, '--notes'), builds,
    });
    console.log(JSON.stringify(feed, null, 2));
    return;
  }
  if (command === 'publish') {
    const dryRun = has(rest, '--dry-run');
    const currentFile = flag(rest, '--current-feed');
    const currentFeed = currentFile ? JSON.parse(fs.readFileSync(currentFile, 'utf8')) : (dryRun ? null : fetchLinuxFeed({ repo }));
    const outcome = publishLinuxNightly({ assetsDir: path.resolve(flag(rest, '--assets-dir')), currentFeed, repo, dryRun, force: has(rest, '--force') });
    console.log(JSON.stringify(outcome, null, 2));
    if (!outcome.published && !outcome.skipped) throw new Error(`Linux Nightly feed held at ${outcome.stage}: ${outcome.errors.join('; ')}`);
    return;
  }
  throw new Error('Usage: node scripts/nightly-linux-release.mjs <plan|assemble|publish> [options]');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`nightly-linux-release: ${error.message}`);
    process.exitCode = 1;
  }
}
