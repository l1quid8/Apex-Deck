// One installable artifact, one rollback, and no accumulated leftovers.
//
// Every rebuild used to invent a new filename (0.8.2_gate-8f67474, one-chat-r1,
// r2, r3...), because the bot running the build picked the name. Nine installers
// and two disk images later the release folder was 6 GB of almost-identical
// builds and the Human could not tell which one was running.
//
// So the package now always lands on release/Apex-Deck-upgrade.pkg. The previous
// package is kept beside it as release/Apex-Deck-upgrade.previous.pkg, which is
// the only rollback anyone actually needs. Everything else that a build leaves
// behind is removed by cleanupRelease -- in the script, not in a rule a bot has
// to remember.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const FIXED_PACKAGE_NAME = 'Apex-Deck-upgrade.pkg';
export const PREVIOUS_PACKAGE_NAME = 'Apex-Deck-upgrade.previous.pkg';

// Hidden and still ending in .pkg, because package-mac-upgrade.mjs refuses to
// write anywhere else in release/ and refuses any other extension.
export const STAGING_PACKAGE_NAME = '.Apex-Deck-upgrade.staging.pkg';

const UNPACKED_APP_DIR = /^mac(?:-arm64|-universal|-x64)?$/;

/// The artifact the Human installs, and its manifest sidecar.
export function fixedPackage(releaseDir) {
  const dir = path.resolve(releaseDir);
  return {
    pkg: path.join(dir, FIXED_PACKAGE_NAME),
    manifest: path.join(dir, `${FIXED_PACKAGE_NAME}.json`),
  };
}

/// Where a package is built before it is allowed to replace the fixed name.
export function stagingPackage(releaseDir) {
  const dir = path.resolve(releaseDir);
  return {
    pkg: path.join(dir, STAGING_PACKAGE_NAME),
    manifest: path.join(dir, `${STAGING_PACKAGE_NAME}.json`),
  };
}

/// The one kept rollback.
export function previousPackage(releaseDir) {
  const dir = path.resolve(releaseDir);
  return {
    pkg: path.join(dir, PREVIOUS_PACKAGE_NAME),
    manifest: path.join(dir, `${PREVIOUS_PACKAGE_NAME}.json`),
  };
}

/// True for a top-level release/ entry that is a build leftover.
///
/// Deliberately narrow: anything not named here -- the fixed package, its
/// rollback, v0.9.0-assets/, verification/ -- is left alone.
export function isStaleReleaseEntry(name) {
  if (typeof name !== 'string' || name === '' || name === '.' || name === '..') return false;
  if (name.includes('/') || name.includes('\\')) return false;
  if (UNPACKED_APP_DIR.test(name)) return true;
  if (name.startsWith('.native-upgrade-')) return true;
  if (name === STAGING_PACKAGE_NAME || name === `${STAGING_PACKAGE_NAME}.json`) return true;
  if (/^\.temp.*\.dmg$/i.test(name)) return true;
  // Versioned names from before the fixed-name rule: they never regenerate now,
  // and the fixed package plus its previous copy covers what they were for.
  if (/^Apex-Deck_.*\.pkg(\.json)?$/i.test(name)) return true;
  if (/^Apex-Deck_.*\.dmg(\.sha256)?$/i.test(name)) return true;
  return false;
}

function entryBytes(target) {
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink()) return 0;
  if (!stat.isDirectory()) return stat.size;
  let total = 0;
  for (const child of fs.readdirSync(target)) total += entryBytes(path.join(target, child));
  return total;
}

/// Remove this build's leftovers. Returns what went and how much it freed.
export function cleanupRelease(releaseDir, { log = () => {} } = {}) {
  const dir = path.resolve(releaseDir);
  if (!fs.existsSync(dir)) return { removed: [], bytes: 0 };
  const removed = [];
  let bytes = 0;
  for (const name of fs.readdirSync(dir)) {
    if (!isStaleReleaseEntry(name)) continue;
    const target = path.join(dir, name);
    try {
      const stat = fs.lstatSync(target);
      // Unlink a link itself; never walk through it to something it points at.
      bytes += entryBytes(target);
      if (stat.isSymbolicLink()) fs.unlinkSync(target);
      else fs.rmSync(target, { recursive: true, force: true });
      removed.push(name);
    } catch (error) {
      log(`cleanup: could not remove ${name}: ${error.message}`);
    }
  }
  if (removed.length) log(`cleanup: removed ${removed.length} leftover(s), ${(bytes / 1048576).toFixed(1)} MB`);
  return { removed, bytes };
}

