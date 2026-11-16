import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { sweep, parseArgs } from '../scripts/clean-target.mjs';

const SCRIPT = join(process.cwd(), 'scripts/clean-target.mjs');
const DAY = 86_400_000;

/** A target folder with one stale and one fresh file in each place cargo writes. */
function fixture() {
  const target = mkdtempSync(join(tmpdir(), 'clean-target-'));
  const stale = new Date(Date.now() - 30 * DAY), fresh = new Date();
  const file = (p, when, size = 10) => { mkdirSync(join(target, p, '..'), { recursive: true }); writeFileSync(join(target, p), 'x'.repeat(size)); utimesSync(join(target, p), when, when); };
  file('debug/.cargo-lock', stale, 0);
  file('CACHEDIR.TAG', stale);
  file('debug/.rustc_info.json', stale);
  file('debug/apex-daemon', stale, 100);
  file('debug/deps/libold-aaaa.rlib', stale, 1000);
  file('debug/deps/libnew-bbbb.rlib', fresh, 1000);
  file('debug/incremental/apex_host-old/s-1/dep-graph.bin', stale);
  file('debug/incremental/apex_host-new/s-2/dep-graph.bin', fresh);
  file('debug/build/old-cccc/output', stale);
  file('debug/.fingerprint/old-dddd/lib-old', stale);
  file('x86_64-pc-windows-msvc/release/deps/libold-eeee.rlib', stale);
  return target;
}

test('sweep removes only stale files, keeps the lock and tag, and drops folders that became empty', () => {
  const target = fixture();
  try {
    const r = sweep(target, new Date(Date.now() - 7 * DAY));
    assert.equal(r.removed, 6, JSON.stringify(r));
    assert.equal(r.freed, 1000 + 100 + 10 * 4);
    assert.deepEqual(r.errors, []);
    assert.ok(!existsSync(join(target, 'debug/deps/libold-aaaa.rlib')));
    assert.ok(existsSync(join(target, 'debug/deps/libnew-bbbb.rlib')));
    assert.ok(!existsSync(join(target, 'debug/apex-daemon')));
    assert.ok(existsSync(join(target, 'debug/.cargo-lock')));
    assert.ok(existsSync(join(target, 'CACHEDIR.TAG')));
    assert.ok(existsSync(join(target, 'debug/.rustc_info.json')));
    assert.ok(!existsSync(join(target, 'debug/incremental/apex_host-old')), 'emptied incremental folder is gone');
    assert.ok(existsSync(join(target, 'debug/incremental/apex_host-new/s-2/dep-graph.bin')));
    assert.ok(existsSync(join(target, 'debug/build')), 'the folders cargo expects inside a profile stay, even empty');
    assert.equal(readdirSync(join(target, 'debug/build')).length, 0);
    assert.ok(existsSync(join(target, 'debug')), 'the profile folder itself stays');
    assert.ok(existsSync(join(target, 'x86_64-pc-windows-msvc/release')), 'so does a cross-target profile folder');
    assert.ok(existsSync(join(target, 'x86_64-pc-windows-msvc/release/deps')));
  } finally { rmSync(target, { recursive: true, force: true }); }
});

test('a dry run counts the same files and removes nothing', () => {
  const target = fixture();
  try {
    const before = readdirSync(join(target, 'debug/deps')).length;
    const r = sweep(target, new Date(Date.now() - 7 * DAY), { dryRun: true });
    assert.equal(r.removed, 6);
    assert.equal(readdirSync(join(target, 'debug/deps')).length, before);
    assert.ok(existsSync(join(target, 'debug/build/old-cccc/output')));
  } finally { rmSync(target, { recursive: true, force: true }); }
});

test('the command refuses while a build runs unless forced, and --dry-run never needs force', () => {
  const target = fixture();
  try {
    const busy = { ...process.env, CLEAN_TARGET_TEST_BUSY: '1' };
    const refused = spawnSync(process.execPath, [SCRIPT, '--target', target], { encoding: 'utf8', env: busy });
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /--force/);
    assert.ok(existsSync(join(target, 'debug/deps/libold-aaaa.rlib')), 'nothing was removed');
    const dry = spawnSync(process.execPath, [SCRIPT, '--target', target, '--dry-run'], { encoding: 'utf8', env: busy });
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stdout, /would remove 6 of 11 files/);
    const forced = spawnSync(process.execPath, [SCRIPT, '--target', target, '--force', '--days', '7'], { encoding: 'utf8', env: busy });
    assert.equal(forced.status, 0, forced.stderr);
    assert.match(forced.stdout, /removed 6 of 11 files/);
    const idle = spawnSync(process.execPath, [SCRIPT, '--target', target], { encoding: 'utf8', env: { ...process.env, CLEAN_TARGET_TEST_BUSY: '0' } });
    assert.equal(idle.status, 0, idle.stderr);
    assert.match(idle.stdout, /removed 0 of 5 files/);
  } finally { rmSync(target, { recursive: true, force: true }); }
});

test('arguments: days must be a number, the target must exist, unknown flags are refused', () => {
  assert.equal(parseArgs([]).days, 7);
  assert.equal(parseArgs(['--days', '0']).days, 0);
  assert.throws(() => parseArgs(['--days', 'soon']), /--days/);
  assert.throws(() => parseArgs(['--bogus']), /Unknown argument/);
  const r = spawnSync(process.execPath, [SCRIPT, '--target', join(tmpdir(), 'no-such-target-folder'), '--dry-run'], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /does not exist/);
});
