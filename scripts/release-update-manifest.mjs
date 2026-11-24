#!/usr/bin/env node
// Turn the built package into the two files an automatic update needs on a
// GitHub release: a versioned (or dated/SHA Nightly) copy of the package, and
// apex-deck[-nightly]-update.json, the feed every installed Deck reads.
//
//   node scripts/release-update-manifest.mjs [--notes "What changed"] [--release DIR]
//                                            [--date YYYYMMDD] [--commit FULL_SHA] [--build-number N]
//
// A Linux server's Deck is installed from the same release: pass each built
// daemon with --linux arm64=path --linux x86_64=path, and the feed lists its
// checksum for Add a machine (src/phone/sshRun.ts) / Linux VPS updater.
//
// Reads release/Apex-Deck[-Nightly]-upgrade.pkg (from `npm run desktop:dmg`),
// refuses an ad hoc build, checks the app inside against the package's own
// sidecar, and writes both into release/<tag>-assets/. It publishes nothing:
// the steps it prints upload to a draft release, check the uploads, then publish,
// so no Deck sees the feed before every file it names is there.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fixedPackage } from './release-artifacts.mjs';
import { channel } from '../desktop/channel.mjs';
import { MANIFEST_NAME, parseManifest, REPO } from '../desktop/updater.mjs';

const DEFAULT_RELEASE = '/Users/tylercaldwell/Downloads/apex-deck/release';
/** lipo's names to Node's, which is what a running Deck compares. */
const ARCH = { arm64: 'arm64', x86_64: 'x64' };

export function nightlyTag(date, commit) {
  if (!/^[0-9]{8}$/.test(date ?? '')) throw new Error('Nightly date must be YYYYMMDD.');
  if (!/^[a-f0-9]{40}$/.test(commit ?? '')) throw new Error('Nightly commit must be a 40-character lowercase SHA.');
  return `nightly-${date}-${commit.slice(0, 7)}`;
}

export function assetName(version, arch, { date, commit } = {}) {
  if (channel.nightly) {
    if (!/^[0-9]{8}$/.test(date ?? '')) throw new Error('Nightly asset name requires YYYYMMDD date.');
    if (!/^[a-f0-9]{40}$/.test(commit ?? '')) throw new Error('Nightly asset name requires 40-character lowercase commit.');
    return `Apex-Deck-Nightly_${date}_${commit.slice(0, 7)}_${arch}.pkg`;
  }
  return `Apex-Deck-${version}-${arch}.pkg`;
}

/** The feed, checked by the same parser every installed Deck uses. */
export function buildManifest({ version, notes = '', minimumSystemVersion, archs, name, size, sha256, daemons = [], buildNumber, commit, tag }) {
  const packages = archs.map((lipo) => {
    const arch = ARCH[lipo];
    if (!arch) throw new Error(`Unsupported architecture ${lipo}`);
    return { arch, minimumSystemVersion, name, size, sha256 };
  });
  const manifest = channel.nightly
    ? { schemaVersion: 1, channel: 'nightly', version, buildNumber, commit, tag, notes, packages, daemons }
    : { schemaVersion: 1, version, notes, packages, daemons };
  parseManifest(manifest);
  return manifest;
}

/** The Developer ID team that signed `app`, refusing an ad hoc signature. */
export function teamOf(details) {
  const team = /^TeamIdentifier=([A-Z0-9]{10})$/m.exec(details)?.[1];
  if (!team) throw new Error('The package\'s app is signed ad hoc. Installed copies only accept a Developer ID build; rebuild with the Developer ID identity.');
  return team;
}

