#!/usr/bin/env node
// Plans, verifies, and publishes scheduled Nightly macOS + Linux daemon builds.
//
// Subcommands:
//   node scripts/nightly-release.mjs plan [--repo OWNER/REPO] [--date YYYYMMDD]
//     [--sha FULL_SHA] [--force] [--workflow daemon.yml] [--state-file PATH]
//     [--dry-run] [--github-output PATH]
//
//   node scripts/nightly-release.mjs publish --assets-dir DIR --manifest PATH
//     [--dmg-dir DIR | --extra-dir DIR] [--appimage-dir DIR]
//     [--repo OWNER/REPO] [--current-feed PATH]
//     [--verify-dir DIR] [--force] [--dry-run]
//
// Safety invariants:
// 1. Only a green `daemon.yml` run on `main` can be selected for Nightly.
// 2. If that green SHA already matches the published rolling `nightly` feed,
//    `plan` skips building and publishing (unless `--force`).
// 3. `publish` verifies every listed package, daemon, required macOS DMG, and
//    required Linux AppImage (with its checksum and metadata sidecars) locally, uploads to an immutable draft `--prerelease` tag
//    (`nightly-YYYYMMDD-<sha7>`), downloads every uploaded asset back, and
//    re-verifies exact byte size + SHA-256 (plus optional package verification)
//    BEFORE publishing the immutable release or advancing the rolling `nightly`
//    prerelease feed. Any missing or corrupted asset holds the feed and exits
//    nonzero.
// 4. Nightly releases are ALWAYS `--prerelease` and NEVER `--latest`.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { nightlyIdentity } from '../desktop/channelIdentity.mjs';

export const DEFAULT_REPO = 'l1quid8/apex-deck';
export const DEFAULT_WORKFLOW = 'daemon.yml';
export const ROLLING_TAG = 'nightly';
export const NIGHTLY_MANIFEST_NAME = 'apex-deck-nightly-update.json';

const VERSION_RE = /^\d+(?:\.\d+){1,3}$/;
const SHA40_RE = /^[a-f0-9]{40}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const DATE_RE = /^[0-9]{8}$/;
const NIGHTLY_TAG_RE = /^nightly-[0-9]{8}-[a-f0-9]{7}$/;
const PKG_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.pkg$/;
const DAEMON_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const PKG_ARCHES = new Set(['arm64', 'x64']);
const DAEMON_ARCHES = new Set(['arm64', 'x86_64']);
const PACKAGE_LIMIT = 4 * 1024 ** 3;
const APPIMAGE_ARCHES = ['x86_64', 'arm64'];
const APPIMAGE_METADATA_LIMIT = 64 * 1024;

export function formatNightlyTag(date, commit) {
  if (!DATE_RE.test(date ?? '')) throw new Error('Nightly date must be YYYYMMDD.');
  if (!SHA40_RE.test(commit ?? '')) throw new Error('Nightly commit must be a 40-character lowercase SHA.');
  return `nightly-${date}-${commit.slice(0, 7)}`;
}

