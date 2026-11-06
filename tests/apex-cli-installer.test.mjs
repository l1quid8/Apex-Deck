// Executes the real scripts/install-cli-provenance.sh against a throwaway root.
// The script hardcodes system paths and root ownership on purpose, so the test
// rewrites only those constants in a copy and stubs codesign/launchctl/ps.
// Every substitution must match exactly once or the test fails, so the harness
// cannot silently drift from the installer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SCRIPT = readFileSync(join(process.cwd(), 'scripts/install-cli-provenance.sh'), 'utf8');
const sha = (s) => createHash('sha256').update(s).digest('hex');

function harness() {
  // Short path: Unix socket paths are limited to ~104 bytes.
  const t = mkdtempSync('/tmp/aci-');
  const root = join(t, 'Prov');
  const plist = join(t, 'prov.plist');
  const sock = join(t, 'p.sock');
  const bin = join(t, 'shim');
  mkdirSync(bin);
  const shim = (name, body) => { writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`); chmodSync(join(bin, name), 0o755); };
  // codesign: verify passes when file exists; display reports hardened runtime and a CDHash derived from content.
  // Missing-file verification must fail, matching real codesign behavior.
  shim('codesign', `for a in "$@"; do f="$a"; done
case " $* " in
  *" --verify "*)
    [[ -f "$f" ]] || exit 1
    exit 0 ;;
  *" --entitlements "*) exit 0 ;;
  *) echo "CodeDirectory flags=0x10000(runtime)"; echo "CDHash=$(/usr/bin/shasum "$f" | /usr/bin/cut -c1-40)" ;;
esac`);
  shim('lipo', 'exit 0');
  shim('chown', 'exit 0');
  // launchctl: bootstrap/bootout of a missing plist fails, like the real tool.
  shim('launchctl', `echo "$*" >> "${t}/launchctl.log"
case "$1" in bootstrap|bootout) [[ -f "\${@: -1}" ]] || exit 5 ;; esac
[[ "$1" == bootstrap && -e "${t}/fail-bootstrap" ]] && exit 1
exit 0`);
  shim('ps', `[[ -f "${t}/ps.txt" ]] && cat "${t}/ps.txt"; exit 0`);

  let s = SCRIPT;
  const sub = (from, to, all = false) => {
    const n = s.split(from).length - 1;
    assert.ok(all ? n >= 1 : n === 1, `harness substitution drifted: ${JSON.stringify(from)} matched ${n}`);
    s = s.split(from).join(to);
  };
  sub(`root='/Library/Application Support/Apex Deck Provenance'`, `root='${root}'`);
  sub(`plist='/Library/LaunchDaemons/dev.apexdeck.provenance.plist'`, `plist='${plist}'`);
  sub(`[[ $EUID == 0 ]] ||`, `true ||`);
  sub(`s.st_uid!=0`, `s.st_uid!=os.getuid()`, true);
  sub(`/usr/bin/install -o root -g wheel`, `/usr/bin/install`, true);
  sub(`/usr/bin/codesign`, `${bin}/codesign`, true);
  sub(`/usr/bin/lipo`, `${bin}/lipo`);
  sub(`/bin/launchctl`, `${bin}/launchctl`, true);
  sub(`/usr/sbin/chown`, `${bin}/chown`);
  sub(`/bin/ps -axo`, `${bin}/ps -axo`);
  sub(`/var/run/dev.apexdeck.provenance.sock`, sock, true);
  sub(`/usr/local`, `${t}/usr/local`, true);
  const script = join(t, 'install.sh');
  writeFileSync(script, s);
  mkdirSync(join(t, 'usr'));

  // The broker readiness probe only needs connect() to succeed. spawnSync blocks
  // the event loop, but the kernel still completes connects into the backlog.
  const server = createServer(() => {});
  const listening = new Promise((r) => server.listen(sock, r));

  function payload(name, version, build) {
    const dir = join(t, name);
    mkdirSync(dir);
    const files = ['apex', 'apex-daemon', 'apex-provenance'].map((f) => {
      const body = `#!/bin/sh\necho ${f} ${version} ${build}\n`;
      writeFileSync(join(dir, f), body); chmodSync(join(dir, f), 0o755);
      return { name: f, sha256: sha(body) };
    });
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ formatVersion: 1, product: 'apex-cli', architecture: 'arm64', version, files }));
    return dir;
  }
  const run = (...args) => spawnSync('/bin/bash', [script, ...args], { encoding: 'utf8', env: { HOME: t } });
  const product = join(root, 'Standalone');
  const read = (p) => readFileSync(p, 'utf8');
  const config = () => JSON.parse(read(join(root, 'config.json')));
  const installedBuild = () => read(join(product, 'apex')).split('\n')[1];
  return { t, root, product, plist, payload, run, config, installedBuild, read, listening,
    lockHeld: () => existsSync(join(root, '.cli-enrollment.lock')),
    flag: (name, content = '') => writeFileSync(join(t, name), content),
    unflag: (name) => rmSync(join(t, name), { force: true }),
    close: () => { server.close(); rmSync(t, { recursive: true, force: true }); } };
}