/** `--linux arch=path` flags into release asset names, sizes and checksums, copied beside the package. */
export function linuxDaemons(flags, folder) {
  const stem = channel.nightly ? 'apex-daemon-nightly-linux' : 'apex-daemon-linux';
  return flags.map((flag) => {
    const [arch, file] = [flag.slice(0, flag.indexOf('=')), flag.slice(flag.indexOf('=') + 1)];
    if (!['arm64', 'x86_64'].includes(arch) || !file) throw new Error(`--linux takes arm64=path or x86_64=path, not ${flag}`);
    const bytes = fs.readFileSync(file);
    const name = `${stem}-${arch}`;
    fs.writeFileSync(path.join(folder, name), bytes);
    return { arch, name, size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
  });
}

export function publishSteps(version, folder, name, daemons = [], { tag, buildNumber, commit } = {}) {
  const pkg = path.join(folder, name);
  const feed = path.join(folder, MANIFEST_NAME);
  const daemonArgs = daemons.map((entry) => ` '${path.join(folder, entry.name)}'`).join('');
  if (channel.nightly) {
    if (!/^nightly-[0-9]{8}-[a-f0-9]{7}$/.test(tag ?? '')) throw new Error('Nightly publish requires an immutable nightly-YYYYMMDD-<sha7> tag.');
    const label = buildNumber ? `Apex Deck Nightly ${version} (build ${buildNumber}, ${tag})` : `Apex Deck Nightly ${tag}`;
    const targetArg = commit && /^[a-f0-9]{40}$/.test(commit) ? ` --target ${commit}` : '';
    return [
      `gh release create ${tag} --repo ${REPO}${targetArg} --draft --prerelease --title "${label}" --notes-file <notes.md>`,
      `gh release upload ${tag} --repo ${REPO} '${pkg}'${daemonArgs}`,
      `gh release download ${tag} --repo ${REPO} --dir /tmp/apex-${tag}-check && shasum -a 256 /tmp/apex-${tag}-check/*  # must match the feed`,
      `gh release edit ${tag} --repo ${REPO} --draft=false --prerelease  # immutable prerelease; never advance latest`,
      `gh release upload nightly --repo ${REPO} --clobber '${feed}'  # advance rolling nightly feed only after immutable assets are published`,
    ];
  }
  const releaseTag = `v${version}`;
  return [
    `gh release create ${releaseTag} --repo ${REPO} --draft --title "Apex Deck ${version}" --notes-file <notes.md>`,
    `gh release upload ${releaseTag} --repo ${REPO} '${pkg}' '${feed}'${daemonArgs}`,
    `gh release download ${releaseTag} --repo ${REPO} --dir /tmp/apex-${releaseTag}-check && shasum -a 256 /tmp/apex-${releaseTag}-check/*  # must match the feed`,
    `gh release edit ${releaseTag} --repo ${REPO} --draft=false --latest  # only now does any Deck see it`,
  ];
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${path.basename(command)} failed: ${(result.stderr || result.stdout).trim()}`);
  return `${result.stdout}${result.stderr}`;
}

function flagValue(argv, name) {
  const at = argv.indexOf(name);
  return at >= 0 ? String(argv[at + 1] ?? '') : '';
}

function utcDateStamp() {
  return new Date().toISOString().slice(0, 10).replaceAll('-', '');
}

function main(argv) {
  const notes = flagValue(argv, '--notes');
  const releaseDir = path.resolve(flagValue(argv, '--release') || DEFAULT_RELEASE);
  const linux = argv.flatMap((arg, at) => (arg === '--linux' ? [String(argv[at + 1] ?? '')] : []));
  const fixed = fixedPackage(releaseDir);
  if (!fs.existsSync(fixed.pkg) || !fs.existsSync(fixed.manifest)) throw new Error(`No built package at ${fixed.pkg}; run npm run desktop:dmg first.`);
  const sidecar = JSON.parse(fs.readFileSync(fixed.manifest, 'utf8'));
  if (sidecar.dirty) throw new Error('The package was built from a checkout with uncommitted changes; publish only a clean build.');
  if (channel.nightly && sidecar.channel !== 'nightly') throw new Error('Refusing to publish a non-Nightly package to the Nightly feed.');
  if (!channel.nightly && sidecar.channel && sidecar.channel !== 'stable') throw new Error('Refusing to publish a Nightly package to the Stable feed.');

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-release-check-'));
  let info;
  try {
    const expanded = path.join(scratch, 'expanded');
    run('/usr/sbin/pkgutil', ['--expand-full', fixed.pkg, expanded]);
    const app = path.join(expanded, 'Payload', `${channel.PRODUCT}.app`);
    const team = teamOf(run('/usr/bin/codesign', ['-d', '--verbose=2', app]));
    run('/usr/bin/codesign', ['--verify', '--deep', '--strict', `-R=identifier "${channel.APP_ID}" and anchor apple generic and certificate leaf[subject.OU] = "${team}"`, app]);
    info = JSON.parse(run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path.join(app, 'Contents', 'Info.plist')]));
    info.archs = run('/usr/bin/lipo', ['-archs', path.join(app, 'Contents', 'MacOS', channel.PRODUCT)]).trim().split(/\s+/);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  const version = info.CFBundleShortVersionString;
  if (version !== sidecar.version) throw new Error(`The app says ${version} but the package sidecar says ${sidecar.version}.`);

  const arch = info.archs.length === 1 ? ARCH[info.archs[0]] ?? info.archs[0] : 'universal';
  let meta = {};
  let folderName = `v${version}-assets`;
  if (channel.nightly) {
    const buildNumber = Number(flagValue(argv, '--build-number') || sidecar.buildNumber || info.CFBundleVersion);
    if (!Number.isSafeInteger(buildNumber) || buildNumber <= 0) throw new Error('Nightly release requires a positive integer buildNumber.');
    if (String(info.CFBundleVersion ?? '').trim() !== String(buildNumber)) {
      throw new Error(`The Nightly app says build ${info.CFBundleVersion}, not ${buildNumber}.`);
    }
    const commit = flagValue(argv, '--commit') || sidecar.fullCommit || run('git', ['rev-parse', '--verify', 'HEAD']).trim();
    if (!/^[a-f0-9]{40}$/.test(commit) || (sidecar.commit && !commit.startsWith(sidecar.commit))) {
      throw new Error(`Nightly commit ${commit} does not match package sidecar commit ${sidecar.commit || 'unknown'}.`);
    }
    const date = flagValue(argv, '--date') || utcDateStamp();
    const tag = nightlyTag(date, commit);
    meta = { date, commit, buildNumber, tag };
    folderName = `${tag}-assets`;
  }

  const folder = path.join(releaseDir, folderName);
  fs.mkdirSync(folder, { recursive: true });
  const name = assetName(version, arch, meta);
  const target = path.join(folder, name);
  fs.copyFileSync(fixed.pkg, target);
  const daemons = linuxDaemons(linux, folder);
  const bytes = fs.readFileSync(target);
  const manifest = buildManifest({
    version, notes, name, size: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    minimumSystemVersion: info.LSMinimumSystemVersion ?? '13.0',
    archs: info.archs,
    daemons,
    ...meta,
  });
  fs.writeFileSync(path.join(folder, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`release-update-manifest: wrote ${target} and ${MANIFEST_NAME} (${version}, commit ${sidecar.commit || 'unknown'})`);
  console.log('Publish, in this order:');
  for (const step of publishSteps(version, folder, name, daemons, meta)) console.log(`  ${step}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); } catch (error) { console.error(`release-update-manifest: ${error.message}`); process.exitCode = 1; }
}
