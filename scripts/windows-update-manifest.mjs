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
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WINDOWS_MANIFEST_NAME, parseManifest } from '../desktop/updater.mjs';

/** Windows 11's first build. */
export const MINIMUM_WINDOWS = '10.0.22000';
export const windowsAssetName = (version) => `Apex-Deck-${version}-x64-Setup.exe`;

/** The feed, checked by the same parser every installed Deck uses. */
export function buildWindowsManifest({ version, notes = '', size, sha256 }) {
  const manifest = {
    schemaVersion: 1, version, notes,
    packages: [{ arch: 'x64', minimumSystemVersion: MINIMUM_WINDOWS, name: windowsAssetName(version), size, sha256 }],
  };
  parseManifest(manifest, { extension: '.exe' });
  return manifest;
}

function main(argv) {
  const notesAt = argv.indexOf('--notes');
  const notes = notesAt >= 0 ? String(argv[notesAt + 1] ?? '') : '';
  const { version } = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  const bytes = fs.readFileSync(path.join('release', 'Apex-Deck-Setup.exe'));
  const folder = path.join('release', 'windows-update');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, windowsAssetName(version)), bytes);
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  const manifest = buildWindowsManifest({ version, notes, size: bytes.length, sha256 });
  fs.writeFileSync(path.join(folder, WINDOWS_MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`windows-update-manifest: wrote ${folder} for ${version}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); } catch (error) { console.error(`windows-update-manifest: ${error.message}`); process.exitCode = 1; }
}
