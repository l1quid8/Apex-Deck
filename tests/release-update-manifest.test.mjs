import test from 'node:test';
import assert from 'node:assert/strict';
import { channel } from '../desktop/channel.mjs';
import { assetName, buildManifest, publishSteps, teamOf } from '../scripts/release-update-manifest.mjs';
import { assetUrl, packageFor, parseManifest, WINDOWS_FEED_URL } from '../desktop/updater.mjs';
import { buildWindowsManifest, windowsAssetName } from '../scripts/windows-update-manifest.mjs';
import { nightlyRelease } from '../scripts/windows-build.mjs';

const facts = { version: '0.9.1', notes: 'Restart to update.', minimumSystemVersion: '13.0', archs: ['arm64'], name: assetName('0.9.1', 'arm64'), size: 1234, sha256: 'a'.repeat(64) };

test('the feed a release writes is exactly what installed copies accept', () => {
  if (channel.nightly) {
    assert.throws(() => buildManifest(facts), /channel mismatch/);
    return;
  }
  const manifest = buildManifest(facts);
  const parsed = parseManifest(JSON.parse(JSON.stringify(manifest)));
  const entry = packageFor(parsed, { arch: 'arm64', osVersion: '26.1' });
  assert.equal(entry.name, 'Apex-Deck-0.9.1-arm64.pkg');
  assert.equal(assetUrl(parsed.version, entry.name), 'https://github.com/l1quid8/apex-deck/releases/download/v0.9.1/Apex-Deck-0.9.1-arm64.pkg');
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
    assert.throws(() => publishSteps('0.9.1', '/r/v0.9.1-assets', facts.name), /cannot publish/);
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
  const nightly = nightlyRelease('abcdef0'.padEnd(40, '1'), '65578', '20261123');
  if (channel.nightly) {
    assert.throws(() => buildWindowsManifest(windows), /channel mismatch/);
    const feed = buildWindowsManifest(windows, nightly);
    assert.deepEqual([feed.channel, feed.tag, feed.buildNumber, feed.commit], ['nightly', nightly.tag, nightly.buildNumber, nightly.commit]);
    const parsed = parseManifest(feed, {extension: '.exe'});
    assert.equal(assetUrl(parsed.version, parsed.packages[0].name, '.exe', parsed.tag),
      'https://github.com/l1quid8/apex-deck/releases/download/nightly-20261123-abcdef0/Apex-Deck-Nightly_20261123_abcdef0_x64-Setup.exe');
    assert.match(WINDOWS_FEED_URL, /\/download\/nightly\/apex-deck-nightly-update-windows\.json$/);
    return;
  }
  assert.throws(() => buildWindowsManifest(windows, nightly), /channel mismatch/);
  const manifest = buildWindowsManifest(windows);
  const entry = packageFor(parseManifest(JSON.parse(JSON.stringify(manifest)), { extension: '.exe' }), { arch: 'x64', osVersion: '10.0.26100' });
  assert.equal(entry.name, windowsAssetName('0.9.8'));
  assert.throws(() => buildWindowsManifest({ version: '0.9.8', size: 10, sha256: 'nope' }));
});
