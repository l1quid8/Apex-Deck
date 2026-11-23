#!/usr/bin/env node
// Turn the built Windows installer into the two files an automatic update needs
// on a GitHub release: a versioned copy of the installer, and the Windows feed
// every installed Windows Deck reads (desktop/updater.mjs).
//
//   node scripts/windows-update-manifest.mjs [--notes "What changed"]
//
// Writes both into release/windows-update/. It publishes nothing: add them to a
// draft release, because Windows Decks read the feed from the latest release.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WINDOWS_MANIFEST_NAME, parseManifest, fileSha256 } from '../desktop/updater.mjs';
import { channel } from '../desktop/channel.mjs';
import { windowsRelease, INSTALLER_NAME } from './package-win.mjs';
import { windowsOutput } from './windows-build.mjs';
import { verifyWindowsSetup } from './windows-update-smoke.mjs';

/** Windows 11's first build. */
export const MINIMUM_WINDOWS = '10.0.22000';
export const windowsAssetName = (version) => `Apex-Deck-${version}-x64-Setup.exe`;

/** The feed, checked by the same parser every installed Deck uses. */
export function buildWindowsManifest({ version, notes = '', size, sha256 }, nightly) {
  const name = nightly?.asset ?? windowsAssetName(version);
  const manifest = {
    schemaVersion: 1, version, notes,
    ...(nightly && { channel: 'nightly', buildNumber: nightly.buildNumber, commit: nightly.commit, tag: nightly.tag }),
    packages: [{ arch: 'x64', minimumSystemVersion: MINIMUM_WINDOWS, name, size, sha256 }],
  };
  parseManifest(manifest, { extension: '.exe' });
  return manifest;
}

async function main(argv) {
  const notesAt = argv.indexOf('--notes');
  const notes = notesAt >= 0 ? String(argv[notesAt + 1] ?? '') : '';
  const { version } = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  const nightly = windowsRelease();
  const installer = path.resolve(windowsOutput, nightly?.asset ?? INSTALLER_NAME);
  const folder = path.join(windowsOutput, nightly ? 'nightly' : 'windows-update');
  if (nightly) {
    const app = path.resolve(windowsOutput, 'win-unpacked', channel.PRODUCT + '.exe');
    await verifyWindowsSetup(installer, app, {version, buildNumber: nightly.buildNumber});
  }
  const size = fs.statSync(installer).size;
  const sha256 = await fileSha256(installer);
  const manifest = buildWindowsManifest({ version, notes, size, sha256 }, nightly);
  fs.mkdirSync(folder, { recursive: true });
  if (!nightly) fs.copyFileSync(installer, path.join(folder, windowsAssetName(version)));
  fs.writeFileSync(path.join(folder, WINDOWS_MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`windows-update-manifest: wrote ${folder} for ${version}\n${sha256}  ${installer}`);
  if (nightly) console.log(`Release owner: attach the installer to immutable prerelease ${nightly.tag} and its feed to rolling prerelease nightly. Keep both prereleases out of latest.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(process.argv.slice(2)); } catch (error) { console.error(`windows-update-manifest: ${error.message}`); process.exitCode = 1; }
}
