import test from 'node:test';
import assert from 'node:assert/strict';
import {
  botNames, chatRows, chatTitle, emptyCatalog, findRoom, legacyChats, legacyEntries, newChatStart, parseChatList,
  parseChatProfiles, promotedWork, readCatalog, rememberLast, withHostRooms, withoutHosts, withRoom,
} from '../src/phone/chatCatalog.ts';

const bot = (id, name = id) => ({ id, display_name: name, backend: { kind: 'agent', tool: 'claude_code', model: null }, persona: '', access: 'read', effort: null });
const room = (id, extra = {}) => ({ id, kind: 'chat', title: id, participants: [bot('jigga', 'Jigga'), bot('null', 'Null')], updatedAt: 10, archived: false, cwd: null, folderName: null, promotedFrom: null, promotedTo: null, movedTo: null, profiles: { jigga: 'claude' }, ...extra });

test('each machine lists its own chats and the phone merges them newest first', () => {
  let catalog = emptyCatalog();
  catalog = withHostRooms(catalog, 'mac', 'Studio MacBook', parseChatList('mac', { rooms: [room('a', { updatedAt: 5 }), room('b', { updatedAt: 30 })] }));
  catalog = withHostRooms(catalog, 'vps', 'Apex-Terminal', parseChatList('vps', { rooms: [room('c', { updatedAt: 20 })] }));
  const { rows } = chatRows(catalog, false);
  assert.deepEqual(rows.map((row) => `${row.hostId}/${row.id}`), ['mac/b', 'vps/c', 'mac/a']);
  assert.equal(botNames(rows[0]), 'Jigga · Null');
});

test('a fresh list from one machine replaces only that machine', () => {
  let catalog = withHostRooms(emptyCatalog(), 'mac', 'Mac', parseChatList('mac', { rooms: [room('a')] }));
  catalog = withHostRooms(catalog, 'vps', 'VPS', parseChatList('vps', { rooms: [room('c')] }));
  catalog = withHostRooms(catalog, 'mac', 'Mac', []);
  assert.deepEqual(chatRows(catalog, false).rows.map((row) => row.id), ['c']);
});

test('archived chats stay in the one list, counted, and show when asked', () => {
  const catalog = withHostRooms(emptyCatalog(), 'mac', 'Mac', parseChatList('mac', { rooms: [room('a'), room('b', { archived: true })] }));
  assert.deepEqual(chatRows(catalog, false), { rows: [findRoom(catalog, 'mac', 'a')], archivedCount: 1 });
  assert.equal(chatRows(catalog, true).rows.length, 2);
});

test('a chat that moved is listed only by the machine it moved to', () => {
  const catalog = withHostRooms(withHostRooms(emptyCatalog(), 'mac', 'Mac', parseChatList('mac', { rooms: [room('a', { archived: true, movedTo: { host: 'vps', room: 'a2' } })] })),
    'vps', 'VPS', parseChatList('vps', { rooms: [room('a2')] }));
  assert.deepEqual(chatRows(catalog, true), { rows: [findRoom(catalog, 'vps', 'a2')], archivedCount: 0 });
});

test('Work threads made from chats are kept apart from chats, under their machine, with their folder', () => {
  const work = room('w', { kind: 'work', cwd: '/srv/denver', folderName: 'denver', promotedFrom: 'a' });
  const catalog = withHostRooms(emptyCatalog(), 'vps', 'VPS', parseChatList('vps', { rooms: [room('a', { promotedTo: 'w' }), work] }));
  assert.deepEqual(chatRows(catalog, false).rows.map((row) => row.id), ['a']);
  assert.deepEqual(promotedWork(catalog, 'vps').map((row) => [row.id, row.cwd, row.folderName]), [['w', '/srv/denver', 'denver']]);
  assert.deepEqual(promotedWork(catalog, 'mac'), []);
});

