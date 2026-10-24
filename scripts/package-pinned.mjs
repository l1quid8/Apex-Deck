#!/usr/bin/env node
// Packages Apex Deck with one commit stamped into every artifact, onto one
// fixed installable name.
//
// Resolves the commit once, exports it to cargo (build.rs) and vite
// (vite.config.ts), and fails the run if the checkout moved while it built --
// a mixed package is worse than a missing one, because it installs fine and
// then reports "Different builds" for no reason the Human can act on.
//
// Every run ends at release/Apex-Deck-upgrade.pkg, with the package it replaced
// kept as release/Apex-Deck-upgrade.previous.pkg. Build leftovers (the unpacked
// app, staging files, half-written images, mounts) are cleared here, at the end
// of a failed run as well as a good one, because that is where they pile up.

import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { basename, resolve } from 'node:path';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { readStamp, stampEnv } from './build-stamp.mjs';
import { buildUpgrade } from './package-mac-upgrade.mjs';
import {
  adoptLegacyRollback,
  cleanupRelease,
  commitPackage,
  detachReleaseImages,
  stagingPackage,
} from './release-artifacts.mjs';

const log = (message) => console.log(`package-pinned: ${message}`);

function git(args) {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

/// Every .app that electron-builder left in release/, wherever it put it.
export function packagedApps(release) {
  const unpacked = readdirSync(release, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^mac(?:-arm64|-universal|-x64)?$/.test(entry.name))
    .map((entry) => resolve(release, entry.name));
  const apps = [];
  for (const dir of unpacked) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.endsWith('.app')) apps.push(resolve(dir, entry.name));
    }
  }
  return apps;
}

/// Read the stamp back out of what was actually produced. The checkout staying
/// put is necessary but not proof; this is the claim worth trusting.
export function assertStamped(apps, commit) {
  let checked = 0;
  for (const app of apps) {
    const artifacts = [
      ['UI bundle', resolve(app, 'Contents/Resources/app.asar')],
      ['service', resolve(app, 'Contents/Resources/bin/apex-daemon')],
    ];
    for (const [label, file] of artifacts) {
      if (!existsSync(file)) continue;
      if (!readFileSync(file).includes(commit)) {
        throw new Error(`the ${label} in ${basename(app)} does not carry ${commit}`);
      }
      checked += 1;
    }
  }
  if (checked === 0) throw new Error('found no packaged app to verify under release/mac-*.');
  return checked;
}

function main() {
  const release = resolve('release');
  const stamp = readStamp({ env: process.env, git });
  if (stamp.commit === 'unknown') {
    console.error('package-pinned: no commit to stamp; refusing to ship an unlabelled build.');
    return 1;
  }

  log(`stamping ${stamp.commit}${stamp.dirty ? '-dirty' : ''} into the app and the service`);

  // Clear the previous run's leftovers before building, so a failed build cannot
  // leave a half-written image or an unpacked app for the next one to trip over.
  // The newest versioned installer becomes the rollback first, so the package the
  // Human is running today is not deleted in the same breath.
  const adopted = adoptLegacyRollback(release);
  if (adopted) log(`kept ${adopted} as the rollback before clearing the old installers`);
  cleanupRelease(release, { log });
  detachReleaseImages(release, { log });

  let exitCode = 0;
  try {
    const result = spawnSync('npm', ['run', '_desktop:package', '--', ...process.argv.slice(2)], {
      stdio: 'inherit',
      env: stampEnv(stamp),
    });
    if (result.status !== 0) throw new Error(`the app build failed (${result.status ?? 'signal'})`);

    const after = git(['rev-parse', '--short=12', 'HEAD']);
    if (after !== stamp.commit) {
      throw new Error(`the checkout moved during the build (${stamp.commit} -> ${after}); artifacts are mixed, do not install them`);
    }

    const apps = packagedApps(release);
    log(`read ${stamp.commit} back out of ${assertStamped(apps, stamp.commit)} built artifact(s).`);

    if (process.env.APEX_DECK_SKIP_PKG === '1') {
      log('APEX_DECK_SKIP_PKG=1 set; leaving the installable package untouched.');
      return 0;
    }

    const app = apps.find((candidate) => basename(candidate) === 'Apex Deck.app') ?? apps[0];
    buildUpgrade(app, stagingPackage(release).pkg);
    // Only now, with a verified package on disk, is the fixed name replaced.
    const { pkg, previous, sidecar } = commitPackage(release, { commit: stamp.commit, dirty: stamp.dirty });
    log(`wrote ${pkg} (version ${sidecar.version}, stamp ${stamp.commit})`);
    if (previous) log(`kept the package it replaced as ${previous}`);
  } catch (error) {
    console.error(`package-pinned: ${error.message}`);
    exitCode = 1;
  } finally {
    // Always: a failed build is exactly when leftovers get left behind.
    cleanupRelease(release, { log });
    detachReleaseImages(release, { log });
  }
  return exitCode;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