/** Validate a Nightly update manifest regardless of the process's active channel. */
export function parseNightlyFeed(value) {
  if (!value || typeof value !== 'object' || value.schemaVersion !== 1) {
    throw new Error('Nightly feed schemaVersion must be 1.');
  }
  if (value.channel !== 'nightly') {
    throw new Error(`Nightly feed channel mismatch: ${String(value.channel ?? 'missing')}.`);
  }
  const identity = nightlyIdentity(value);
  if (typeof value.tag !== 'string' || !NIGHTLY_TAG_RE.test(value.tag) || !value.tag.endsWith(`-${identity.commit.slice(0, 7)}`)) {
    throw new Error(`Invalid immutable Nightly tag: ${String(value.tag ?? 'missing')}.`);
  }
  if (typeof value.version !== 'string' || !VERSION_RE.test(value.version)) {
    throw new Error(`Invalid Nightly version: ${String(value.version ?? 'missing')}.`);
  }
  if (value.notes !== undefined && (typeof value.notes !== 'string' || value.notes.length > 4000)) {
    throw new Error('Nightly feed notes are malformed.');
  }
  if (!Array.isArray(value.packages) || value.packages.length === 0 || value.packages.length > 8) {
    throw new Error('Nightly feed must list 1..8 packages.');
  }
  const packages = value.packages.map((entry) => {
    const ok = entry
      && PKG_ARCHES.has(entry.arch)
      && typeof entry.minimumSystemVersion === 'string' && VERSION_RE.test(entry.minimumSystemVersion)
      && typeof entry.name === 'string' && PKG_NAME_RE.test(entry.name)
      && Number.isSafeInteger(entry.size) && entry.size > 0 && entry.size <= PACKAGE_LIMIT
      && typeof entry.sha256 === 'string' && SHA256_RE.test(entry.sha256);
    if (!ok) throw new Error(`Nightly feed has a malformed package entry: ${JSON.stringify(entry)}`);
    return {
      arch: entry.arch,
      minimumSystemVersion: entry.minimumSystemVersion,
      name: entry.name,
      size: entry.size,
      sha256: entry.sha256,
    };
  });
  const rawDaemons = value.daemons === undefined ? [] : value.daemons;
  if (!Array.isArray(rawDaemons) || rawDaemons.length > 8) {
    throw new Error('Nightly feed daemons field is malformed.');
  }
  const daemons = rawDaemons.map((entry) => {
    const ok = entry
      && DAEMON_ARCHES.has(entry.arch)
      && typeof entry.name === 'string' && DAEMON_NAME_RE.test(entry.name)
      && Number.isSafeInteger(entry.size) && entry.size > 0 && entry.size <= PACKAGE_LIMIT
      && typeof entry.sha256 === 'string' && SHA256_RE.test(entry.sha256);
    if (!ok) throw new Error(`Nightly feed has a malformed daemon entry: ${JSON.stringify(entry)}`);
    return {
      arch: entry.arch,
      name: entry.name,
      size: entry.size,
      sha256: entry.sha256,
    };
  });
  return {
    schemaVersion: 1,
    channel: 'nightly',
    version: value.version,
    buildNumber: identity.buildNumber,
    commit: identity.commit,
    tag: value.tag,
    notes: value.notes ?? '',
    packages,
    daemons,
  };
}

/**
 * Pick the newest green `main` workflow run. When `targetSha` is provided,
 * require an explicitly green run for that exact commit (fail closed otherwise).
 */
export function pickGreenMainCommit(runs, { targetSha = '' } = {}) {
  const list = Array.isArray(runs) ? runs : [];
  if (targetSha && !SHA40_RE.test(targetSha)) {
    throw new Error(`Invalid target SHA: ${targetSha}`);
  }
  const green = list.filter((run) => {
    if (!run || typeof run !== 'object') return false;
    if (run.head_branch !== 'main') return false;
    if (run.status !== 'completed' || run.conclusion !== 'success') return false;
    if (!SHA40_RE.test(run.head_sha ?? '')) return false;
    if (!targetSha && run.event && run.event !== 'push') return false;
    return true;
  });
  green.sort((a, b) => {
    const timeA = Date.parse(a.created_at ?? a.run_started_at ?? '') || 0;
    const timeB = Date.parse(b.created_at ?? b.run_started_at ?? '') || 0;
    if (timeB !== timeA) return timeB - timeA;
    return Number(b.id ?? 0) - Number(a.id ?? 0);
  });
  if (targetSha) {
    const match = green.find((run) => run.head_sha === targetSha);
    return match ? { commit: match.head_sha, runId: match.id ?? null, createdAt: match.created_at ?? null } : null;
  }
  const picked = green[0];
  return picked ? { commit: picked.head_sha, runId: picked.id ?? null, createdAt: picked.created_at ?? null } : null;
}

/** Decide whether a scheduled Nightly build should run and with what identity. */
export function planNightlyRelease({
  runs,
  currentFeed = null,
  date = utcDateStamp(),
  targetSha = '',
  force = false,
  minBuildNumber = 1,
}) {
  if (!DATE_RE.test(date ?? '')) throw new Error('Nightly date must be YYYYMMDD.');
  if (!Number.isSafeInteger(minBuildNumber) || minBuildNumber <= 0) {
    throw new Error('minBuildNumber must be a positive integer.');
  }
  const published = currentFeed ? parseNightlyFeed(currentFeed) : null;
  const lastCommit = published?.commit ?? null;
  const lastBuildNumber = published?.buildNumber ?? 0;

  const candidate = pickGreenMainCommit(runs, { targetSha });
  if (!candidate) {
    return {
      shouldBuild: false,
      reason: targetSha ? 'target_not_green' : 'no_green_main',
      commit: targetSha || null,
      date,
      tag: null,
      buildNumber: null,
      lastCommit,
      lastBuildNumber,
      runId: null,
    };
  }

  if (!force && lastCommit === candidate.commit) {
    return {
      shouldBuild: false,
      reason: 'unchanged',
      commit: candidate.commit,
      date,
      tag: published?.tag ?? null,
      buildNumber: lastBuildNumber,
      lastCommit,
      lastBuildNumber,
      runId: candidate.runId,
    };
  }

  const buildNumber = Math.max(lastBuildNumber + 1, minBuildNumber);
  const tag = formatNightlyTag(date, candidate.commit);
  return {
    shouldBuild: true,
    reason: force && lastCommit === candidate.commit ? 'forced' : (lastCommit ? 'changed' : 'initial'),
    commit: candidate.commit,
    date,
    tag,
    buildNumber,
    lastCommit,
    lastBuildNumber,
    runId: candidate.runId,
  };
}

