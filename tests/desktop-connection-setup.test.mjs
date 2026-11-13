import test from 'node:test';
import assert from 'node:assert/strict';
import { createConnectionSetup, setupFields, installScript, startScript } from '../desktop/connectionSetup.mjs';
import { sshArgs } from '../desktop/hosts.mjs';
import { applyHostUpdate } from '../desktop/hostIdentity.mjs';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function fixture({ unknown = false, changed = false, missing = false } = {}) {
  const calls = [], remembered = [], saved = [];
  let trusted = false;
  const setup = createConnectionSetup({
    async run(program, args) {
      calls.push([program, args]);
      if (program === 'ssh-keyscan') return { stdout: 'box ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIABk\n', stderr: '', code: 0 };
      if (args.includes('-G')) return { stdout: 'hostname box\nport 2222\nhostkeyalias box\n', code: 0 };
      if (changed) return { code: 255, stderr: 'WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!', stdout: '' };
      if (unknown && !trusted) return { code: 255, stderr: 'No ED25519 host key is known for box and you have requested strict checking.', stdout: '' };
      return { code: 0, stdout: `os=Linux\narch=x86_64\nhome=/home/me\nbin=${missing ? '' : '/usr/bin/apex-daemon'}\n`, stderr: '' };
    },
    async remember(line) { remembered.push(line); trusted = true; },
    async release() { return { url: 'https://github.com/l1quid8/Apex-Deck/releases/download/v1.0.0/daemon', sha256: 'a'.repeat(64) }; },
    async verify(host) { calls.push(['verify', host]); return { daemonHostId: 'identity-1', version: '1.0.0' }; },
    async save(host) { saved.push(host); return [host]; },
  });
  return { setup, calls, remembered, saved };
}
test('setup validates ports and derives an optional name without treating SSH options as destinations', () => {
  assert.equal(setupFields({ ssh: 'me@box' }).name, 'box');
  assert.equal(setupFields({ ssh: 'box', port: 2222 }).port, 2222);
  for (const fields of [{ ssh: '-p22' }, { ssh: 'box;id' }, { ssh: 'box', port: 0 }, { ssh: 'box', port: 1.5 }, { ssh: 'box', port: '22' }]) assert.throws(() => setupFields(fields));
});
test('unknown host shows a real fingerprint and runs no remote probe before explicit trust', async () => {
  const f = fixture({ unknown: true });
  const trust = await f.setup.check({ ssh: 'box' });
  assert.equal(trust.kind, 'trust');
  assert.match(trust.fingerprint, /^SHA256:/);
  assert.equal(f.remembered.length, 0);
  const review = await f.setup.trust(trust.ticket);
  assert.equal(review.kind, 'ready');
  assert.equal(f.saved.length, 0);
  assert.equal(f.remembered.length, 1);
  assert.ok(f.calls.filter(([p]) => p === 'ssh').every(([, a]) => a.includes('StrictHostKeyChecking=yes') || a.includes('-G')));
});
test('changed keys stop setup without scanning, trusting or saving', async () => {
  const f = fixture({ changed: true });
  await assert.rejects(f.setup.check({ ssh: 'box' }), /CHANGED/);
  assert.equal(f.calls.some(([p]) => p === 'ssh-keyscan'), false);
  assert.deepEqual(f.remembered, []);
  assert.deepEqual(f.saved, []);
});
test('missing Deck is reviewed before install; connect verifies identity before saving', async () => {
  const f = fixture({ missing: true });
  const review = await f.setup.check({ ssh: 'box', port: 2222 });
  assert.equal(review.kind, 'install');
  assert.equal(f.calls.some(([, a]) => Array.isArray(a) && a.at(-1).includes('curl')), false);
  await f.setup.finish(review.ticket);
  assert.equal(f.saved[0].daemonHostId, 'identity-1');
  assert.equal(f.saved[0].command, '/home/me/.local/bin/apex-daemon');
  assert.equal(f.saved[0].port, 2222);
  await assert.rejects(f.setup.finish(review.ticket), /expired|again/);
});
test('cancelled and untrusted tickets cannot install or save', async () => {
  const f = fixture({ unknown: true });
  const trust = await f.setup.check({ ssh: 'box' });
  await assert.rejects(f.setup.finish(trust.ticket), /check|trust/i);
  f.setup.cancel(trust.ticket);
  await assert.rejects(f.setup.trust(trust.ticket), /expired|again/);
  assert.equal(f.saved.length, 0);
});
test('installation quotes paths and verifies a checksum before replacement', () => {
  const script = installScript({ url: 'https://example.com/daemon', sha256: 'a'.repeat(64) }, '/home/test user/.local/bin/apex-daemon');
  assert.match(script, /sha256sum/);
  assert.ok(script.indexOf('sha256sum') < script.indexOf('mv -f'));
  assert.match(script, /trap/);
  assert.match(script, /target='\/home\/test user/);
});
test('approved connect starts the host before verifying its daemon', async () => {
  const f = fixture();
  const review = await f.setup.check({ ssh: 'box' });
  await f.setup.finish(review.ticket);
  const start = f.calls.findIndex(([program, args]) => program === 'ssh' && args.at(-1).includes('nohup'));
  assert.ok(start > 0);
  assert.ok(start < f.calls.findIndex(([program]) => program === 'verify'));
  assert.match(startScript('/usr/bin/apex-daemon', 'Linux'), /systemctl --user/);
});
test('SSH keeps spaces inside the additional known hosts filename', () => {
  const args = sshArgs({ ssh: 'box', command: 'apex-daemon', knownHostsFile: '/Application Support/ssh_known_hosts', port: 2222 });
  assert.ok(args.includes('GlobalKnownHostsFile="/Application Support/ssh_known_hosts" /etc/ssh/ssh_known_hosts /etc/ssh/ssh_known_hosts2'));
  assert.equal(args[args.indexOf('-p') + 1], '2222');
});
test('clearing an explicit port rechecks identity and removes the saved port', () => {
  const host = { id: 'one', name: 'box', ssh: 'box', command: 'apex-daemon', daemonHostId: 'identity-1', port: 2222 };
  const state = { hosts: [host] }, fields = { name: 'box', ssh: 'box', command: 'apex-daemon' };
  assert.throws(() => applyHostUpdate(state, host.id, fields, { before: host }), /check|saved/i);
  const next = applyHostUpdate(state, host.id, fields, { before: host, probed: { host_id: 'identity-1' } });
  assert.equal(next.hosts[0].port, undefined);
});
test('real install shell replaces only checksum-verified downloads and cleans failed downloads', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-install-'));
  try {
    const source = '#!/bin/sh\necho apex-daemon 1.0.0\n';
    const download = path.join(temp, 'download');
    fs.writeFileSync(download, source);
    fs.writeFileSync(path.join(temp, 'curl'), '#!/bin/sh\nwhile [ "$1" != "-o" ]; do shift; done\ncp "$DOWNLOAD" "$2"\n', { mode: 0o755 });
    const target = path.join(temp, 'home space', 'apex-daemon');
    const asset = { url: 'https://example.test/daemon', sha256: crypto.createHash('sha256').update(source).digest('hex') };
    const options = { env: { ...process.env, PATH: `${temp}:${process.env.PATH}`, DOWNLOAD: download }, encoding: 'utf8' };
    execFileSync('sh', ['-c', installScript(asset, target)], options);
    assert.equal(fs.readFileSync(target, 'utf8'), source);
    fs.writeFileSync(download, '#!/bin/sh\necho corrupt\n');
    assert.throws(() => execFileSync('sh', ['-c', installScript(asset, target)], { ...options, stdio: 'pipe' }), /checksum/);
    assert.equal(fs.readFileSync(target, 'utf8'), source);
    assert.deepEqual(fs.readdirSync(path.dirname(target)), ['apex-daemon']);
    execFileSync('sh', ['-n'], { input: startScript('/usr/bin/apex-daemon', 'Linux') });
    execFileSync('sh', ['-n'], { input: startScript('/usr/bin/apex-daemon', 'Darwin') });
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
test('cancelling during daemon verification prevents a late save', async () => {
  let settle, began;
  const started = new Promise(resolve => { began = resolve; });
  const saved = [];
  const setup = createConnectionSetup({
    run: async () => ({ code: 0, stdout: 'os=Linux\narch=x86_64\nhome=/home/me\nbin=/usr/bin/apex-daemon\n' }),
    remember: async () => {},
    verify: () => { began(); return new Promise(resolve => { settle = resolve; }); },
    save: async host => { saved.push(host); return saved; },
  });
  const review = await setup.check({ ssh: 'box' });
  const finishing = setup.finish(review.ticket);
  await started;
  setup.cancel(review.ticket);
  settle({ daemonHostId: 'late' });
  await assert.rejects(finishing, /cancelled/);
  assert.deepEqual(saved, []);
});
test('a failed daemon hello never saves a checked host', async () => {
  let saved = false;
  const setup = createConnectionSetup({ run: async () => ({ code: 0, stdout: 'os=Linux\nbin=/usr/bin/apex-daemon\n' }), remember: async () => {}, verify: async () => { throw Error('incompatible protocol'); }, save: async () => { saved = true; } });
  const review = await setup.check({ ssh: 'box' });
  await assert.rejects(setup.finish(review.ticket), /incompatible/);
  assert.equal(saved, false);
});