async function withHarness(fn) {
  const h = harness();
  await h.listening;
  try { await fn(h); } finally { h.close(); }
}

const ok = (r) => assert.equal(r.status, 0, r.stdout + r.stderr);
const fails = (r) => assert.notEqual(r.status, 0, r.stdout + r.stderr);

test('fresh install creates Standalone and pins its hashes', () => withHarness(async (h) => {
  ok(h.run('--no-path-link', h.payload('a', '0.9.8', 'A')));
  assert.equal(h.installedBuild(), 'echo apex 0.9.8 A');
  assert.match(h.config().cliCdhash, /^[0-9a-f]{40}$/);
  assert.equal(h.lockHeld(), false);
}));

test('same version with identical build is a no-op', () => withHarness(async (h) => {
  ok(h.run('--no-path-link', h.payload('a', '0.9.8', 'A')));
  const before = h.read(join(h.root, 'config.json'));
  const r = h.run('--no-path-link', h.payload('b', '0.9.8', 'A'));
  ok(r);
  assert.match(r.stdout, /exact build; no changes needed/);
  assert.equal(h.read(join(h.root, 'config.json')), before);
  assert.equal(h.lockHeld(), false);
}));

test('same version with a rebuilt payload replaces binaries and pins', () => withHarness(async (h) => {
  ok(h.run('--no-path-link', h.payload('a', '0.9.8', 'A')));
  const oldPin = h.config().cliStandaloneCdhash;
  const r = h.run('--no-path-link', h.payload('b', '0.9.8', 'B'));
  ok(r);
  assert.match(r.stdout, /different build of the same version/);
  assert.equal(h.installedBuild(), 'echo apex 0.9.8 B');
  assert.notEqual(h.config().cliStandaloneCdhash, oldPin);
  assert.equal(h.read(join(h.root, 'apex-provenance')).split('\n')[1], 'echo apex-provenance 0.9.8 B');
}));

test('upgrade refuses while the installed CLI or backend is running, and changes nothing', () => withHarness(async (h) => {
  ok(h.run('--no-path-link', h.payload('a', '0.9.8', 'A')));
  const before = h.read(join(h.root, 'config.json'));
  for (const proc of ['apex-daemon', 'apex']) {
    h.flag('ps.txt', `/usr/sbin/syslogd\n${h.product}/${proc}\n`);
    const r = h.run('--no-path-link', h.payload(`b-${proc}`, '0.9.9', 'B'));
    fails(r);
    assert.match(r.stderr, /still running/);
    assert.equal(h.installedBuild(), 'echo apex 0.9.8 A');
    assert.equal(h.read(join(h.root, 'config.json')), before);
    assert.equal(h.lockHeld(), false, 'a refusal must not leave the lock behind');
  }
  // A path that merely contains the product path is not a match.
  h.flag('ps.txt', `${h.product}/apex-daemon-old\n`);
  ok(h.run('--no-path-link', h.payload('c', '0.9.9', 'C')));
}));

test('upgrade that fails after commit restores the previous product, config and broker', () => withHarness(async (h) => {
  ok(h.run('--no-path-link', h.payload('a', '0.9.8', 'A')));
  const before = h.read(join(h.root, 'config.json'));
  h.flag('fail-bootstrap');
  const r = h.run('--no-path-link', h.payload('b', '0.9.9', 'B'));
  fails(r);
  assert.equal(h.installedBuild(), 'echo apex 0.9.8 A');
  assert.equal(h.read(join(h.product, 'manifest.json')).includes('"0.9.8"'), true);
  assert.equal(h.read(join(h.root, 'config.json')), before);
  assert.equal(h.read(join(h.root, 'apex-provenance')).split('\n')[1], 'echo apex-provenance 0.9.8 A');
  h.unflag('fail-bootstrap');
}));

