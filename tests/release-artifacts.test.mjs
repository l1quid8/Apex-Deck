import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import {
  FIXED_PACKAGE_NAME,
  PREVIOUS_PACKAGE_NAME,
  adoptLegacyRollback,
  cleanupRelease,
  commitPackage,
  fixedPackage,
  isStaleReleaseEntry,
  mountsToDetach,
  previousPackage,
  stagingPackage,
} from '../scripts/release-artifacts.mjs';
import { validateOutput } from '../scripts/package-mac-upgrade.mjs';

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const tempRelease = () => fs.mkdtempSync(path.join(os.tmpdir(), 'apex-release-'));
const write = (target, body) => fs.writeFileSync(target, body);

test('the installable artifact has one fixed name, with one rollback beside it', () => {
  const release = tempRelease();
  assert.equal(path.basename(fixedPackage(release).pkg), 'Apex-Deck-upgrade.pkg');
  assert.equal(path.basename(fixedPackage(release).manifest), 'Apex-Deck-upgrade.pkg.json');
  assert.equal(path.basename(previousPackage(release).pkg), 'Apex-Deck-upgrade.previous.pkg');
  assert.equal(FIXED_PACKAGE_NAME, 'Apex-Deck-upgrade.pkg');
  assert.equal(PREVIOUS_PACKAGE_NAME, 'Apex-Deck-upgrade.previous.pkg');
});

test('the staging name is one the real package builder accepts', () => {
  // package-mac-upgrade.mjs only writes inside release/ and only to *.pkg, so the
  // staged build has to satisfy that same validator rather than work around it.
  const release = '/Users/tylercaldwell/Downloads/apex-deck/release';
  const staging = stagingPackage(release);
  assert.equal(path.extname(staging.pkg), '.pkg');
  assert.equal(path.dirname(staging.pkg), release);
  assert.equal(validateOutput(staging.pkg), staging.pkg);
});

test('cleanup names build leftovers and nothing else', () => {
  const stale = [
    'mac-arm64',
    'mac',
    'mac-universal',
    '.native-upgrade-abc123',
    '.Apex-Deck-upgrade.staging.pkg',
    '.temp-abc123.dmg',
    'Apex-Deck_0.9.0_assistant-one-chat-r3_arm64.pkg',
    'Apex-Deck_0.9.0_assistant-one-chat-r3_arm64.pkg.json',
    'Apex-Deck_0.9.0_arm64.dmg',
    'Apex-Deck_0.9.0_arm64.dmg.sha256',
  ];
  const kept = [
    'Apex-Deck-upgrade.pkg',
    'Apex-Deck-upgrade.pkg.json',
    'Apex-Deck-upgrade.previous.pkg',
    'Apex-Deck.dmg',
    'v0.9.0-assets',
    'verification',
    '.DS_Store',
    'notes.md',
    'ApexDeck_backup.pkg',
  ];
  for (const name of stale) assert.equal(isStaleReleaseEntry(name), true, `${name} should be removed`);
  for (const name of kept) assert.equal(isStaleReleaseEntry(name), false, `${name} must be kept`);
  assert.equal(isStaleReleaseEntry('../outside'), false);
  assert.equal(isStaleReleaseEntry(''), false);
});

test('a staged package replaces the fixed name and the old one becomes the rollback', () => {
  const release = tempRelease();
  const staging = stagingPackage(release);
  const fixed = fixedPackage(release);
  const previous = previousPackage(release);

  write(staging.pkg, 'r4');
  write(staging.manifest, JSON.stringify({ id: 'id-4', version: '0.9.0' }));
  const first = commitPackage(release, { commit: 'aaaa11112222', dirty: false });
  assert.equal(fs.readFileSync(fixed.pkg, 'utf8'), 'r4');
  assert.equal(first.previous, null, 'nothing to keep on the first fixed-name build');
  assert.equal(fs.existsSync(staging.pkg), false, 'the staged file is consumed');
  assert.equal(fs.existsSync(staging.manifest), false, 'and so is its sidecar');
  assert.deepEqual(JSON.parse(fs.readFileSync(fixed.manifest, 'utf8')), {
    id: 'id-4',
    version: '0.9.0',
    commit: 'aaaa11112222',
    dirty: false,
  });

  write(staging.pkg, 'r5');
  write(staging.manifest, JSON.stringify({ id: 'id-5', version: '0.9.0' }));
  commitPackage(release, { commit: 'bbbb33334444', dirty: true });
  assert.equal(fs.readFileSync(fixed.pkg, 'utf8'), 'r5', 'the fixed name holds the newest build');
  assert.equal(fs.readFileSync(previous.pkg, 'utf8'), 'r4', 'the replaced package is the rollback');
  assert.equal(JSON.parse(fs.readFileSync(fixed.manifest, 'utf8')).commit, 'bbbb33334444');
  assert.equal(JSON.parse(fs.readFileSync(previous.manifest, 'utf8')).commit, 'aaaa11112222');
});

test('a failed build cannot destroy the package already on the fixed name', () => {
  const release = tempRelease();
  const fixed = fixedPackage(release);
  write(fixed.pkg, 'good-build');
  write(fixed.manifest, JSON.stringify({ id: 'id-good', version: '0.9.0' }));

  assert.throws(() => commitPackage(release, { commit: 'cccc' }), /No staged package/);
  assert.equal(fs.readFileSync(fixed.pkg, 'utf8'), 'good-build');
  assert.equal(JSON.parse(fs.readFileSync(fixed.manifest, 'utf8')).id, 'id-good');

  // And a staged build that never got verified is the only thing cleanup removes.
  write(stagingPackage(release).pkg, 'half-written');
  cleanupRelease(release);
  assert.equal(fs.existsSync(stagingPackage(release).pkg), false);
  assert.equal(fs.readFileSync(fixed.pkg, 'utf8'), 'good-build');
});

