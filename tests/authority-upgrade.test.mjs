import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const inventory = new URL('../scripts/authority-inventory.sh', import.meta.url).pathname;
const entry = (inode = 10) => ({ inode, device: 1, uid: 0, gid: 0, mode: '0o600', bytes: 5, sha256: 'abc', symlink: false });
function snapshot() {
  return {
    authority: Object.fromEntries(['private-key', 'public-key', 'journal.json'].map(n => [n, entry()])),
    authorityDirectory: { ...entry(1), mode: '0o755' },
    locksDirectory: { ...entry(2), mode: '0o755' }, locksReadable: true,
    locks: { scope: entry(3) }, pins: { uiCdhash: 'ui', daemonCdhash: 'daemon' },
    apps: { trustedUI: { exists: true, rootProtected: true } }, agent: {}, running: [],
  };
}
function compare(before, after) {
  const dir = mkdtempSync('/tmp/apex-inventory-test-');
  try {
    const paths = ['before', 'after'].map(n => path.join(dir, n + '.json'));
    [before, after].forEach((v, i) => writeFileSync(paths[i], JSON.stringify(v)));
    return spawnSync('/bin/bash', [inventory, '--compare', ...paths], { encoding: 'utf8' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('authority comparison refuses a vanished lock directory even when it was empty', () => {
  const before = snapshot(), after = snapshot();
  before.locks = {}; after.locks = {}; after.locksDirectory = null;
  const result = compare(before, after);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stdout, /FAIL.*host-locks\/ directory/);
});

test('an unreadable lock listing cannot prove there were no existing locks', () => {
  const before = snapshot(), after = snapshot();
  before.locks = {}; after.locks = {}; before.locksReadable = false;
  const result = compare(before, after);
  assert.equal(result.status, 2, result.stdout);
  assert.match(result.stdout, /INCONCLUSIVE/);
});

test('authority comparison rejects changed lock device, permissions, or a replaced authority directory', () => {
  for (const mutate of [
    s => { s.locks.scope.device = 2; },
    s => { s.locks.scope.uid = 501; },
    s => { s.locksDirectory.mode = '0o777'; },
    s => { s.authorityDirectory.inode = 99; },
    s => { s.authority['private-key'].mode = '0o644'; },
  ]) {
    const after = snapshot(); mutate(after);
    const result = compare(snapshot(), after);
    assert.equal(result.status, 1, result.stdout);
  }
});

test('new locks are allowed while preserved authority remains verifiable', () => {
  const after = snapshot(); after.locks.newscope = entry(4);
  assert.equal(compare(snapshot(), after).status, 0);
  const beforeMissing = snapshot(); beforeMissing.authority['journal.json'].sha256 = null;
  assert.equal(compare(beforeMissing, after).status, 2);
});

test('missing identity metadata on both inventories cannot establish preservation', () => {
  const before = snapshot(), after = snapshot();
  for (const s of [before, after]) {
    delete s.authorityDirectory.device;
    delete s.authority['private-key'].inode;
    delete s.locks.scope.gid;
  }
  assert.notEqual(compare(before, after).status, 0);
});

const verifier = readFileSync(new URL('../scripts/verify-protected-bundle.sh', import.meta.url), 'utf8');
const acceptance = readFileSync(new URL('../scripts/acceptance-provenance.sh', import.meta.url), 'utf8');
const hashes = { ui: 'a'.repeat(40), daemon: 'b'.repeat(40), broker: 'c'.repeat(40) };

function fakeBundle(dir, name, wires = ['000011011']) {
  const app = path.join(dir, name);
  const framework = path.join(app, 'Contents/Frameworks/Electron Framework.framework/Electron Framework');
  mkdirSync(path.dirname(framework), { recursive: true });
  writeFileSync(framework, Buffer.concat(wires.map(w => Buffer.concat([
    Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX'), Buffer.from([1, w.length]), Buffer.from(w),
  ]))));
  mkdirSync(path.join(app, 'Contents/Resources/bin'), { recursive: true });
  writeFileSync(path.join(app, 'Contents/Resources/bin/apex-daemon'), 'daemon');
  writeFileSync(path.join(app, 'Contents/Info.plist'), '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>dev.apexdeck.app</string><key>ElectronAsarIntegrity</key><dict><key>hash</key><string>fixture</string></dict></dict></plist>');
  return app;
}

// Only the external signature operation is substituted; execute the actual
// verifier and its hash comparison against a synthetic bundle and fuse wires.
const signatureEffect = `
test_codesign() {
  if [[ "$1" == --verify ]]; then return 0; fi
  local image="\${@: -1}" hash="$UI_HASH"
  case "$image" in */apex-daemon) hash="$DAEMON_HASH" ;; */apex-provenance) hash="$BROKER_HASH" ;; esac
  printf 'flags=0x10000(runtime)\\nCDHash=%s\\n' "$hash" >&2
}
`;

test('candidate verification rejects a different signed broker and requires its expected hash', () => {
  const dir = mkdtempSync('/tmp/apex-bundle-test-');
  try {
    const app = fakeBundle(dir, 'Apex Deck.app');
    const broker = path.join(dir, 'apex-provenance'); writeFileSync(broker, 'broker');
    const run = (expected = []) => spawnSync('/bin/bash', ['-s', '--', app, hashes.ui, hashes.daemon, broker, ...expected], {
      input: signatureEffect + verifier.replaceAll('/usr/bin/codesign', 'test_codesign'), encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin', UI_HASH: hashes.ui, DAEMON_HASH: hashes.daemon, BROKER_HASH: hashes.broker },
    });
    const mismatch = run(['d'.repeat(40)]);
    assert.equal(mismatch.status, 1, mismatch.stdout + mismatch.stderr);
    assert.match(mismatch.stderr, /broker CDHash.*not the selected candidate/);
    assert.equal(run().status, 1, 'a supplied broker must have an explicit expected hash');
    assert.equal(run([hashes.broker]).status, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('installed acceptance checks both protected and Applications fuse wires, including every slice', () => {
  const dir = mkdtempSync('/tmp/apex-fuse-test-');
  try {
    const app = fakeBundle(dir, 'Trusted.app');
    const installed = fakeBundle(dir, 'Installed.app', ['000011011', '101100011']);
    const check = acceptance.slice(acceptance.indexOf('static_runtime() {'), acceptance.indexOf('\nstatic_entitlements() {'));
    const result = spawnSync('/bin/bash', ['-s'], {
      input: signatureEffect + '\n' + check.replaceAll('/usr/bin/codesign', 'test_codesign') + `
pass_check() { printf 'PASS %s %s\\n' "$1" "$2"; }
fail_check() { printf 'FAIL %s %s\\n' "$1" "$2"; }
skip_check() { printf 'SKIP %s %s\\n' "$1" "$2"; }
static_runtime
`, encoding: 'utf8', env: { PATH: '/usr/bin:/bin', APP: app, DAEMON: path.join(app, 'Contents/Resources/bin/apex-daemon'),
        BROKER: path.join(app, 'Contents/Resources/bin/apex-daemon'), INSTALLED_APP: installed, UI_HASH: hashes.ui },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /PASS static\.fuses /);
    assert.match(result.stdout, /FAIL static\.fuses\.installed .*101100011/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('broker-client detection drains strings output instead of treating SIGPIPE as absence', () => {
  const dir = mkdtempSync('/tmp/apex-strings-test-');
  try {
    const binary = path.join(dir, 'binary');
    writeFileSync(binary, 'dev.apexdeck.provenance\n' + 'padding bytes to fill a pipe\n'.repeat(100000));
    const check = acceptance.slice(acceptance.indexOf('has_text() {'), acceptance.indexOf('\n\n', acceptance.indexOf('has_text() {')));
    const result = spawnSync('/bin/bash', ['-s', '--', binary], {
      input: 'set -o pipefail\n' + check + '\nhas_text "$1" dev.apexdeck.provenance\n', encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

const procedure = readFileSync(new URL('../docs/handoff/2026-10-22/UPGRADE-PROCEDURE.md', import.meta.url), 'utf8');
function heredoc(name) {
  const marker = `<<'${name}'\n`;
  const start = procedure.indexOf(marker);
  assert.notEqual(start, -1, name + ' block exists');
  return procedure.slice(start + marker.length, procedure.indexOf('\n' + name, start));
}

// Execute the documented command bodies with real temporary files and renames.
// Only the fixed live paths, launchd/process checks, codesign and root ownership
// effects are replaced. No live app, authority, service or sudo is accessed.
test('documented swap stops at each failed rename and rollback preserves authority and both apps', () => {
  for (const failAt of [1, 2, 3, 4, 0]) {
    const dir = mkdtempSync('/tmp/apex-swap-test-');
    try {
      const stamp = '20261023-000000';
      const root = path.join(dir, 'authority'), backup = path.join(dir, 'backup'), applications = path.join(dir, 'Applications');
      const stage = path.join(root, '.upgrade-' + stamp);
      for (const p of [stage, backup, applications, path.join(root, 'TrustedUI'), path.join(root, 'host-locks')]) mkdirSync(p, { recursive: true });
      const oldApp = fakeBundle(path.join(root, 'TrustedUI'), 'Apex Deck.app');
      fakeBundle(stage, 'Apex Deck.app');
      fakeBundle(applications, 'Apex Deck.app');
      writeFileSync(path.join(oldApp, 'old-build'), 'original protected build');
      writeFileSync(path.join(applications, 'Apex Deck.app', 'old-build'), 'original Applications build');
      writeFileSync(path.join(root, 'apex-provenance'), 'old broker');
      writeFileSync(path.join(stage, 'apex-provenance'), 'candidate broker');
      const config = JSON.stringify({ uiCdhash: 'old-ui', daemonCdhash: 'old-daemon', futureKey: 'retained' });
      writeFileSync(path.join(root, 'config.json'), config); writeFileSync(path.join(backup, 'config.json'), config);
      const authorityFiles = ['private-key', 'public-key', 'journal.json', 'host-locks/scope'];
      for (const f of authorityFiles) writeFileSync(path.join(root, f), 'unchanged ' + f);
      const identity = () => Object.fromEntries([...authorityFiles, 'host-locks'].map(f => [f, {
        inode: statSync(path.join(root, f)).ino,
        content: f === 'host-locks' ? '' : readFileSync(path.join(root, f), 'utf8'),
      }]));
      const before = identity();
      const codesign = path.join(dir, 'codesign');
      writeFileSync(codesign, '#!/bin/bash\nprintf "CDHash=eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee\\n" >&2\n', { mode: 0o755 });
      const pathsAndEffects = code => code
        .replace("ROOT='/Library/Application Support/Apex Deck Provenance'", 'ROOT=$TEST_ROOT')
        .replace('BACKUP="/Library/Application Support/Apex Deck Provenance.backup-$STAMP"', 'BACKUP=$TEST_BACKUP')
        .replace("APPLICATIONS='/Applications'", 'APPLICATIONS=$TEST_APPLICATIONS')
        .replaceAll('/bin/launchctl', 'test_launchctl').replaceAll('/usr/bin/pgrep', 'test_pgrep')
        .replace('/usr/sbin/chown root:wheel "$ROOT/apex-provenance"', ':')
        .replaceAll('"/usr/bin/codesign"', JSON.stringify(codesign))
        .replace('os.chown(temp, 0, 0)', 'os.chown(temp, os.getuid(), os.getgid())')
        .replace('/usr/bin/install -o root -g wheel -m 600', '/usr/bin/install -m 600');
      const effects = 'test_launchctl() { :; }\ntest_pgrep() { return 1; }\n';
      const env = { PATH: '/usr/bin:/bin', TEST_ROOT: root, TEST_BACKUP: backup, TEST_APPLICATIONS: applications, FAIL_AT: String(failAt) };
      const run = input => spawnSync('/bin/bash', ['-euo', 'pipefail', '-s', '--', stamp], { input, encoding: 'utf8', env });
      const failMove = `
MOVE_COUNT=0
test_mv() {
  ((MOVE_COUNT+=1))
  if [[ "$MOVE_COUNT" == "$FAIL_AT" ]]; then return 73; fi
  /bin/mv "$@"
}
`;
      const swap = run(effects + failMove + pathsAndEffects(heredoc('SWAP')).replaceAll('/bin/mv', 'test_mv'));
      assert.equal(swap.status, failAt ? 73 : 0, swap.stdout + swap.stderr);
      assert.deepEqual(identity(), before);
      if (failAt) assert.equal(readFileSync(path.join(root, 'config.json'), 'utf8'), config, 'pins must not change after a failed rename');
      else {
        assert.equal(JSON.parse(readFileSync(path.join(root, 'config.json'))).futureKey, 'retained');
        // Model Phase G having completed as well: move the original aside, then
        // place a candidate. The same root rollback must restore this copy too.
        const previous = path.join(applications, 'Apex Deck.app.previous-' + stamp);
        const moved = spawnSync('/bin/mv', [path.join(applications, 'Apex Deck.app'), previous]);
        assert.equal(moved.status, 0);
        fakeBundle(applications, 'Apex Deck.app');
      }
      const rollback = run(effects + pathsAndEffects(heredoc('ROLLBACK')));
      assert.equal(rollback.status, 0, rollback.stdout + rollback.stderr);
      assert.deepEqual(identity(), before);
      assert.equal(readFileSync(path.join(root, 'config.json'), 'utf8'), config);
      assert.equal(readFileSync(path.join(root, 'apex-provenance'), 'utf8'), 'old broker');
      assert.ok(existsSync(path.join(oldApp, 'old-build')));
      assert.ok(existsSync(path.join(applications, 'Apex Deck.app', 'old-build')));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});
