import test from 'node:test';
import assert from 'node:assert/strict';
import { pickIdentity, signingMessage, releaseBuildCommands, cliSigningArgs, builderArgs, builtDmgs } from '../scripts/package-mac.mjs';
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
  assert.equal(args[args.indexOf('--identifier') + 1], 'dev.apexdeck.cli');
  assert.equal(args[args.indexOf('--options') + 1], 'runtime');
  assert.ok(args.includes('--timestamp'));
  assert.ok(!cliSigningArgs('-').includes('--timestamp'));
});

test('electron-builder notarizes only when the plan says so', () => {
  assert.deepEqual(builderArgs('-', { notarize: false }, ['--dir']), ['--mac', '--dir']);
  assert.deepEqual(builderArgs(a, { notarize: false }), ['--mac', `-c.mac.identity=${a}`]);
  assert.deepEqual(builderArgs(a, { notarize: true }), ['--mac', `-c.mac.identity=${a}`, '-c.mac.notarize=true']);
});

test('only this build\'s disk images are notarized', () => {
  assert.deepEqual(builtDmgs(['Apex-Deck_0.9.9_arm64.dmg', 'Apex-Deck-upgrade.pkg', 'mac-arm64', 'Apex-Deck_0.9.9_arm64.dmg.blockmap', 'Other.dmg']),
    ['Apex-Deck_0.9.9_arm64.dmg']);
});