test('downgrade is refused and releases the lock', () => withHarness(async (h) => {
  ok(h.run('--no-path-link', h.payload('a', '0.9.8', 'A')));
  const r = h.run('--no-path-link', h.payload('b', '0.9.7', 'B'));
  fails(r);
  assert.match(r.stderr, /refusing downgrade/);
  assert.equal(h.lockHeld(), false);
  ok(h.run('--no-path-link', h.payload('c', '0.9.9', 'C')));
}));

test('uninstall refuses while running, then removes Standalone and keeps keys and data', () => withHarness(async (h) => {
  ok(h.run('--no-path-link', h.payload('a', '0.9.8', 'A')));
  writeFileSync(join(h.root, 'private-key'), 'k');
  h.flag('ps.txt', `${h.product}/apex\n`);
  fails(h.run('--uninstall'));
  assert.equal(existsSync(h.product), true);
  assert.equal(h.lockHeld(), false);
  h.unflag('ps.txt');
  ok(h.run('--uninstall'));
  assert.equal(existsSync(h.product), false);
  assert.equal(h.read(join(h.root, 'private-key')), 'k');
}));

test('uninstall that fails after commit restores the product and pins', () => withHarness(async (h) => {
  ok(h.run('--no-path-link', h.payload('a', '0.9.8', 'A')));
  // Desktop pins present -> the remove-pins path, which restarts the broker.
  const c = h.config(); c.uiCdhash = 'f'.repeat(40);
  writeFileSync(join(h.root, 'config.json'), JSON.stringify(c));
  const before = h.read(join(h.root, 'config.json'));
  h.flag('fail-bootstrap');
  rmSync(join(h.t, 'p.sock'));  // broker never becomes ready
  const r = h.run('--uninstall');
  fails(r);
  assert.match(r.stderr, /previous install restored/);
  assert.equal(h.installedBuild(), 'echo apex 0.9.8 A');
  assert.equal(h.read(join(h.root, 'config.json')), before);
  assert.equal(existsSync(h.plist), true);
}));

test('fresh install → uninstall (fresh-only) → reinstall succeeds and preserves keys', () => withHarness(async (h) => {
  ok(h.run('--no-path-link', h.payload('fresh', '0.9.8', 'A')));
  writeFileSync(join(h.root, 'private-key'), 'keep-me');
  writeFileSync(join(h.root, 'journal.json'), '{"kept":true}');
  // Fresh-only uninstall removes config + broker but keeps root.
  ok(h.run('--uninstall'));
  assert.equal(existsSync(h.product), false);
  assert.equal(existsSync(join(h.root, 'config.json')), false);
  assert.equal(existsSync(join(h.root, 'apex-provenance')), false);
  // Keys and journal preserved per uninstall contract
  assert.equal(h.read(join(h.root, 'private-key')), 'keep-me');
  // Reinstall from preserved state must succeed without trying to verify missing broker.
  assert.equal(existsSync(h.plist), false, 'uninstall removes the service file');
  ok(h.run('--no-path-link', h.payload('fresh2', '0.9.8', 'B')));
  assert.equal(h.installedBuild(), 'echo apex 0.9.8 B');
  assert.match(h.read(h.plist), /dev\.apexdeck\.provenance/, 'reinstall recreates the service file');
  assert.equal(h.read(join(h.root, 'private-key')), 'keep-me');
  assert.equal(h.lockHeld(), false);
}));

test('reinstall of the identical build after uninstall still restores the service', () => withHarness(async (h) => {
  ok(h.run('--no-path-link', h.payload('a', '0.9.8', 'A')));
  ok(h.run('--uninstall'));
  ok(h.run('--no-path-link', h.payload('b', '0.9.8', 'A')));
  assert.equal(existsSync(h.plist), true);
  assert.equal(h.installedBuild(), 'echo apex 0.9.8 A');
}));

test('failed reinstall after uninstall removes the service file it wrote', () => withHarness(async (h) => {
  ok(h.run('--no-path-link', h.payload('a', '0.9.8', 'A')));
  ok(h.run('--uninstall'));
  h.flag('fail-bootstrap');
  fails(h.run('--no-path-link', h.payload('b', '0.9.9', 'B')));
  assert.equal(existsSync(h.plist), false);
  assert.equal(existsSync(h.product), false);
  // A failure after commit keeps the lock by design: inspect before retrying.
  assert.equal(h.lockHeld(), true);
  h.unflag('fail-bootstrap');
}));
