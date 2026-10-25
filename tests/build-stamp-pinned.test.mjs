import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readStamp, stampEnv } from '../scripts/build-stamp.mjs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const ui = '6c5a1f110fa5';
const service = '2f43c919e683';
// git that answers like the moved branch did: whatever it is asked, it says
// the *other* commit, which is what made one package carry two labels.
const gitSaying = (value) => (args) => (args[0] === 'rev-parse' ? value : '');

test('a pinned commit wins over what the checkout currently says', () => {
  const stamp = readStamp({ env: { APEX_BUILD_COMMIT: ui }, git: gitSaying(service) });
  assert.equal(stamp.commit, ui, 'the exported commit must be copied, not re-resolved from git');
});

test('the pinned dirty flag wins too, so both sides agree on -dirty', () => {
  const stamp = readStamp({ env: { APEX_BUILD_COMMIT: ui, APEX_BUILD_DIRTY: 'true' }, git: gitSaying(ui) });
  assert.equal(stamp.dirty, true);
  assert.equal(readStamp({ env: { APEX_BUILD_COMMIT: ui, APEX_BUILD_DIRTY: 'false' }, git: gitSaying(ui) }).dirty, false);
});

test('with nothing pinned it still falls back to git', () => {
  assert.equal(readStamp({ env: {}, git: gitSaying(service) }).commit, service);
  assert.equal(readStamp({ env: {}, git: () => null }).commit, 'unknown');
  assert.equal(readStamp({ env: { APEX_BUILD_COMMIT: '   ' }, git: gitSaying(service) }).commit, service, 'blank is not a pin');
});

test('stampEnv hands both toolchains the same value', () => {
  const env = stampEnv({ commit: ui, dirty: false }, { PATH: '/usr/bin' });
  assert.equal(env.APEX_BUILD_COMMIT, ui);
  assert.equal(env.APEX_BUILD_DIRTY, 'false');
  assert.equal(env.PATH, '/usr/bin', 'the rest of the environment is preserved');
});

test('both stampers read the pin instead of asking git on their own', () => {
  const vite = read('vite.config.ts');
  const buildRs = read('crates/apex-daemon/build.rs');
  assert.match(vite, /APEX_BUILD_COMMIT/, 'vite.config.ts must accept the pinned commit');
  assert.match(buildRs, /APEX_BUILD_COMMIT/, 'apex-daemon/build.rs must accept the pinned commit');
  // Without rerun-if-env-changed cargo keeps the previous stamp on a re-run.
  assert.match(buildRs, /rerun-if-env-changed=APEX_BUILD_COMMIT/);
});

test('packaging cannot bypass the pin', () => {
  const scripts = JSON.parse(read('package.json')).scripts;
  assert.match(scripts['desktop:package'], /package-pinned\.mjs/);
  assert.match(scripts['desktop:dmg'], /package-pinned\.mjs/);
  assert.match(scripts['_desktop:package'], /package-mac\.mjs/, 'the unpinned body still packages in place');
  assert.ok(!/--dir/.test(scripts['_desktop:package']), '--dir belongs to the pinned entry point so both use one body');
});