/// Move a verified staged package onto the fixed name, keeping the one it
/// replaces as the rollback. The old artifact stays intact until the new one has
/// already been verified by buildUpgrade, so a failed build never leaves the
/// Human without a package.
export function commitPackage(releaseDir, { commit = '', dirty = false } = {}) {
  const dir = path.resolve(releaseDir);
  const staging = stagingPackage(dir);
  const fixed = fixedPackage(dir);
  const previous = previousPackage(dir);
  if (!fs.existsSync(staging.pkg)) throw new Error(`No staged package at ${staging.pkg}`);

  const manifest = fs.existsSync(staging.manifest)
    ? JSON.parse(fs.readFileSync(staging.manifest, 'utf8'))
    : {};
  const sidecar = { ...manifest, commit, dirty };

  const keptPrevious = fs.existsSync(fixed.pkg);
  if (keptPrevious) fs.renameSync(fixed.pkg, previous.pkg);
  if (fs.existsSync(fixed.manifest)) fs.renameSync(fixed.manifest, previous.manifest);

  fs.renameSync(staging.pkg, fixed.pkg);
  if (fs.existsSync(staging.manifest)) fs.rmSync(staging.manifest, { force: true });
  fs.writeFileSync(fixed.manifest, `${JSON.stringify(sidecar, null, 2)}\n`);

  return { ...fixed, previous: keptPrevious ? previous.pkg : null, sidecar };
}

/// Before the first fixed-name build there is no rollback, only the versioned
/// installers this rule replaces -- including whichever one the Human is running
/// right now. Keep the newest of those as the rollback rather than deleting the
/// only way back.
export function adoptLegacyRollback(releaseDir) {
  const dir = path.resolve(releaseDir);
  const fixed = fixedPackage(dir);
  const previous = previousPackage(dir);
  if (fs.existsSync(fixed.pkg) || fs.existsSync(previous.pkg)) return null;
  if (!fs.existsSync(dir)) return null;
  const candidates = fs.readdirSync(dir)
    .filter((name) => /^Apex-Deck_.*\.pkg$/i.test(name))
    .map((name) => ({ name, at: fs.statSync(path.join(dir, name)).mtimeMs }))
    .sort((a, b) => b.at - a.at);
  if (!candidates.length) return null;
  const newest = candidates[0].name;
  fs.renameSync(path.join(dir, newest), previous.pkg);
  const sidecar = path.join(dir, `${newest}.json`);
  if (fs.existsSync(sidecar)) fs.renameSync(sidecar, previous.manifest);
  return newest;
}

/// Mounted disk images whose backing file lives in this release folder. A build
/// leaves these attached when it dies mid-dmg; images mounted from anywhere else
/// (iOS simulator runtimes, an installed disk image) are never ours to detach.
export function mountsToDetach(plist, releaseDir) {
  const dir = path.resolve(releaseDir);
  const images = Array.isArray(plist?.images) ? plist.images : [];
  const devices = [];
  for (const image of images) {
    const imagePath = typeof image?.['image-path'] === 'string' ? image['image-path'] : '';
    if (!imagePath) continue;
    const resolved = path.resolve(imagePath);
    if (!resolved.startsWith(`${dir}${path.sep}`)) continue;
    const device = image['dev-entry']
      ?? image['system-entities']?.find((entity) => entity?.['dev-entry'])?.['dev-entry'];
    if (device && !devices.includes(device)) devices.push(device);
  }
  return devices;
}

function readMounts() {
  const info = spawnSync('/usr/bin/hdiutil', ['info', '-plist'], { encoding: 'utf8' });
  if (info.status !== 0 || !info.stdout) return null;
  const parsed = spawnSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-'], { input: info.stdout, encoding: 'utf8' });
  if (parsed.status !== 0 || !parsed.stdout) return null;
  try {
    return JSON.parse(parsed.stdout);
  } catch {
    return null;
  }
}

/// Detach only the disk images this release folder left mounted.
export function detachReleaseImages(releaseDir, { log = () => {} } = {}) {
  const mounts = readMounts();
  if (!mounts) return [];
  const detached = [];
  for (const device of mountsToDetach(mounts, releaseDir)) {
    const done = spawnSync('/usr/bin/hdiutil', ['detach', device], { encoding: 'utf8' });
    if (done.status === 0) {
      detached.push(device);
      log(`cleanup: detached ${device}`);
      continue;
    }
    const forced = spawnSync('/usr/bin/hdiutil', ['detach', device, '-force'], { encoding: 'utf8' });
    if (forced.status === 0) {
      detached.push(device);
      log(`cleanup: force-detached ${device}`);
    } else {
      log(`cleanup: could not detach ${device}: ${(forced.stderr || '').trim()}`);
    }
  }
  return detached;
}