export function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

/**
 * Derive the required macOS Nightly DMG filename(s) for `manifest`.
 *
 * Each Nightly `.pkg` (`Apex-Deck-Nightly_<YYYYMMDD>_<sha7>_<arch>.pkg`, where
 * `<arch>` is `arm64`, `x64`, or `universal`) must ship alongside its matching
 * `.dmg` before the immutable release or rolling feed can advance.
 */
export function expectedDmgNames(manifest) {
  const parsed = parseNightlyFeed(manifest);
  const match = /^nightly-([0-9]{8})-([a-f0-9]{7})$/.exec(parsed.tag);
  const [, date, sha7] = match;
  const pkgPrefix = `Apex-Deck-Nightly_${date}_${sha7}_`;
  const names = [];
  for (const entry of parsed.packages) {
    let archTag = entry.arch;
    if (entry.name.startsWith(pkgPrefix) && entry.name.endsWith('.pkg')) {
      const suffix = entry.name.slice(pkgPrefix.length, -'.pkg'.length);
      if (suffix === 'arm64' || suffix === 'x64' || suffix === 'universal') {
        archTag = suffix;
      }
    }
    const dmgName = `${pkgPrefix}${archTag}.dmg`;
    if (!names.includes(dmgName)) names.push(dmgName);
  }
  return names;
}

function lstatOrNull(filePath) {
  try {
    return fs.lstatSync(filePath);
  } catch {
    return null;
  }
}

/**
 * Locate and hash every required Nightly DMG for `manifest`.
 *
 * Fails closed when any expected DMG is missing, non-regular, empty, or
 * disagrees with a sibling `.sha256` sidecar when one is present.
 */
export function resolveRequiredDmgs(manifest, { assetsDir, dmgDir = null, extraAssets = [] } = {}) {
  const requiredNames = expectedDmgNames(manifest);
  const explicitByName = new Map();
  const errors = [];
  for (const candidate of extraAssets) {
    if (!candidate) continue;
    const resolved = path.resolve(candidate);
    const base = path.basename(resolved);
    if (explicitByName.has(base) && explicitByName.get(base) !== resolved) {
      errors.push(`Ambiguous extra asset for ${base}`);
      continue;
    }
    explicitByName.set(base, resolved);
  }

  const dmgs = [];
  for (const name of requiredNames) {
    const candidates = [];
    if (explicitByName.has(name)) candidates.push(explicitByName.get(name));
    if (dmgDir) candidates.push(path.join(path.resolve(dmgDir), name));
    if (assetsDir) candidates.push(path.join(path.resolve(assetsDir), name));

    let filePath = null;
    let stat = null;
    for (const candidate of candidates) {
      const found = lstatOrNull(candidate);
      if (found) {
        filePath = candidate;
        stat = found;
        break;
      }
    }
    if (!filePath || !stat) {
      errors.push(`Missing required dmg asset: ${name}`);
      continue;
    }
    if (!stat.isFile()) {
      errors.push(`Asset is not a regular file: ${name}`);
      continue;
    }
    if (stat.size <= 0 || stat.size > PACKAGE_LIMIT) {
      errors.push(`Invalid size for dmg asset ${name}: ${stat.size}`);
      continue;
    }
    const actualSha = sha256File(filePath);
    const sidecarCandidate = explicitByName.get(`${name}.sha256`) ?? `${filePath}.sha256`;
    const sidecarStat = lstatOrNull(sidecarCandidate);
    if (sidecarStat) {
      if (!sidecarStat.isFile()) {
        errors.push(`DMG checksum sidecar is not a regular file: ${name}.sha256`);
        continue;
      }
      const expectedHash = fs.readFileSync(sidecarCandidate, 'utf8').trim().split(/\s+/)[0]?.toLowerCase() ?? '';
      if (!SHA256_RE.test(expectedHash) || expectedHash !== actualSha) {
        errors.push(`DMG checksum sidecar mismatch for ${name}: expected ${expectedHash || 'invalid'}, got ${actualSha}`);
        continue;
      }
    }
    dmgs.push({
      name,
      filePath,
      size: stat.size,
      sha256: actualSha,
    });
  }
  return { ok: errors.length === 0, dmgs, errors };
}

