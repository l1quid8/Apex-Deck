import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validHost, sshArgs, loadHosts, saveHosts, windowsAtLaunch, LOCAL } from '../desktop/hosts.mjs';

test('a host needs a plain SSH destination', () => {
  assert.deepEqual(validHost({ name: ' vps ', ssh: 'me@vps.example.com' }, []), { name: 'vps', ssh: 'me@vps.example.com', command: 'apex-daemon' });
  assert.equal(validHost({ name: 'box', ssh: 'box', command: '/opt/apex/bin/apex-daemon' }, []).command, '/opt/apex/bin/apex-daemon');
  assert.equal(validHost({ name: 'box', ssh: 'box', command: '~/bin/apex-daemon' }, []).command, '~/bin/apex-daemon');
  for (const ssh of ['', '  ', '-oProxyCommand=sh', '--', 'me@vps; rm -rf ~', 'a b', 'vps\n', 'v\u0000ps', 'v\tps']) {
    assert.throws(() => validHost({ name: 'x', ssh }, []), /SSH destination/, JSON.stringify(ssh));
  }
});

test('the daemon command is one plain word or path', () => {
  for (const command of ['apex-daemon; reboot', 'apex-daemon --stdio', '$(id)', 'a`b`', 'a|b', 'a&b', "a'b", 'a"b', '']) {
    assert.throws(() => validHost({ name: 'x', ssh: 'vps', command }, []), /command/, JSON.stringify(command));
  }
});

test('names are 1 to 40 characters and unique', () => {
  assert.throws(() => validHost({ name: '   ', ssh: 'vps' }, []), /name/);
  assert.throws(() => validHost({ name: 'x'.repeat(41), ssh: 'vps' }, []), /40/);
  assert.equal(validHost({ name: 'x'.repeat(40), ssh: 'vps' }, []).name.length, 40);
  assert.throws(() => validHost({ name: 'VPS', ssh: 'vps' }, ['vps']), /already/);
  assert.throws(() => validHost({ name: 'this mac', ssh: 'vps' }, []), /already/);
});

test('ssh runs the daemon with no prompts, keepalives and a connect timeout', () => {
  assert.deepEqual(sshArgs({ ssh: 'me@vps', command: 'apex-daemon' }), [
    '-T', '-o', 'BatchMode=yes', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3', '-o', 'ConnectTimeout=15',
    '--', 'me@vps', 'apex-daemon --stdio --attach',
  ]);
});

function temp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-hosts-'));
  return { file: path.join(dir, 'hosts.json'), done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('hosts.json: missing means only This Mac', () => {
  const t = temp();
  try {
    assert.deepEqual(loadHosts(t.file), { state: { version: 1, hosts: [], last: LOCAL }, warnings: [] });
  } finally { t.done(); }
});

test('hosts.json keeps what it does not know, drops hosts it cannot use, and falls back to This Mac', () => {
  const t = temp();
  try {
    fs.writeFileSync(t.file, JSON.stringify({
      version: 1, future: { keep: true }, last: 'h-gone',
      hosts: [
        { id: 'h-1', name: 'vps', ssh: 'me@vps', command: 'apex-daemon', color: 'teal' },
        { id: 'h-2', name: 'bad', ssh: '-oProxyCommand=evil' },
        { id: 'h-3', name: 'vps', ssh: 'other' },
      ],
    }));
    const { state, warnings } = loadHosts(t.file);
    assert.deepEqual(state.hosts, [{ id: 'h-1', name: 'vps', ssh: 'me@vps', command: 'apex-daemon', color: 'teal' }]);
    assert.equal(state.last, LOCAL);
    assert.deepEqual(state.future, { keep: true });
    assert.equal(warnings.length, 2);
    saveHosts(t.file, { ...state, last: 'h-1' });
    const again = JSON.parse(fs.readFileSync(t.file, 'utf8'));
    assert.equal(again.last, 'h-1');
    assert.deepEqual(again.future, { keep: true });
    assert.equal(again.hosts[0].color, 'teal');
    assert.equal(fs.statSync(t.file).mode & 0o777, 0o600);
  } finally { t.done(); }
});

test('an unreadable hosts.json is set aside with a warning, not lost', () => {
  const t = temp();
  try {
    fs.writeFileSync(t.file, '{ not json');
    const { state, warnings } = loadHosts(t.file);
    assert.deepEqual(state, { version: 1, hosts: [], last: LOCAL });
    assert.match(warnings[0], /could not be read/);
    assert.ok(fs.readdirSync(path.dirname(t.file)).some((f) => f.startsWith('hosts.json.unreadable')));
  } finally { t.done(); }
});

test('Deck opens a window on each host that had one, once each, and on This Mac when none can be', () => {
  const hosts = [{ id: 'h-1', name: 'vps', ssh: 'vps', command: 'apex-daemon' }];
  // Saved before there were windows: the host last used.
  assert.deepEqual(windowsAtLaunch({ hosts, last: 'h-1' }), ['h-1']);
  assert.deepEqual(windowsAtLaunch({ hosts, last: LOCAL, windows: ['h-1', LOCAL, 'h-1'] }), ['h-1', LOCAL]);
  assert.deepEqual(windowsAtLaunch({ hosts, last: 'h-1', windows: ['h-gone'] }), [LOCAL]);
  assert.deepEqual(windowsAtLaunch({ hosts: [], last: LOCAL, windows: 'nonsense' }), [LOCAL]);
});
