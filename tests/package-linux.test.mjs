import test from 'node:test';
import assert from 'node:assert/strict';
import { assertLinuxHost, builderArgs, artifactName, linuxNightlyRelease, nightlySourceDate, assertPlannedCommit } from '../scripts/package-linux.mjs';
import { usesLaunchAgent } from '../desktop/launchAgent.mjs';
import { assertTrustedStartup } from '../desktop/provenance.mjs';

test('Linux packaging refuses foreign hosts and unsupported architectures', () => {
  assert.throws(() => assertLinuxHost('darwin', 'arm64'), /Linux/);
  assert.throws(() => assertLinuxHost('linux', 'ia32'), /architecture/);
  assert.doesNotThrow(() => assertLinuxHost('linux', 'x64'));
  assert.doesNotThrow(() => assertLinuxHost('linux', 'arm64'));
  for (const arch of ['x64', 'arm64']) {
    assert.deepEqual(builderArgs(arch), [
      '--linux', 'AppImage', `--${arch}`, '--publish', 'never',
      '--config.electronFuses.grantFileProtocolExtraPrivileges=false',
    ]);
  }
});

test('packaged Linux tolerates a runtime channel variable and retains startup guardrails', () => {
  for (const APEX_CHANNEL of ['stable', 'nightly', 'invalid']) {
    assert.doesNotThrow(() => assertTrustedStartup(true, ['apex-deck'], { APEX_CHANNEL }, 'linux'));
  }
  assert.throws(() => assertTrustedStartup(true, ['apex-deck', '--no-sandbox'], { APEX_CHANNEL: 'stable' }, 'linux'), /refuses/);
  assert.throws(() => assertTrustedStartup(true, ['apex-deck'], { APEX_CHANNEL: 'stable', APEX_DAEMON_BIN: '/tmp/daemon' }, 'linux'), /refuses/);
});

test('packaged Linux does not install a macOS LaunchAgent', () => {
  assert.equal(usesLaunchAgent({ packaged: true, platform: 'linux' }), false);
  assert.equal(usesLaunchAgent({ packaged: true, platform: 'darwin' }), true);
});

test('AppImage filename uses electron-builder architecture names', () => {
  assert.equal(artifactName('0.9.9', 'x64'), 'Apex-Deck_0.9.9_x86_64.AppImage');
  assert.equal(artifactName('0.9.9', 'arm64'), 'Apex-Deck_0.9.9_arm64.AppImage');
});

test('Nightly AppImage and immutable tag share the source date and commit', () => {
  const commit = '1234567890abcdef1234567890abcdef12345678';
  const nightly = linuxNightlyRelease(commit, '45', '20261123');
  assert.deepEqual(nightly, { commit, buildNumber: 45, date: '20261123', tag: 'nightly-20261123-1234567' });
  assert.equal(artifactName('0.9.9', 'x64', nightly), 'Apex-Deck-Nightly_20261123_1234567_x86_64.AppImage');
  assert.equal(artifactName('0.9.9', 'arm64', nightly), 'Apex-Deck-Nightly_20261123_1234567_arm64.AppImage');
  for (const number of ['', '0', '-1', '1e3', '9007199254740992']) {
    assert.throws(() => linuxNightlyRelease(commit, number, '20261123'), /build number|positive decimal/);
  }
  assert.throws(() => linuxNightlyRelease(commit.slice(0, 12), '45', '20261123'), /full source SHA/);
  const args = builderArgs('x64', { name: artifactName('0.9.9', 'x64', nightly), appId: 'dev.apexdeck.app.nightly', product: 'Apex Deck Nightly' });
  assert(args.includes('--publish') && args.includes('never'));
  assert(args.includes('--config.directories.output=release/nightly'));
  assert(args.includes('--config.extraMetadata.desktopName=dev.apexdeck.app.nightly.desktop'));
});

test('Nightly AppImages take the planner date and refuse a different commit', () => {
  const commit = '1234567890abcdef1234567890abcdef12345678';
  const commitSeconds = Date.UTC(2026, 10, 23, 23, 59) / 1000;
  assert.equal(nightlySourceDate({}, commitSeconds), '20261123');
  assert.equal(nightlySourceDate({ APEX_NIGHTLY_DATE: '20261124' }, commitSeconds), '20261124');
  assert.throws(() => linuxNightlyRelease(commit, '1', nightlySourceDate({ APEX_NIGHTLY_DATE: '2026-11-24' }, commitSeconds)), /source date/);
  assert.doesNotThrow(() => assertPlannedCommit({}, commit));
  assert.doesNotThrow(() => assertPlannedCommit({ APEX_BUILD_COMMIT: commit }, commit));
  assert.throws(() => assertPlannedCommit({ APEX_BUILD_COMMIT: 'f'.repeat(40) }, commit), /does not match/);
});
