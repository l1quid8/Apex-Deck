import test from 'node:test';
import assert from 'node:assert/strict';
import { selectIdentity, releaseCommands, validateVersion, manifestFor } from '../scripts/package-cli-mac.mjs';

test('CLI release requires a Developer ID and refuses ad hoc or ambiguous signing', () => {
  assert.throws(() => selectIdentity('', {}), /Developer ID/);
  assert.throws(() => selectIdentity('', { APEX_DECK_SIGN_IDENTITY: '-' }), /Developer ID/);
  const id='a'.repeat(40);
  assert.equal(selectIdentity(` 1) ${id} "Developer ID Application: Example (TEAM)"`, {}), id);
  assert.throws(() => selectIdentity(` 1) ${id} "Developer ID Application: A"\n 2) ${'b'.repeat(40)} "Developer ID Application: B"`, {}), /Multiple/);
});
test('standalone binaries build without Electron or remote daemon features', () => {
  const commands=releaseCommands('/repo/Cargo.toml');
  assert.equal(commands.length, 3);
  assert.deepEqual(commands.map(c=>c.at(-1)), ['apex-cli','apex-daemon','apex-provenance']);
  assert.ok(commands.every(c=>c.includes('--release') && c.includes('--locked') && !c.includes('--features')));
});
test('release version and manifest exclude unsafe filenames and missing hashes', () => {
  assert.equal(validateVersion('0.9.8'), '0.9.8');
  assert.throws(()=>validateVersion('../bad'),/version/);
  const files=[{name:'apex',sha256:'a'.repeat(64)}];
  assert.equal(manifestFor('0.9.8',files).files[0].name,'apex');
  assert.throws(()=>manifestFor('0.9.8',[{name:'../x',sha256:'a'.repeat(64)}]),/file/);
  assert.throws(()=>manifestFor('0.9.8',[{name:'apex',sha256:'bad'}]),/hash/);
});