test('cleanup removes leftovers, frees their size, and never follows a symlink', () => {
  const release = tempRelease();
  const outside = tempRelease();
  write(path.join(outside, 'precious.pkg'), 'keep me');
  fs.mkdirSync(path.join(release, 'mac-arm64', 'Apex Deck.app', 'Contents'), { recursive: true });
  write(path.join(release, 'mac-arm64', 'Apex Deck.app', 'Contents', 'app.asar'), 'x'.repeat(4096));
  write(path.join(release, '.temp-1.dmg'), 'half');
  write(path.join(release, 'Apex-Deck-upgrade.pkg'), 'current');
  write(path.join(release, 'Apex-Deck-upgrade.previous.pkg'), 'rollback');
  fs.mkdirSync(path.join(release, 'verification'));
  write(path.join(release, 'verification', 'evidence.json'), '{}');
  fs.symlinkSync(path.join(outside, 'precious.pkg'), path.join(release, 'Apex-Deck_0.9.0_arm64.dmg'));

  const { removed, bytes } = cleanupRelease(release);

  assert.deepEqual(removed.sort(), ['.temp-1.dmg', 'Apex-Deck_0.9.0_arm64.dmg', 'mac-arm64'].sort());
  assert.ok(bytes >= 4096 + 4, 'reports roughly what it freed');
  assert.equal(fs.existsSync(path.join(release, 'mac-arm64')), false);
  assert.equal(fs.readFileSync(path.join(release, 'Apex-Deck-upgrade.pkg'), 'utf8'), 'current');
  assert.equal(fs.readFileSync(path.join(release, 'Apex-Deck-upgrade.previous.pkg'), 'utf8'), 'rollback');
  assert.equal(fs.existsSync(path.join(release, 'verification', 'evidence.json')), true);
  assert.equal(fs.readFileSync(path.join(outside, 'precious.pkg'), 'utf8'), 'keep me', 'the link target is untouched');
});

test('only disk images backed by this release folder are detached', () => {
  const release = '/Users/tylercaldwell/Downloads/apex-deck/release';
  const plist = {
    images: [
      { 'image-path': `${release}/.temp-abc.dmg`, 'dev-entry': '/dev/disk4' },
      { 'image-path': `${release}/Apex-Deck.dmg`, 'system-entities': [{ 'dev-entry': '/dev/disk5s1' }] },
      { 'image-path': '/System/Library/AssetsV2/iOSSimulatorRuntime.dmg', 'dev-entry': '/dev/disk6' },
      { 'image-path': '/Users/tylercaldwell/Downloads/apex-deck/release-notes.dmg', 'dev-entry': '/dev/disk7' },
      { 'image-path': '', 'dev-entry': '/dev/disk8' },
    ],
  };
  assert.deepEqual(mountsToDetach(plist, release), ['/dev/disk4', '/dev/disk5s1']);
  assert.deepEqual(mountsToDetach(undefined, release), []);
});

test('the first fixed-name build keeps the installer in use as the rollback', () => {
  const release = tempRelease();
  const old = path.join(release, 'Apex-Deck_0.9.0_assistant-one-chat-r1_arm64.pkg');
  const current = path.join(release, 'Apex-Deck_0.9.0_assistant-one-chat-r3_arm64.pkg');
  write(old, 'r1');
  write(current, 'r3');
  write(`${current}.json`, JSON.stringify({ id: 'id-3' }));
  const long = new Date('2026-10-24T13:00:00Z');
  const recent = new Date('2026-10-24T14:02:00Z');
  fs.utimesSync(old, long, long);
  fs.utimesSync(current, recent, recent);

  assert.equal(adoptLegacyRollback(release), 'Apex-Deck_0.9.0_assistant-one-chat-r3_arm64.pkg');
  assert.equal(fs.readFileSync(previousPackage(release).pkg, 'utf8'), 'r3', 'the newest old installer is the rollback');
  assert.equal(JSON.parse(fs.readFileSync(previousPackage(release).manifest, 'utf8')).id, 'id-3');

  // Now there is a rollback, so nothing else is adopted and the rest is stale.
  assert.equal(adoptLegacyRollback(release), null);
  cleanupRelease(release);
  assert.equal(fs.existsSync(old), false, 'the older installers are cleared');
  assert.equal(fs.readFileSync(previousPackage(release).pkg, 'utf8'), 'r3');
});

test('adoption never displaces an existing fixed package or rollback', () => {
  const release = tempRelease();
  write(fixedPackage(release).pkg, 'current');
  write(path.join(release, 'Apex-Deck_0.9.0_arm64.pkg'), 'old');
  assert.equal(adoptLegacyRollback(release), null);
  assert.equal(fs.readFileSync(fixedPackage(release).pkg, 'utf8'), 'current');
});

test('the packaging entry point does the cleanup and the fixed-name replace itself', () => {
  const script = read('scripts/package-pinned.mjs');
  assert.match(script, /cleanupRelease\(/, 'leftovers are removed by the script, not by a remembered rule');
  assert.match(script, /detachReleaseImages\(/, 'and so are the images a dead dmg build left mounted');
  assert.match(script, /adoptLegacyRollback\(/, 'the running installer survives the switch to a fixed name');
  assert.match(script, /commitPackage\(/, 'the verified package replaces the fixed name');
  assert.match(script, /buildUpgrade\(/, 'and the installable package is built in the same run');
  // Cleanup has to survive the failure path, which is when leftovers are worst.
  assert.match(script, /\} finally \{[\s\S]*cleanupRelease\(/);
});
