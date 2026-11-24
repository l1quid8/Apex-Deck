#!/usr/bin/env node
// Packages Apex Deck (Stable or Nightly) with one commit stamped into every
// artifact, onto one fixed installable name per channel.
//
// Resolves the commit once, exports it to cargo (build.rs) and vite
// (vite.config.ts), and fails the run if the checkout moved while it built --
// a mixed package is worse than a missing one, because it installs fine and
// then reports "Different builds" for no reason the Human can act on.
//
// Every run ends at release/Apex-Deck[-Nightly]-upgrade.pkg, with the package
// it replaced kept as release/Apex-Deck[-Nightly]-upgrade.previous.pkg. Build
// leftovers (the unpacked app, staging files, half-written images, mounts) are
// cleared here, at the end of a failed run as well as a good one, because that
// is where they pile up.

import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { basename, resolve } from 'node:path';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { channel as activeChannel } from '../desktop/channel.mjs';
import { readStamp, stampEnv } from './build-stamp.mjs';
import { nightlyBuildNumber } from './package-mac.mjs';
import { buildUpgrade } from './package-mac-upgrade.mjs';
import {
  adoptLegacyRollback,
  cleanupRelease,
  commitPackage,
  detachReleaseImages,
  stagingPackage,
} from './release-artifacts.mjs';

const log = (message) => console.log(`package-pinned: ${message}`);

const FULL_SHA_RE = /^[a-f0-9]{40}$/i;
const SHORT_SHA_RE = /^[a-f0-9]{7,39}$/i;

function git(args) {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

/// Resolve the full 40-char checkout HEAD and validate any pinned
/// APEX_BUILD_COMMIT before packaging begins. The stamp exported to vite and
/// cargo always uses the canonical 12-char prefix so macOS UI/daemon builds
/// agree with Linux daemons built from the same commit.
export function resolvePinnedCheckout({ env = process.env, git: runGit = git } = {}) {
  const fullCommit = (runGit(['rev-parse', '--verify', 'HEAD']) ?? '').trim().toLowerCase();
  const pinned = (env.APEX_BUILD_COMMIT ?? '').trim().toLowerCase();
  if (pinned) {
    if (!FULL_SHA_RE.test(fullCommit)) {
      throw new Error(`unable to verify checkout HEAD against pinned commit ${pinned}; refusing to ship an unverified build`);
    }
    const matches = FULL_SHA_RE.test(pinned)
      ? fullCommit === pinned
      : (SHORT_SHA_RE.test(pinned) && fullCommit.startsWith(pinned));
    if (!matches) {
      throw new Error(`pinned commit ${pinned} does not match checkout HEAD ${fullCommit}; refusing to ship a mismatched build`);
    }
  }
  const stamp = readStamp({
    env: FULL_SHA_RE.test(pinned) ? { ...env, APEX_BUILD_COMMIT: pinned.slice(0, 12) } : env,
    git: runGit,
  });
  return { fullCommit: FULL_SHA_RE.test(fullCommit) ? fullCommit : null, stamp };
}

/// Confirm HEAD did not move during the build by comparing full 40-char SHAs.
export function assertCheckoutUnchanged(beforeFullCommit, { git: runGit = git } = {}) {
  const before = (beforeFullCommit ?? '').trim().toLowerCase();
  const after = (runGit(['rev-parse', '--verify', 'HEAD']) ?? '').trim().toLowerCase();
  if (!FULL_SHA_RE.test(before) || !FULL_SHA_RE.test(after)) {
    throw new Error('unable to verify full HEAD commit after build; refusing to ship an unverified build');
  }
  if (after !== before) {
    throw new Error(`the checkout moved during the build (${before} -> ${after}); artifacts are mixed, do not install them`);
  }
  return after;
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
export function assertStamped(apps, commit, { target = activeChannel, buildNumber = null } = {}) {
  let checked = 0;
  for (const app of apps) {
    const plist = resolve(app, 'Contents/Info.plist');
    if (existsSync(plist)) {
      const info = JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plist], { encoding: 'utf8' }));
      if (info.CFBundleIdentifier !== target.APP_ID) {
        throw new Error(`${basename(app)} carries bundle identifier ${info.CFBundleIdentifier ?? 'missing'}, expected ${target.APP_ID}`);
      }
      if (target.nightly && buildNumber !== null && String(info.CFBundleVersion ?? '').trim() !== String(buildNumber)) {
        throw new Error(`${basename(app)} carries CFBundleVersion ${info.CFBundleVersion ?? 'missing'}, expected ${buildNumber}`);
      }
    }
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
  let buildNumber;
  let fullCommit;
  let stamp;
  try {
    buildNumber = activeChannel.nightly ? nightlyBuildNumber(process.env) : null;
    ({ fullCommit, stamp } = resolvePinnedCheckout({ env: process.env, git }));
  } catch (error) {
    console.error(`package-pinned: ${error.message}`);
    return 1;
  }
  if (stamp.commit === 'unknown' || !fullCommit) {
    console.error('package-pinned: no commit to stamp; refusing to ship an unlabelled build.');
    return 1;
  }

  log(`channel=${activeChannel.name}${buildNumber ? ` build=${buildNumber}` : ''}; stamping ${stamp.commit}${stamp.dirty ? '-dirty' : ''} into the app and the service`);

  // Clear the previous run's leftovers before building, so a failed build cannot
  // leave a half-written image or an unpacked app for the next one to trip over.
  // The newest versioned installer becomes the rollback first, so the package the
  // Human is running today is not deleted in the same breath.
  const adopted = adoptLegacyRollback(release, activeChannel);
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

    assertCheckoutUnchanged(fullCommit, { git });

    const apps = packagedApps(release);
    log(`read ${stamp.commit} back out of ${assertStamped(apps, stamp.commit, { target: activeChannel, buildNumber })} built artifact(s).`);

    if (process.env.APEX_DECK_SKIP_PKG === '1') {
      log('APEX_DECK_SKIP_PKG=1 set; leaving the installable package untouched.');
      return 0;
    }

    const expectedBundle = `${activeChannel.PRODUCT}.app`;
    const app = apps.find((candidate) => basename(candidate) === expectedBundle) ?? apps[0];
    buildUpgrade(app, stagingPackage(release, activeChannel).pkg, activeChannel);
    // Only now, with a verified package on disk, is the fixed name replaced.
    const extra = activeChannel.nightly ? { channel: activeChannel.name, buildNumber, fullCommit } : {};
    const { pkg, previous, sidecar } = commitPackage(release, { commit: stamp.commit, dirty: stamp.dirty, extra }, activeChannel);
    log(`wrote ${pkg} (version ${sidecar.version}, stamp ${stamp.commit}${buildNumber ? `, build ${buildNumber}` : ''})`);
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
