import test from 'node:test';
import assert from 'node:assert/strict';
import { pickIdentity, signingMessage, releaseBuildCommands } from '../scripts/package-mac.mjs';
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
  ]);
  assert.ok(lines.every(line => !line.includes('test-support') && !line.includes('--tests')));
});