/**
 * Desktop Linux ships one Nightly AppImage per architecture. AppImages are
 * release assets only, not feed entries, so the shared feed schema and the
 * macOS updater are unchanged.
 */
export function expectedAppImageNames(manifest) {
  const parsed = parseNightlyFeed(manifest);
  const [, date, sha7] = /^nightly-([0-9]{8})-([a-f0-9]{7})$/.exec(parsed.tag);
  return APPIMAGE_ARCHES.map((arch) => `Apex-Deck-Nightly_${date}_${sha7}_${arch}.AppImage`);
}

function regularFileError(filePath, name, limit) {
  const stat = lstatOrNull(filePath);
  if (!stat) return `Missing required AppImage asset: ${name}`;
  if (!stat.isFile()) return `Asset is not a regular file: ${name}`;
  if (stat.size <= 0 || stat.size > limit) return `Invalid size for AppImage asset ${name}: ${stat.size}`;
  return null;
}

/**
 * Locate every required Nightly AppImage with its `.sha256` and `.json`
 * sidecars. Fails closed unless the checksum matches and the metadata names
 * this exact Nightly channel, version, commit, buildNumber, and file.
 *
 * Returns one entry per uploaded file (AppImage plus both sidecars) so the
 * post-upload download check covers all three.
 */
export function resolveRequiredAppImages(manifest, { appImageDir }) {
  const parsed = parseNightlyFeed(manifest);
  const errors = [];
  const appImages = [];
  for (const name of expectedAppImageNames(parsed)) {
    const filePath = path.join(path.resolve(appImageDir), name);
    const sidecarPath = `${filePath}.sha256`;
    const metadataPath = `${filePath}.json`;
    const fileErrors = [
      regularFileError(filePath, name, PACKAGE_LIMIT),
      regularFileError(sidecarPath, `${name}.sha256`, APPIMAGE_METADATA_LIMIT),
      regularFileError(metadataPath, `${name}.json`, APPIMAGE_METADATA_LIMIT),
    ].filter(Boolean);
    if (fileErrors.length > 0) {
      errors.push(...fileErrors);
      continue;
    }
    const size = fs.statSync(filePath).size;
    const sha256 = sha256File(filePath);
    const [sidecarHash, sidecarName] = fs.readFileSync(sidecarPath, 'utf8').trim().split(/\s+/);
    if (sidecarHash?.toLowerCase() !== sha256 || sidecarName !== name) {
      errors.push(`AppImage checksum sidecar mismatch for ${name}`);
      continue;
    }
    let metadata;
    try {
      metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
    } catch (error) {
      errors.push(`AppImage metadata is not JSON for ${name}: ${error.message}`);
      continue;
    }
    const expected = {
      channel: 'nightly',
      version: parsed.version,
      commit: parsed.commit,
      sourceCommit: parsed.commit,
      buildNumber: parsed.buildNumber,
      tag: parsed.tag,
      name,
      size,
      sha256,
    };
    const wrong = Object.keys(expected).filter((key) => metadata?.[key] !== expected[key]);
    if (wrong.length > 0) {
      errors.push(`AppImage metadata for ${name} does not match this Nightly build: ${wrong.join(', ')}`);
      continue;
    }
    for (const entryPath of [filePath, sidecarPath, metadataPath]) {
      appImages.push({
        name: path.basename(entryPath),
        filePath: entryPath,
        size: fs.statSync(entryPath).size,
        sha256: sha256File(entryPath),
      });
    }
  }
  return { ok: errors.length === 0, appImages, errors };
}