test('the merged list survives a restart, so chats show with the machine off', () => {
  const catalog = rememberLast(withRoom(emptyCatalog(), 'vps', 'Apex-Terminal', parseChatList('vps', { rooms: [room('a')] })[0]), 'vps', ['claude']);
  const back = readCatalog(JSON.stringify(catalog));
  assert.deepEqual(back, catalog);
  assert.deepEqual(readCatalog('not json'), emptyCatalog());
  assert.deepEqual(readCatalog(null), emptyCatalog());
});

test('rows the phone cannot read are left out and a broken list is refused', () => {
  assert.deepEqual(parseChatList('mac', { rooms: [{ id: 'x' }, room('a'), null] }).map((row) => row.id), ['a']);
  assert.throws(() => parseChatList('mac', { nope: true }), /can't read/);
});

test('unpairing a machine drops its chats and forgets it as the last machine', () => {
  const catalog = rememberLast(withHostRooms(withHostRooms(emptyCatalog(), 'mac', 'Mac', []), 'vps', 'VPS', []), 'vps', ['claude']);
  const next = withoutHosts(catalog, ['mac']);
  assert.deepEqual(Object.keys(next.hosts), ['mac']);
  assert.equal(next.last, null);
  assert.equal(withoutHosts(next, ['mac']), next);
});

test('New chat starts on the last machine with the last group that can still join', () => {
  const profiles = { vps: parseChatProfiles({ profiles: [
    { profile: bot('claude', 'Claude'), chatOk: true, reason: null },
    { profile: bot('codex', 'Codex'), chatOk: false, reason: 'Codex needs bubblewrap.' },
    { profile: bot('deepseek', 'DeepSeek'), chatOk: true, reason: null },
  ] }) };
  const catalog = rememberLast(emptyCatalog(), 'vps', ['codex', 'deepseek']);
  const machines = [{ id: 'mac', chats: true }, { id: 'vps', chats: true }];
  assert.deepEqual(newChatStart(catalog, machines, (id) => profiles[id]), { hostId: 'vps', picked: ['deepseek'] });
  // The last machine can't chat any more (older Deck): the first one that can.
  assert.deepEqual(newChatStart(catalog, [{ id: 'mac', chats: true }, { id: 'vps', chats: false }], () => []), { hostId: 'mac', picked: [] });
  assert.equal(newChatStart(catalog, [{ id: 'vps', chats: false }], () => []), null);
  assert.equal(profiles.vps[1].reason, 'Codex needs bubblewrap.');
});

test('a chat title comes from the first message', () => {
  assert.equal(chatTitle('  Plan the   Denver trip  '), 'Plan the Denver trip');
  assert.equal(chatTitle(''), 'New chat');
  assert.equal(chatTitle('x'.repeat(60)).length, 48);
});

test('old Local chat history is kept only when it holds a real reply', () => {
  const sessions = [
    { id: 'preview', title: 'Only previews', bots: ['Codex'], messages: [
      { id: '1', role: 'user', content: '@codex yo', time: '' },
      { id: '2', role: 'assistant', agent: 'Codex', content: 'Preview reply from Codex (gpt). Connect your host…', time: '' },
    ] },
    { id: 'real', title: 'Real', bots: ['Codex'], messages: [
      { id: '1', role: 'user', content: 'What is 17 × 23?', time: '' },
      { id: '2', role: 'assistant', agent: 'Codex', content: '391', time: '' },
      { id: '3', role: 'assistant', agent: 'Codex', content: 'Preview reply from Codex', time: '' },
      { id: '4', role: 'assistant', agent: 'Claude', content: 'half', time: '', streaming: true },
    ] },
  ];
  const kept = legacyChats(JSON.stringify(sessions));
  assert.deepEqual(kept.map((chat) => chat.id), ['real']);
  assert.deepEqual(legacyEntries(kept[0]), [
    { seq: 0, speaker: { kind: 'human' }, text: 'What is 17 × 23?' },
    { seq: 1, speaker: { kind: 'bot', id: 'codex' }, text: '391' },
  ]);
  assert.deepEqual(legacyChats('{"broken"'), []);
  assert.deepEqual(legacyChats(null), []);
});
