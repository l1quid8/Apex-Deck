import test from 'node:test';
import assert from 'node:assert/strict';
import { DaemonClient } from '../src/daemon/client.ts';
import { webSocketConnect } from '../src/daemon/webSocketLink.ts';
import { openPhoneHost } from '../src/phoneBackend.ts';
import {
  addMachine, approvalWhere, draftVisible, forkLine, loadMachines, newThreadGate,
  botMeters, crewOpen, modelChoices, pillDrag, pillMeter, settingsLine, toolLine, toolRows, toolSearch, toolWords, withPhoneChange, downLine, mentionPicks, pauseLine, pickMention, postRouted, pressNewThread, refusalLine, tagFromBar, threadSend, threadTitleFromMessage,
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

test('the phone lets the room pick who answers, so @names and the last @name both work', async () => {
  const calls = [];
  const backend = {
    roomTargets: async (id, text) => { calls.push(['targets', id, text]); return text.includes('@null') ? ['null'] : ['jigga']; },
    roomPostTo: async (id, text, targets, routed) => { calls.push(['post', id, text, targets, routed]); },
  };
  assert.deepEqual(await postRouted(backend, 'pane-1', '@null look at this'), ['null']);
  assert.deepEqual(await postRouted(backend, 'pane-1', 'and again'), ['jigga']);
  assert.deepEqual(calls, [
    ['targets', 'pane-1', '@null look at this'], ['post', 'pane-1', '@null look at this', ['null'], true],
    ['targets', 'pane-1', 'and again'], ['post', 'pane-1', 'and again', ['jigga'], true],
  ]);
});

test('typing @ offers the bots in the thread, and picking one fills in its @name', () => {
  const people = [{ id: 'null', display_name: 'Null' }, { id: 'jigga', display_name: 'Jigga' }, { id: 'gronk', display_name: 'Gronk' }];
  assert.equal(mentionPicks('hello', 5, people), null);
  assert.equal(mentionPicks('mail me@nu', 10, people), null);
  assert.deepEqual(mentionPicks('@', 1, people).picks.map((pick) => pick.id), ['all', 'null', 'jigga', 'gronk']);
  const typed = mentionPicks('ask @ji', 7, people);
  assert.deepEqual(typed.picks.map((pick) => pick.id), ['jigga']);
  assert.deepEqual(pickMention('ask @ji', 7, typed.trigger, 'jigga'), { text: 'ask @jigga ', caret: 11 });
  // By name too, and in the middle of what was typed.
  const middle = mentionPicks('@Gr please check', 3, people);
  assert.deepEqual(middle.picks.map((pick) => pick.id), ['gronk']);
  assert.deepEqual(pickMention('@Gr please check', 3, middle.trigger, 'gronk'), { text: '@gronk please check', caret: 7 });
  // From the + sheet, with nothing being typed: added at the end.
  assert.deepEqual(pickMention('look at this', 12, null, 'null'), { text: 'look at this @null ', caret: 19 });
});

test('tapping a bot in the bar tags it in front of the draft, once', () => {
  assert.equal(tagFromBar('', 'jigga'), '@jigga ');
  assert.equal(tagFromBar('  fix the typo', 'jigga'), '@jigga fix the typo');
  assert.equal(tagFromBar('@jigga fix it', 'jigga'), '@jigga fix it');
  assert.equal(tagFromBar('ask @Jigga too', 'jigga'), 'ask @Jigga too');
  // @jiggabot is someone else, so Jigga still gets tagged.
  assert.equal(tagFromBar('@jiggabot hi', 'jigga'), '@jigga @jiggabot hi');
});

test('the bot bar hides while the keyboard is up and comes back as it was chosen', () => {
  assert.equal(crewOpen(false, false), true);
  assert.equal(crewOpen(false, true), false);
  assert.equal(crewOpen(true, false), false);
  assert.equal(crewOpen(true, true), false);
});

test('a held bot shows context and each plan window as bars, with "—" until a figure arrives', () => {
  const now = new Date('2026-10-06T12:00:00Z');
  const at = now.getTime() / 1000;
  const empty = botMeters('claude_code', undefined, undefined, now);
  assert.deepEqual(empty.map((row) => [row.label, row.left, row.value, row.detail]), [
    ['Context', null, '—', 'Shows after its next reply'],
    ['Plan', null, '—', 'Shows after its next reply'],
  ]);
  const windows = [
    { name: 'seven_day', used_percent: 19, window_minutes: 10_080, resets_at: at + 3 * 86_400 + 4 * 3600 },
    { name: 'five_hour', used_percent: 85, window_minutes: 300, resets_at: at + 2 * 3600 + 14 * 60 },
    { name: 'old', used_percent: 99, window_minutes: 60, resets_at: at - 10 },
  ];
  const full = botMeters('claude_code', { used: 190_000, window: 200_000 }, windows, now);
  assert.deepEqual(full.map((row) => [row.label, row.value, row.detail, row.low]), [
    ['Context', '5%', '10k of 200k tokens left', true],
    ['5-hour', '15%', 'Resets in 2h14m', true],
    ['Weekly', '81%', 'Resets in 3d4h', false],
  ]);
  const scripted = botMeters(null, undefined, undefined, now);
  assert.deepEqual(scripted.map((row) => row.detail), ['Not reported by this provider', 'Not reported by this provider']);
  assert.equal(botMeters('grok', undefined, undefined, now)[0].detail, 'Not reported by this provider');
  assert.deepEqual(pillMeter('claude_code', { used: 50_000, window: 200_000 }, windows, now), { context: 0.75, low: false, planLow: true });
  assert.deepEqual(pillMeter(null, undefined, undefined, now), { context: null, low: false, planLow: false });
});

test('a bot\'s model and reasoning read in a few words, and the phone only writes what it changed', () => {
  const claude = { id: 'null', display_name: 'Null', backend: { kind: 'agent', tool: 'claude_code', model: 'opus' }, effort: 'high' };
  assert.equal(settingsLine(claude, []), 'Latest Opus · High reasoning');
  assert.equal(settingsLine({ ...claude, backend: { ...claude.backend, model: null }, effort: null }, []), 'Default model · Default reasoning');
  assert.equal(settingsLine({ ...claude, backend: { ...claude.backend, model: 'haiku' } }, []), 'Latest Haiku');
  assert.equal(settingsLine({ ...claude, backend: { kind: 'agent', tool: 'gemini', model: null }, effort: null }, []), 'Default model');
  const { shown, extra } = modelChoices('claude_code', []);
  assert.deepEqual(shown.map((m) => m.id), ['opus', 'sonnet', 'haiku', 'fable']);
  assert.ok(extra.length > 0);
  // The Mac changed reasoning to Max after the phone opened the sheet; the phone's model change keeps it.
  const onMac = { ...claude, effort: 'max' };
  assert.deepEqual(withPhoneChange(onMac, { model: 'sonnet' }, []), { ...onMac, backend: { ...claude.backend, model: 'sonnet' }, effort: 'max' });
  // A model without reasoning drops it back to Default; Default model is saved as null.
  assert.equal(withPhoneChange(claude, { model: 'haiku' }, []).effort, null);
  assert.equal(withPhoneChange(claude, { model: '' }, []).backend.model, null);
  assert.equal(withPhoneChange(claude, { effort: '' }, []).effort, null);
  assert.equal(withPhoneChange(claude, { effort: 'ultra' }, []).effort, null);
});

test('tool names drop the plugin, claude.ai and mcp__ prefixes but keep the command', () => {
  assert.deepEqual(toolWords('plugin:design:google calendar'), { name: 'Google Calendar', source: 'design plugin' });
  assert.deepEqual(toolWords('plugin:engineering:linear'), { name: 'Linear', source: 'engineering plugin' });
  assert.deepEqual(toolWords('claude.ai Google Drive'), { name: 'Google Drive', source: 'claude.ai' });
  assert.deepEqual(toolWords('claude_ai_Hyper_MCP'), { name: 'Hyper MCP', source: 'claude.ai' });
  assert.deepEqual(toolWords('github'), { name: 'GitHub', source: null });
  assert.deepEqual(toolWords('slack'), { name: 'Slack', source: null });
  assert.equal(toolLine('Hyper_MCP: place_order'), 'Hyper MCP: place order');
  assert.equal(toolLine('Using mcp__claude_ai_Google_Drive__search_files'), 'Using Google Drive: search files');
  assert.equal(toolLine('Using claude_ai_Vercel list_projects'), 'Using Vercel: list projects');
  assert.equal(toolLine('Reading src/notes.txt'), 'Reading src/notes.txt');
  const rows = toolRows([
    { token: 'plugin:operations:slack', label: 'plugin:operations:slack', aliases: [] },
    { token: 'claude.ai Slack', label: 'claude.ai Slack', aliases: [] },
    { token: 'plugin:design:google calendar', label: 'plugin:design:google calendar', aliases: [] },
  ]);
  assert.deepEqual(rows.map((row) => [row.name, row.source, row.token]), [
    ['Google Calendar', null, 'plugin:design:google calendar'],
    ['Slack', 'claude.ai', 'claude.ai Slack'],
    ['Slack', 'operations plugin', 'plugin:operations:slack'],
  ]);
  assert.deepEqual(toolWords('claude.ai-hyper-mcp'), { name: 'Hyper MCP', source: 'claude.ai' });
  assert.equal(toolWords('swift-lsp').name, 'Swift LSP');
  const apps = toolRows([{ token: 'adobe', label: 'Adobe', aliases: [] }, { token: 'app-6931', label: 'Adobe', aliases: [] }]);
  assert.deepEqual(apps.map((row) => row.source), [null, 'connector']);
  assert.deepEqual(toolSearch(rows, 'slack plugin').map((row) => row.token), ['plugin:operations:slack']);
  assert.deepEqual(toolSearch(rows, 'cal').map((row) => row.name), ['Google Calendar']);
});

test('a bot pill opens its details on a short downward drag, and sideways still scrolls the bar', () => {
  assert.equal(pillDrag(0, 4), 'wait');
  assert.equal(pillDrag(3, 30), 'open');
  assert.equal(pillDrag(14, 6), 'scroll');
  assert.equal(pillDrag(0, -20), 'scroll');
  assert.equal(pillDrag(20, 32), 'wait');
  assert.equal(pillDrag(30, 32), 'scroll');
});
