#!/usr/bin/env node
// Turn the built package into the two files an automatic update needs on a
// GitHub release: a versioned copy of the package, and apex-deck-update.json,
// the feed every installed Deck reads (desktop/updater.mjs).
//
//   node scripts/release-update-manifest.mjs [--notes "What changed"]
//
// Reads release/Apex-Deck-upgrade.pkg (from `npm run desktop:dmg`), refuses an
// ad hoc build, checks the app inside against the package's own sidecar, and
// writes both into release/v<version>-assets/. It publishes nothing: the steps
// it prints upload to a draft release, check the uploads, then publish, so no
// Deck sees the feed before every file it names is there.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fixedPackage } from './release-artifacts.mjs';
import { MANIFEST_NAME, parseManifest, REPO } from '../desktop/updater.mjs';

const RELEASE = '/Users/tylercaldwell/Downloads/apex-deck/release';
/** lipo's names to Node's, which is what a running Deck compares. */
const ARCH = { arm64: 'arm64', x86_64: 'x64' };

export const assetName = (version, arch) => `Apex-Deck-${version}-${arch}.pkg`;

/** The feed, checked by the same parser every installed Deck uses. */
export function buildManifest({ version, notes = '', minimumSystemVersion, archs, name, size, sha256 }) {
  const packages = archs.map((lipo) => {
    const arch = ARCH[lipo];
    if (!arch) throw new Error(`Unsupported architecture ${lipo}`);
    return { arch, minimumSystemVersion, name, size, sha256 };
  });
  const manifest = { schemaVersion: 1, version, notes, packages };
  parseManifest(manifest);
  return manifest;
}

/** The Developer ID team that signed `app`, refusing an ad hoc signature. */
export function teamOf(details) {
  const team = /^TeamIdentifier=([A-Z0-9]{10})$/m.exec(details)?.[1];
  if (!team) throw new Error('The package\'s app is signed ad hoc. Installed copies only accept a Developer ID build; rebuild with the Developer ID identity.');
  return team;
}

export function publishSteps(version, folder, name) {
  const tag = `v${version}`;
  const pkg = path.join(folder, name);
  const feed = path.join(folder, MANIFEST_NAME);
  return [
    `gh release create ${tag} --repo ${REPO} --draft --title "Apex Deck ${version}" --notes-file <notes.md>`,
    `gh release upload ${tag} --repo ${REPO} '${pkg}' '${feed}'`,
    `gh release download ${tag} --repo ${REPO} --dir /tmp/apex-${tag}-check && shasum -a 256 /tmp/apex-${tag}-check/*  # must match the feed`,
    `gh release edit ${tag} --repo ${REPO} --draft=false --latest  # only now does any Deck see it`,
  ];
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${path.basename(command)} failed: ${(result.stderr || result.stdout).trim()}`);
  return `${result.stdout}${result.stderr}`;
}

function main(argv) {
  const notesAt = argv.indexOf('--notes');
  const notes = notesAt >= 0 ? String(argv[notesAt + 1] ?? '') : '';
  const fixed = fixedPackage(RELEASE);
  if (!fs.existsSync(fixed.pkg) || !fs.existsSync(fixed.manifest)) throw new Error(`No built package at ${fixed.pkg}; run npm run desktop:dmg first.`);
  const sidecar = JSON.parse(fs.readFileSync(fixed.manifest, 'utf8'));
  if (sidecar.dirty) throw new Error('The package was built from a checkout with uncommitted changes; publish only a clean build.');

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-release-check-'));
  let info;
  try {
    const expanded = path.join(scratch, 'expanded');
    run('/usr/sbin/pkgutil', ['--expand-full', fixed.pkg, expanded]);
    const app = path.join(expanded, 'Payload', 'Apex Deck.app');
    const team = teamOf(run('/usr/bin/codesign', ['-d', '--verbose=2', app]));
    run('/usr/bin/codesign', ['--verify', '--deep', '--strict', `-R=identifier "dev.apexdeck.app" and anchor apple generic and certificate leaf[subject.OU] = "${team}"`, app]);
    info = JSON.parse(run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path.join(app, 'Contents', 'Info.plist')]));
    info.archs = run('/usr/bin/lipo', ['-archs', path.join(app, 'Contents', 'MacOS', 'Apex Deck')]).trim().split(/\s+/);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  const version = info.CFBundleShortVersionString;
  if (version !== sidecar.version) throw new Error(`The app says ${version} but the package sidecar says ${sidecar.version}.`);

  const folder = path.join(RELEASE, `v${version}-assets`);
  fs.mkdirSync(folder, { recursive: true });
  const name = assetName(version, info.archs.length === 1 ? ARCH[info.archs[0]] ?? info.archs[0] : 'universal');
  const target = path.join(folder, name);
  fs.copyFileSync(fixed.pkg, target);
  const bytes = fs.readFileSync(target);
  const manifest = buildManifest({
    version, notes, name, size: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    minimumSystemVersion: info.LSMinimumSystemVersion ?? '13.0',
    archs: info.archs,
  });
  fs.writeFileSync(path.join(folder, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`release-update-manifest: wrote ${target} and ${MANIFEST_NAME} (${version}, commit ${sidecar.commit || 'unknown'})`);
  console.log('Publish, in this order:');
  for (const step of publishSteps(version, folder, name)) console.log(`  ${step}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); } catch (error) { console.error(`release-update-manifest: ${error.message}`); process.exitCode = 1; }
}