/** Verify every package, daemon, and required DMG listed exists in `dir` with matching size & SHA-256. */
export function verifyAssetFiles(manifest, dir, { dmgs = [], appImages = [], verifyPackage = null } = {}) {
  const checked = [];
  const errors = [];
  const seen = new Set();
  const entries = [
    ...manifest.packages.map((entry) => ({ kind: 'package', entry })),
    ...manifest.daemons.map((entry) => ({ kind: 'daemon', entry })),
    ...dmgs.map((entry) => ({ kind: 'dmg', entry })),
    ...appImages.map((entry) => ({ kind: 'appimage', entry })),
  ];
  for (const { kind, entry } of entries) {
    const key = `${kind}:${entry.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const filePath = entry.verifyPath ?? path.join(dir, entry.name);
    const stat = lstatOrNull(filePath);
    if (!stat) {
      errors.push(`Missing ${kind} asset: ${entry.name}`);
      continue;
    }
    if (!stat.isFile()) {
      errors.push(`Asset is not a regular file: ${entry.name}`);
      continue;
    }
    if (stat.size !== entry.size) {
      errors.push(`Size mismatch for ${entry.name}: expected ${entry.size}, got ${stat.size}`);
      continue;
    }
    const actualSha = sha256File(filePath);
    if (actualSha !== entry.sha256) {
      errors.push(`SHA-256 mismatch for ${entry.name}: expected ${entry.sha256}, got ${actualSha}`);
      continue;
    }
    if (kind === 'package' && verifyPackage) {
      try {
        verifyPackage(filePath, entry, manifest);
      } catch (error) {
        errors.push(`Package verification failed for ${entry.name}: ${error.message}`);
        continue;
      }
    }
    checked.push({ kind, name: entry.name, size: stat.size, sha256: actualSha });
  }
  return { ok: errors.length === 0, checked, errors };
}

function formatRunnerFailure(command, args, result) {
  return `${command} ${args.join(' ')} failed (${result.status}): ${(result.stderr || result.stdout || '').trim()}`;
}

export function isApiNotFound(result) {
  if (!result || result.status === 0) return false;
  const stderr = String(result.stderr ?? '');
  const stdout = String(result.stdout ?? '').trim();
  if (stdout) {
    try {
      const body = JSON.parse(stdout);
      const isNotFoundBody = body?.message === 'Not Found'
        && (body?.status === undefined || String(body.status) === '404');
      if (isNotFoundBody && (!stderr || /\bHTTP 404\b/.test(stderr))) return true;
      return false;
    } catch {
      return false;
    }
  }
  return /\bHTTP 404\b/.test(stderr);
}

function isReleaseNotFound(result) {
  if (!result || result.status === 0) return false;
  const text = `${result.stderr ?? ''}\n${result.stdout ?? ''}`;
  return /\brelease not found\b/i.test(text) || isApiNotFound(result);
}

function defaultRunner(command, args, { allowFailure = false } = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) {
    throw new Error(formatRunnerFailure(command, args, result));
  }
  return result;
}

function uniqueAssetPaths(manifest, assetsDir, requiredDmgs = [], requiredAppImages = []) {
  const names = new Set([
    ...manifest.packages.map((entry) => entry.name),
    ...manifest.daemons.map((entry) => entry.name),
  ]);
  const files = [...names].map((name) => path.join(assetsDir, name));
  for (const extra of [...requiredDmgs, ...requiredAppImages]) {
    if (extra?.filePath && !files.includes(extra.filePath)) files.push(extra.filePath);
  }
  return files;
}

/**
 * Publish an immutable Nightly prerelease and advance the rolling `nightly`
 * feed ONLY after local and post-upload asset verification (packages, Linux
 * daemons, and required macOS DMGs) both pass.
 *
 * When any check fails, the rolling `nightly` feed is held untouched and the
 * immutable tag remains unpublished.
 */
export function publishNightlyRelease({
  manifestPath,
  assetsDir,
  dmgDir = null,
  appImageDir = null,
  extraAssets = [],
  currentFeed = null,
  repo = DEFAULT_REPO,
  dryRun = false,
  force = false,
  verifyDir = null,
  runner = defaultRunner,
  verifyPackage = null,
}) {
  const manifest = parseNightlyFeed(JSON.parse(fs.readFileSync(manifestPath, 'utf8')));
  const published = currentFeed ? parseNightlyFeed(currentFeed) : null;
  const commands = [];

  if (published) {
    if (!force && published.commit === manifest.commit) {
      return {
        published: false,
        feedAdvanced: false,
        skipped: true,
        stage: 'unchanged',
        reason: `Commit ${manifest.commit} is already published on the rolling nightly feed.`,
        tag: manifest.tag,
        commit: manifest.commit,
        buildNumber: manifest.buildNumber,
        errors: [],
        commands,
      };
    }
    if (manifest.buildNumber <= published.buildNumber) {
      return {
        published: false,
        feedAdvanced: false,
        skipped: false,
        stage: 'monotonic-check',
        errors: [`Nightly buildNumber ${manifest.buildNumber} must be greater than published buildNumber ${published.buildNumber}.`],
        tag: manifest.tag,
        commit: manifest.commit,
        buildNumber: manifest.buildNumber,
        commands,
      };
    }
  }

  // Gate 1: Verify every local package, daemon, required macOS DMG, and
  // required Linux AppImage before touching GitHub.
  const localCheck = verifyAssetFiles(manifest, assetsDir, { verifyPackage });
  const localDmgs = resolveRequiredDmgs(manifest, { assetsDir, dmgDir, extraAssets });
  const localAppImages = resolveRequiredAppImages(manifest, { appImageDir: appImageDir ?? dmgDir ?? assetsDir });
  const localErrors = [...localCheck.errors, ...localDmgs.errors, ...localAppImages.errors];
  if (localErrors.length > 0) {
    return {
      published: false,
      feedAdvanced: false,
      skipped: false,
      stage: 'local-verify',
      errors: localErrors,
      tag: manifest.tag,
      commit: manifest.commit,
      buildNumber: manifest.buildNumber,
      commands,
    };
  }

  const uploadFiles = uniqueAssetPaths(manifest, assetsDir, localDmgs.dmgs, localAppImages.appImages);
  const title = `Apex Deck Nightly ${manifest.version} (build ${manifest.buildNumber}, ${manifest.tag})`;
  const notes = manifest.notes || `Nightly build ${manifest.buildNumber} from ${manifest.commit}.`;

  const execStep = (args, opts) => {
    commands.push(['gh', ...args]);
    if (dryRun) return { status: 0, stdout: '', stderr: '' };
    return runner('gh', args, opts);
  };

  // Create or reuse a draft immutable prerelease; never clobber an already published immutable tag.
  let existingDraft = false;
  if (!dryRun) {
    const viewArgs = ['release', 'view', manifest.tag, '--repo', repo, '--json', 'isDraft,isPrerelease'];
    const view = runner('gh', viewArgs, { allowFailure: true });
    if (view.status === 0) {
      const info = JSON.parse(view.stdout || '{}');
      if (!info.isDraft) {
        return {
          published: false,
          feedAdvanced: false,
          skipped: false,
          stage: 'immutable-tag',
          errors: [`Release ${manifest.tag} is already published; refusing to overwrite an immutable Nightly tag.`],
          tag: manifest.tag,
          commit: manifest.commit,
          buildNumber: manifest.buildNumber,
          commands,
        };
      }
      existingDraft = true;
    } else if (!isReleaseNotFound(view)) {
      return {
        published: false,
        feedAdvanced: false,
        skipped: false,
        stage: 'immutable-tag-check',
        errors: [formatRunnerFailure('gh', viewArgs, view)],
        tag: manifest.tag,
        commit: manifest.commit,
        buildNumber: manifest.buildNumber,
        commands,
      };
    }
  }

  if (!existingDraft) {
    execStep([
      'release', 'create', manifest.tag,
      '--repo', repo,
      '--target', manifest.commit,
      '--draft', '--prerelease',
      '--title', title,
      '--notes', notes,
    ]);
  }
  execStep(['release', 'upload', manifest.tag, '--repo', repo, '--clobber', ...uploadFiles]);

  // Gate 2: Download every uploaded asset (packages, Linux daemons, and required DMGs)
  // back (or check verifyDir in dry-run) and verify exact size + SHA-256 BEFORE
  // publishing the immutable tag or advancing the rolling `nightly` feed.
  const scratch = dryRun ? null : fs.mkdtempSync(path.join(os.tmpdir(), 'apex-nightly-verify-'));
  try {
    const checkDir = dryRun ? (verifyDir ?? assetsDir) : scratch;
    const listedNames = [...new Set([
      ...manifest.packages.map((entry) => entry.name),
      ...manifest.daemons.map((entry) => entry.name),
      ...localDmgs.dmgs.map((entry) => entry.name),
      ...localAppImages.appImages.map((entry) => entry.name),
    ])];
    for (const name of listedNames) {
      execStep(['release', 'download', manifest.tag, '--repo', repo, '--dir', checkDir, '--pattern', name]);
    }
    const verifyDmgs = dryRun && !verifyDir
      ? localDmgs.dmgs.map(({ name, size, sha256, filePath }) => ({ name, size, sha256, verifyPath: filePath }))
      : localDmgs.dmgs.map(({ name, size, sha256 }) => ({ name, size, sha256 }));
    const verifyAppImages = dryRun && !verifyDir
      ? localAppImages.appImages.map(({ name, size, sha256, filePath }) => ({ name, size, sha256, verifyPath: filePath }))
      : localAppImages.appImages.map(({ name, size, sha256 }) => ({ name, size, sha256 }));
    const downloadCheck = verifyAssetFiles(manifest, checkDir, { dmgs: verifyDmgs, appImages: verifyAppImages, verifyPackage });
    if (!downloadCheck.ok) {
      return {
        published: false,
        feedAdvanced: false,
        skipped: false,
        stage: 'download-verify',
        errors: downloadCheck.errors,
        tag: manifest.tag,
        commit: manifest.commit,
        buildNumber: manifest.buildNumber,
        commands,
      };
    }
  } finally {
    if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
  }

  // Gate passed: publish immutable prerelease first, then advance rolling `nightly` feed.
  execStep(['release', 'edit', manifest.tag, '--repo', repo, '--draft=false', '--prerelease']);

  let rollingExists = true;
  if (!dryRun) {
    const rollingArgs = ['release', 'view', ROLLING_TAG, '--repo', repo, '--json', 'tagName'];
    const rolling = runner('gh', rollingArgs, { allowFailure: true });
    if (rolling.status === 0) {
      rollingExists = true;
    } else if (isReleaseNotFound(rolling)) {
      rollingExists = false;
    } else {
      throw new Error(formatRunnerFailure('gh', rollingArgs, rolling));
    }
  }
  if (!rollingExists) {
    execStep([
      'release', 'create', ROLLING_TAG,
      '--repo', repo,
      '--prerelease',
      '--title', 'Apex Deck Nightly',
      '--notes', 'Rolling Nightly update feeds. Assets are published under immutable nightly-YYYYMMDD-<sha7> prerelease tags.',
    ]);
  }
  execStep(['release', 'upload', ROLLING_TAG, '--repo', repo, '--clobber', manifestPath]);

  return {
    published: true,
    feedAdvanced: true,
    skipped: false,
    stage: 'done',
    errors: [],
    tag: manifest.tag,
    commit: manifest.commit,
    buildNumber: manifest.buildNumber,
    dryRun,
    commands,
  };
}

function utcDateStamp() {
  return new Date().toISOString().slice(0, 10).replaceAll('-', '');
}

function flagValue(argv, name) {
  const at = argv.indexOf(name);
  return at >= 0 ? String(argv[at + 1] ?? '') : '';
}

function hasFlag(argv, name) {
  return argv.includes(name);
}

/**
 * Read the published rolling Nightly feed.
 *
 * Returns `null` ONLY after confirming the repository's releases API is
 * accessible (proving authorization and network health) AND either the rolling
 * `nightly` release tag returns HTTP 404 or it exists without the Nightly
 * manifest asset yet. Any authorization, network, server, download, or parse
 * failure throws so callers never reset `buildNumber` to 1 on a transient error.
 */
export function fetchCurrentFeed({ repo = DEFAULT_REPO, runner = defaultRunner } = {}) {
  // Step 1: Confirm repo visibility and `contents: read` access before
  // interpreting a 404 on the `nightly` tag as an absent release.
  const listArgs = ['api', `repos/${repo}/releases?per_page=1`];
  const listResult = runner('gh', listArgs);
  const listBody = JSON.parse(listResult.stdout || 'null');
  if (!Array.isArray(listBody)) {
    throw new Error(`Unexpected response from ${listArgs[1]} while checking release history.`);
  }

  // Step 2: Check whether the rolling `nightly` tag and its manifest exist.
  const tagArgs = ['api', `repos/${repo}/releases/tags/${ROLLING_TAG}`];
  const tagResult = runner('gh', tagArgs, { allowFailure: true });
  if (tagResult.status !== 0) {
    if (isApiNotFound(tagResult)) return null;
    throw new Error(`Failed to read rolling Nightly release metadata: ${formatRunnerFailure('gh', tagArgs, tagResult)}`);
  }

  const release = JSON.parse(tagResult.stdout || 'null');
  if (!release || typeof release !== 'object' || !Array.isArray(release.assets)) {
    throw new Error(`Malformed release metadata for tag ${ROLLING_TAG}.`);
  }
  const hasFeedAsset = release.assets.some((asset) => asset?.name === NIGHTLY_MANIFEST_NAME);
  if (!hasFeedAsset) return null;

  // Step 3: Asset is confirmed present; download and validate it strictly.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-nightly-feed-'));
  try {
    runner('gh', [
      'release', 'download', ROLLING_TAG,
      '--repo', repo,
      '--dir', scratch,
      '--pattern', NIGHTLY_MANIFEST_NAME,
    ]);
    const feedPath = path.join(scratch, NIGHTLY_MANIFEST_NAME);
    if (!fs.existsSync(feedPath)) {
      throw new Error(`Rolling Nightly release listed ${NIGHTLY_MANIFEST_NAME}, but download produced no file.`);
    }
    return parseNightlyFeed(JSON.parse(fs.readFileSync(feedPath, 'utf8')));
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

export function fetchGitHubState({ repo = DEFAULT_REPO, workflow = DEFAULT_WORKFLOW, runner = defaultRunner } = {}) {
  const runsResult = runner('gh', [
    'api',
    `repos/${repo}/actions/workflows/${workflow}/runs?branch=main&status=completed&per_page=30`,
  ]);
  const runs = JSON.parse(runsResult.stdout || '{}').workflow_runs ?? [];
  const currentFeed = fetchCurrentFeed({ repo, runner });
  return { runs, currentFeed };
}

function writeGitHubOutputs(outputPath, plan) {
  if (!outputPath) return;
  const lines = [
    `should_build=${plan.shouldBuild ? 'true' : 'false'}`,
    `reason=${plan.reason}`,
    `commit=${plan.commit ?? ''}`,
    `sha7=${plan.commit ? plan.commit.slice(0, 7) : ''}`,
    `date=${plan.date ?? ''}`,
    `tag=${plan.tag ?? ''}`,
    `build_number=${plan.buildNumber ?? ''}`,
    `last_commit=${plan.lastCommit ?? ''}`,
    `last_build_number=${plan.lastBuildNumber ?? 0}`,
  ];
  fs.appendFileSync(outputPath, `${lines.join('\n')}\n`);
}

function main(argv) {
  const [command, ...rest] = argv;
  if (command === 'plan') {
    const repo = flagValue(rest, '--repo') || DEFAULT_REPO;
    const workflow = flagValue(rest, '--workflow') || DEFAULT_WORKFLOW;
    const date = flagValue(rest, '--date') || utcDateStamp();
    const targetSha = flagValue(rest, '--sha').trim();
    const force = hasFlag(rest, '--force');
    const stateFile = flagValue(rest, '--state-file');
    const githubOutput = flagValue(rest, '--github-output');
    const state = stateFile
      ? JSON.parse(fs.readFileSync(path.resolve(stateFile), 'utf8'))
      : fetchGitHubState({ repo, workflow });
    const plan = planNightlyRelease({
      runs: state.runs ?? [],
      currentFeed: state.currentFeed ?? null,
      date,
      targetSha,
      force,
    });
    writeGitHubOutputs(githubOutput, plan);
    console.log(JSON.stringify(plan, null, 2));
    if (targetSha && !plan.shouldBuild && plan.reason === 'target_not_green') {
      throw new Error(`Target SHA ${targetSha} does not have a green ${workflow} run on main.`);
    }
    return;
  }

  if (command === 'publish') {
    const repo = flagValue(rest, '--repo') || DEFAULT_REPO;
    const assetsDir = path.resolve(flagValue(rest, '--assets-dir'));
    const manifestPath = path.resolve(flagValue(rest, '--manifest') || path.join(assetsDir, NIGHTLY_MANIFEST_NAME));
    const dmgDirFlag = flagValue(rest, '--dmg-dir') || flagValue(rest, '--extra-dir');
    const dmgDir = dmgDirFlag ? path.resolve(dmgDirFlag) : null;
    const appImageDir = flagValue(rest, '--appimage-dir') ? path.resolve(flagValue(rest, '--appimage-dir')) : null;
    const currentFeedFile = flagValue(rest, '--current-feed');
    const verifyDir = flagValue(rest, '--verify-dir') ? path.resolve(flagValue(rest, '--verify-dir')) : null;
    const dryRun = hasFlag(rest, '--dry-run');
    const force = hasFlag(rest, '--force');
    let currentFeed = null;
    if (currentFeedFile) {
      currentFeed = JSON.parse(fs.readFileSync(path.resolve(currentFeedFile), 'utf8'));
    } else if (!dryRun) {
      currentFeed = fetchCurrentFeed({ repo });
    }
    const result = publishNightlyRelease({
      manifestPath,
      assetsDir,
      dmgDir,
      appImageDir,
      currentFeed,
      repo,
      dryRun,
      force,
      verifyDir,
    });
    console.log(JSON.stringify(result, null, 2));
    if (!result.published && !result.skipped) {
      throw new Error(`Nightly feed held at ${result.stage}: ${result.errors.join('; ')}`);
    }
    return;
  }

  throw new Error('Usage: node scripts/nightly-release.mjs <plan|publish> [options]');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`nightly-release: ${error.message}`);
    process.exitCode = 1;
  }
}
