import test from 'node:test';
import assert from 'node:assert/strict';
import { channel } from '../desktop/channel.mjs';
import { assetName, buildManifest, nightlyTag, publishSteps, teamOf } from '../scripts/release-update-manifest.mjs';
import { assetUrl, packageFor, parseManifest } from '../desktop/updater.mjs';
import { buildWindowsManifest, windowsAssetName } from '../scripts/windows-update-manifest.mjs';

const commit = '11c1ade33ad9f6dc2d80ff32a68e159d501fde38';
const date = '20261123';
const tag = nightlyTag(date, commit);
const nightlyMeta = { date, commit, buildNumber: 42, tag };
const facts = channel.nightly
  ? { version: '0.9.19', notes: 'Nightly build.', minimumSystemVersion: '13.0', archs: ['arm64'], name: assetName('0.9.19', 'arm64', nightlyMeta), size: 1234, sha256: 'a'.repeat(64), ...nightlyMeta }
  : { version: '0.9.1', notes: 'Restart to update.', minimumSystemVersion: '13.0', archs: ['arm64'], name: assetName('0.9.1', 'arm64'), size: 1234, sha256: 'a'.repeat(64) };

test('the feed a release writes is exactly what installed copies accept', () => {
  const manifest = buildManifest(facts);
  const parsed = parseManifest(JSON.parse(JSON.stringify(manifest)));
  const entry = packageFor(parsed, { arch: 'arm64', osVersion: '26.1' });
  if (channel.nightly) {
    assert.equal(manifest.channel, 'nightly');
    assert.equal(manifest.buildNumber, 42);
    assert.equal(manifest.tag, 'nightly-20261123-11c1ade');
    assert.equal(entry.name, 'Apex-Deck-Nightly_20261123_11c1ade_arm64.pkg');
    assert.equal(assetUrl(parsed.version, entry.name, '.pkg', parsed.tag), 'https://github.com/l1quid8/apex-deck/releases/download/nightly-20261123-11c1ade/Apex-Deck-Nightly_20261123_11c1ade_arm64.pkg');
    assert.throws(() => buildManifest({ ...facts, tag: 'v0.9.19' }), /Invalid immutable Nightly tag/);
    assert.throws(() => buildManifest({ ...facts, buildNumber: 0 }));
  } else {
    assert.equal(entry.name, 'Apex-Deck-0.9.1-arm64.pkg');
    assert.equal(assetUrl(parsed.version, entry.name), 'https://github.com/l1quid8/apex-deck/releases/download/v0.9.1/Apex-Deck-0.9.1-arm64.pkg');
  }
  assert.deepEqual(buildManifest({ ...facts, archs: ['x86_64', 'arm64'] }).packages.map((p) => p.arch), ['x64', 'arm64']);
  assert.throws(() => buildManifest({ ...facts, archs: ['ppc'] }));
  assert.throws(() => buildManifest({ ...facts, sha256: 'nope' }));
});

test('an ad hoc build is never published as an update', () => {
  assert.equal(teamOf('Identifier=dev.apexdeck.app\nTeamIdentifier=TEAM123456\n'), 'TEAM123456');
  assert.throws(() => teamOf('Signature=adhoc\nTeamIdentifier=not set\n'), /ad hoc/);
});

test('publishing uploads to a draft and checks it before any Deck can see the feed', { skip: process.platform === 'win32' && 'releases are published from a Mac' }, () => {
  if (channel.nightly) {
    const steps = publishSteps('0.9.19', `/r/${tag}-assets`, facts.name, [], nightlyMeta);
    assert.match(steps[0], /--draft --prerelease/);
    assert.match(steps[0], new RegExp(`--target ${commit}`));
    assert.match(steps[1], /Apex-Deck-Nightly_20261123_11c1ade_arm64\.pkg/);
    assert.match(steps[2], /shasum/);
    assert.match(steps[3], /--draft=false --prerelease/);
    assert.doesNotMatch(steps.join('\n'), /--latest/, 'Nightly must never advance GitHub latest');
    assert.match(steps[4], /gh release upload nightly .*apex-deck-nightly-update\.json/);
    assert.throws(() => publishSteps('0.9.19', '/r/bad', facts.name), /immutable/);
    return;
  }
  const steps = publishSteps('0.9.1', '/r/v0.9.1-assets', 'Apex-Deck-0.9.1-arm64.pkg');
  assert.match(steps[0], /--draft/);
  assert.match(steps[1], /Apex-Deck-0\.9\.1-arm64\.pkg' '\/r\/v0\.9\.1-assets\/apex-deck-update\.json'/);
  assert.match(steps[2], /shasum/);
  assert.match(steps[3], /--draft=false --latest/);
});

test('the Windows feed a release writes is what installed copies accept', () => {
  const windows = { version: '0.9.8', size: 10, sha256: 'a'.repeat(64) };
  if (channel.nightly) {
    assert.throws(() => buildWindowsManifest(windows), /channel mismatch/);
    return;
  }
  const manifest = buildWindowsManifest(windows);
  const entry = packageFor(parseManifest(JSON.parse(JSON.stringify(manifest)), { extension: '.exe' }), { arch: 'x64', osVersion: '10.0.26100' });
  assert.equal(entry.name, windowsAssetName('0.9.8'));
  assert.throws(() => buildWindowsManifest({ version: '0.9.8', size: 10, sha256: 'nope' }));
});
