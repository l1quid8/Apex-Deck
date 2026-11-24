import test from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { channel, loadChannel } from '../desktop/channel.mjs';
import { pickIdentity, signingMessage, releaseBuildCommands, cliSigningArgs, builderArgs, builtDmgs, nightlyBuildNumber, nightlyDmgArtifactName, nightlyBuilderConfig } from '../scripts/package-mac.mjs';
const a = 'A'.repeat(40), b = 'B'.repeat(40);
const line = (hash, type = 'Developer ID Application') => `  1) ${hash} "${type}: Made Up Person (FAKETEAM)"`;
test('one Developer ID selects its hash without exposing the name', () => {
  assert.equal(pickIdentity(line(a), {}), a);
  assert.equal(signingMessage(a), `signing with Developer ID ${a}`);
  assert.ok(!signingMessage(a).includes('Made Up Person'));
});
test('non Developer ID and failed discovery use ad hoc', () => {
  assert.equal(pickIdentity(line(a, 'Apple Development'), {}), '-');
  assert.equal(pickIdentity('', {}), '-');
  assert.equal(signingMessage('-'), 'signing ad hoc');
});
test('multiple Developer IDs fail with hashes only', () => {
  assert.throws(() => pickIdentity(`${line(a)}\n${line(b)}`, {}), error =>
    error.message.includes(a) && error.message.includes(b) &&
    error.message.includes('APEX_DECK_SIGN_IDENTITY') && !error.message.includes('Made Up Person'));
});
test('override wins including explicit ad hoc', () => {
  assert.equal(pickIdentity(line(a), { APEX_DECK_SIGN_IDENTITY: b }), b);
  assert.equal(pickIdentity(line(a), { APEX_DECK_SIGN_IDENTITY: '-' }), '-');
});
test('packaging rebuilds the daemon and broker as plain release builds', () => {
  const lines = releaseBuildCommands().map(([c, a]) => [c, ...a].join(' '));
  assert.deepEqual(lines, [
    'cargo build --release -p apex-daemon --features remote',
    'cargo build --release -p apex-provenance',
    'cargo build --release -p apex-cli',
  ]);
  assert.ok(lines.every(line => !line.includes('test-support') && !line.includes('--tests')));
});

test('CLI signing uses its separate hardened identity', () => {
  const args = cliSigningArgs(a);
  assert.equal(args[args.indexOf('--identifier') + 1], channel.CLI_ID);
  assert.equal(args[args.indexOf('--options') + 1], 'runtime');
  assert.ok(args.includes('--timestamp'));
  assert.ok(!cliSigningArgs('-').includes('--timestamp'));
  const nightly = loadChannel({ packaged: false, env: { APEX_CHANNEL: 'nightly' } });
  const nightlyArgs = cliSigningArgs(a, nightly);
  assert.equal(nightlyArgs[nightlyArgs.indexOf('--identifier') + 1], 'dev.apexdeck.cli.nightly');
});

test('electron-builder notarizes only when the plan says so', () => {
  assert.deepEqual(builderArgs('-', { notarize: false }, ['--dir']), ['--mac', '--dir']);
  assert.deepEqual(builderArgs(a, { notarize: false }), ['--mac', `-c.mac.identity=${a}`]);
  assert.deepEqual(builderArgs(a, { notarize: true }), ['--mac', `-c.mac.identity=${a}`, '-c.mac.notarize=true']);
  assert.deepEqual(builderArgs(a, { notarize: false }, ['--dir'], { configPath: '/tmp/n.json' }), ['--mac', '--config', '/tmp/n.json', '--dir', `-c.mac.identity=${a}`]);
});

test('Nightly packaging builds isolated app identity, bundleVersion, dated DMG name and stamped updater resources', () => {
  assert.equal(nightlyBuildNumber({ APEX_BUILD_NUMBER: '42' }), 42);
  for (const bad of [undefined, '', '0', '-1', '42.0', '0x2a', '1e2']) {
    assert.throws(() => nightlyBuildNumber({ APEX_BUILD_NUMBER: bad }), /APEX_BUILD_NUMBER/);
  }
  const nightly = loadChannel({ packaged: false, env: { APEX_CHANNEL: 'nightly' } });
  const base = {
    appId: 'dev.apexdeck.app',
    productName: 'Apex Deck',
    mac: {
      extendInfo: { NSMicrophoneUsageDescription: 'mic' },
      extraResources: [
        { from: 'target/release/apex-daemon', to: 'bin/apex-daemon' },
        { from: 'scripts/upgrade.py', to: 'updater/upgrade.py' },
        { from: 'scripts/verify-protected-bundle.sh', to: 'updater/verify-protected-bundle.sh' },
      ],
    },
    dmg: { artifactName: 'Apex-Deck_${version}_${arch}.${ext}' },
  };
  const updaterDir = join(tmpdir(), 'staged-updater');
  const cfg = nightlyBuilderConfig(base, {
    target: nightly, buildNumber: 42, date: '20261123', commit: '11c1ade33ad9', updaterDir,
  });
  assert.equal(cfg.appId, 'dev.apexdeck.app.nightly');
  assert.equal(cfg.productName, 'Apex Deck Nightly');
  assert.equal(cfg.mac.bundleVersion, '42');
  assert.equal(cfg.dmg.artifactName, nightlyDmgArtifactName({ date: '20261123', commit: '11c1ade33ad9' }));
  assert.equal(cfg.dmg.artifactName, 'Apex-Deck-Nightly_20261123_11c1ade_${arch}.${ext}');
  assert.equal(cfg.mac.extraResources[1].from, join(updaterDir, 'upgrade.py'));
  assert.equal(cfg.mac.extraResources[2].from, join(updaterDir, 'verify-protected-bundle.sh'));
  assert.equal(base.appId, 'dev.apexdeck.app', 'base config object is not mutated');
});

test('only this build\'s disk images are notarized', () => {
  const before = new Map([['old.dmg', '1'], ['rebuilt.dmg', '2']]);
  const after = new Map([...before, ['rebuilt.dmg', '3'], ['new.dmg', '4']]);
  assert.deepEqual(builtDmgs(before, after), ['new.dmg', 'rebuilt.dmg']);
});
