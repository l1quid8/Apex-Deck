import test from 'node:test';
import assert from 'node:assert/strict';
import { DaemonClient } from '../src/daemon/client.ts';
import { webSocketConnect } from '../src/daemon/webSocketLink.ts';
import { openPhoneHost } from '../src/phoneBackend.ts';
import {
  addMachine, approvalWhere, draftVisible, forkLine, loadMachines, newThreadGate,
  downLine, pauseLine, pressNewThread, refusalLine, threadSend, threadTitleFromMessage,
} from '../src/phoneRules.ts';
import { phoneShell } from '../src/phoneShell.ts';

const mac = { id: 'local', name: "Tyler's MacBook", kind: 'mac', url: 'ws://mac.local:7420', token: 'mac-token' };
const hetzner = { id: 'hetzner', name: 'Hetzner-EU', kind: 'server', url: 'wss://hetzner.example:7420', token: 'server-token' };

test('a phone refuses to call the Mac "This Mac" and only pairs one Mac', () => {
  assert.throws(() => addMachine([], { ...mac, name: 'This Mac' }), /not This Mac/);
  assert.throws(() => addMachine([], { ...mac, url: '203.0.113.24' }), /ws:\/\//);
  assert.throws(() => addMachine([], { ...mac, token: '  ' }), /token/);
  assert.throws(() => addMachine([mac], { ...hetzner, kind: 'mac', id: 'local', name: 'Other Mac' }), /already paired|already has a Mac/);
  const paired = addMachine([mac], hetzner);
  assert.deepEqual(paired.map((machine) => machine.name), ["Tyler's MacBook", 'Hetzner-EU']);
  assert.deepEqual(loadMachines(JSON.stringify([{ ...hetzner, name: 'This Mac' }, hetzner])), [hetzner]);
});

test('an asleep Mac does not pause a server thread, and a refused send keeps the draft', () => {
  const links = [
    { id: 'local', name: "Tyler's MacBook", kind: 'mac', status: 'offline' },
    { id: 'hetzner', name: 'Hetzner-EU', kind: 'server', status: 'online' },
  ];
  const asleep = threadSend(links, 'local', 'Fix the typo in README');
  assert.equal(asleep.enabled, false);
  assert.equal(asleep.reason, "Paused until Tyler's MacBook wakes");
  assert.equal(asleep.enabled ? '' : 'Fix the typo in README', 'Fix the typo in README');
  const server = threadSend(links, 'hetzner', 'Fix the typo in README');
  assert.deepEqual(server, { enabled: true, reason: '' });
  assert.equal(pauseLine(links[1], 'offline'), 'Paused while Hetzner-EU reconnects');
  assert.equal(threadSend(links, 'hetzner', '  ', 0).enabled, false);
  assert.equal(threadSend(links, 'hetzner', '', 1).enabled, true);
});

test('a new thread needs both the Mac and the machine it runs on', () => {
  const asleep = { id: 'local', name: "Tyler's MacBook", kind: 'mac', status: 'offline' };
  const up = { id: 'hetzner', name: 'Hetzner-EU', kind: 'server', status: 'online' };
  assert.match(newThreadGate(asleep, up).reason, /wakes/);
  assert.equal(newThreadGate({ ...asleep, status: 'online' }, up).ok, true);
  assert.equal(newThreadGate(undefined, up).ok, false);
});

test('titles drop tool names, approvals name a server copy only on a server, and an empty draft is reused', () => {
  assert.equal(threadTitleFromMessage('Run the load test on the Hetzner copy. !docker'), 'Run the load test on');
  assert.equal(approvalWhere("Tyler's MacBook", '~/Downloads/apex-deck', 'mac'), "Tyler's MacBook, in ~/Downloads/apex-deck");
  assert.equal(approvalWhere('Hetzner-EU', '/root/apex-deck', 'server'), 'Hetzner-EU, in /root/apex-deck (server copy)');
  assert.equal(draftVisible('  ', 0), false);
  assert.equal(draftVisible('', 1), true);
  assert.equal(pressNewThread({ workspaceId: 'a', text: '', files: 0 }, 'b'), 'move');
  assert.equal(pressNewThread({ workspaceId: 'a', text: 'hello', files: 0 }, 'b'), 'blocked');
  assert.match(forkLine({ title: 'Load test', host: 'Hetzner-EU', at: 2, crossed: true }, 2, true), /nothing runs until you send/);
  assert.match(forkLine({ title: 'Load test', host: 'Hetzner-EU', at: 2, crossed: true }, 2, true), /approval stays with the original thread on Hetzner-EU/);
  assert.doesNotMatch(forkLine({ title: 'Load test', host: 'Hetzner-EU', at: 2 }, 3, false), /nothing runs|approval stays|Files already/);
});

test('the phone shell does not stop the machine, reveal files, or open a new window', async () => {
  const opened = [];
  const shell = phoneShell({ machineName: 'Hetzner-EU', openExternal: (url) => opened.push(url) });
  assert.equal(shell.quitStopsWork, false);
  await shell.openTarget('https://example.com', null, false);
  assert.deepEqual(opened, ['https://example.com']);
  await assert.rejects(shell.openTarget('/root/apex-deck', null, true), /can't reveal it/);
  await assert.rejects(shell.exportPdf('thread.pdf', '<p>hi</p>'), /can't make a PDF/);
  await assert.rejects(shell.copyAttachment('room', '/tmp/a.txt'), /doesn't copy paths/);
});

test('a WebSocket link delivers one frame per message and fails once if it never opens', async () => {
  const sockets = [];
  const connect = webSocketConnect('ws://mac.local:7420', () => {
    const listeners = { open: [], message: [], error: [], close: [] };
    const socket = {
      sent: [],
      send(data) { this.sent.push(data); },
      close() { listeners.close.forEach((cb) => cb({})); },
      addEventListener(type, cb) { listeners[type].push(cb); },
      open() { listeners.open.forEach((cb) => cb({})); },
      message(data) { listeners.message.forEach((cb) => cb({ data })); },
    };
    sockets.push(socket);
    return socket;
  });
  const opening = connect();
  sockets[0].open();
  const lines = [];
  const link = await opening;
  link.onLine((line) => lines.push(line));
  sockets[0].message('{"ok":true}');
  link.send('{"cmd":"hello"}');
  assert.deepEqual(lines, ['{"ok":true}']);
  assert.deepEqual(sockets[0].sent, ['{"cmd":"hello"}']);
  const refused = connect();
  sockets[1].close();
  await assert.rejects(refused, /lost/);
  sockets[1].close();
});

test('hello on a phone link carries the daemon token, and the host is not named This Mac', async () => {
  let sent = [];
  let line = () => {};
  const connect = async () => ({
    send(text) { sent.push(JSON.parse(text)); },
    close() {},
    onLine(cb) { line = cb; },
    onClose() {},
  });
  const host = openPhoneHost(hetzner, connect, phoneShell({ machineName: hetzner.name }));
  const started = host.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent[0].cmd, 'hello');
  assert.equal(sent[0].args.token, 'server-token');
  assert.equal(sent[0].args.protocol, 1);
  line(JSON.stringify({ id: sent[0].id, ok: { host_id: 'hetzner', boot_id: 'b', protocol: 1, last_seq: 0, resumed: false } }));
  await started;
  assert.equal(host.backend.host.name, 'Hetzner-EU');
  assert.equal(host.connection.get().status.kind, 'connected');
  host.close();
});

test('a desktop hello without a token stays unchanged', async () => {
  let sent = [];
  const client = new DaemonClient(async () => ({
    send(text) { sent.push(JSON.parse(text)); },
    close() {},
    onLine() {},
    onClose() {},
  }));
  client.start().catch(() => {});
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(sent[0].args, { protocol: 1 });
  client.close();
});

test('a machine that refuses the token says so instead of looking offline', () => {
  const words = refusalLine("Tyler's MacBook", 'wrong or missing token');
  assert.match(words, /token is wrong/);
  assert.match(words, /Unpair Tyler's MacBook and pair it again/);
  assert.doesNotMatch(words, /Paused|reconnects|wakes/);
  const refused = { id: 'local', name: "Tyler's MacBook", kind: 'mac', status: 'offline', problem: words };
  assert.equal(downLine(refused), words);
  assert.equal(threadSend([refused], 'local', 'hi').reason, words);
  assert.equal(newThreadGate(refused, refused).reason, words);
  assert.equal(downLine({ ...refused, problem: undefined }), "Paused until Tyler's MacBook wakes");
  assert.equal(refusalLine('Apex-Terminal', 'this daemon speaks protocol 3, not 2.'), 'Apex-Terminal turned this phone away: this daemon speaks protocol 3, not 2.');
});
