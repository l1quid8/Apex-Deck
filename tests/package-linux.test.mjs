import test from 'node:test';
import assert from 'node:assert/strict';
import { assertLinuxHost, builderArgs, artifactName } from '../scripts/package-linux.mjs';
import { usesLaunchAgent } from '../desktop/launchAgent.mjs';

test('Linux packaging refuses foreign hosts and unsupported architectures', () => {
  assert.throws(() => assertLinuxHost('darwin', 'arm64'), /Linux/);
  assert.throws(() => assertLinuxHost('linux', 'ia32'), /architecture/);
  assert.doesNotThrow(() => assertLinuxHost('linux', 'x64'));
  assert.doesNotThrow(() => assertLinuxHost('linux', 'arm64'));
  assert.deepEqual(builderArgs('arm64'), ['--linux', 'AppImage', '--arm64', '--publish', 'never']);
  assert.deepEqual(builderArgs('x64'), ['--linux', 'AppImage', '--x64', '--publish', 'never']);
});

test('packaged Linux does not install a macOS LaunchAgent', () => {
  assert.equal(usesLaunchAgent({ packaged: true, platform: 'linux' }), false);
  assert.equal(usesLaunchAgent({ packaged: true, platform: 'darwin' }), true);
});

test('AppImage filename uses electron-builder architecture names', () => {
  assert.equal(artifactName('0.9.9', 'x64'), 'Apex-Deck_0.9.9_x86_64.AppImage');
  assert.equal(artifactName('0.9.9', 'arm64'), 'Apex-Deck_0.9.9_arm64.AppImage');
});
