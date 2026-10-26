import test from 'node:test';
import assert from 'node:assert/strict';
import { ChatDeliveryController, JsonChatDeliveryStorage } from '../src/phone/chatDelivery.ts';
import { chatRows, emptyCatalog, findRoom, parseChatList, withHostRooms } from '../src/phone/chatCatalog.ts';
import {
  PROMOTES_KEY, chatOutboxRows, chatRights, chatRoute, freshChatId, projectChats, promoteKey, promoteRequest,
  readPromoteTickets, startingBots, writePromoteTickets,
} from '../src/phone/chatRoutes.ts';

const A = { id: 'studio', name: 'Studio MacBook' };
const B = { id: 'server', name: 'Apex-Terminal' };
const nullBot = { id: 'null', display_name: 'Null', backend: { kind: 'agent', tool: 'codex', model: null }, persona: '', access: 'read', effort: null };
const snapshot = (transcript = [], clientMessages = {}) => ({ kind: 'chat', participants: [nullBot], options: { policy: 'everyone', max_bot_hops: 0 }, transcript, clientMessages });
const human = (seq, text, extra = {}) => ({ seq, speaker: { kind: 'human' }, text, ...extra });

/** Two fake machines behind the real delivery controller, saved to one fake phone disk. */
function phone() {
  const disk = new Map();
  const local = { getItem: (key) => disk.get(key) ?? null, setItem: (key, value) => { disk.set(key, value); } };
  const storage = new JsonChatDeliveryStorage(local);
  const remote = new Map([['studio/r1', snapshot()]]);
  const imports = new Map();
  const offline = new Set();
  const calls = [];
  let next = 0;
  const key = (machine, room) => `${machine}/${room}`;
  const reach = (method, machine, extra) => { calls.push([method, machine, extra]); if (offline.has(machine)) throw Error(`Offline ${machine}`); };
  const rpc = {
    exportRoom: async (machine, room) => { reach('export', machine, room); return structuredClone(remote.get(key(machine, room))); },
    post: async (machine, room, message) => {
      reach('post', machine, room);
      const saved = remote.get(key(machine, room));
      saved.transcript.push(human(saved.transcript.length + 1, message.text, { clientMessageId: message.clientMessageId }));
      return { ...(saved.clientMessages[message.clientMessageId] = { state: 'running', replySeqs: [] }), clientMessageId: message.clientMessageId };
    },
    claim: async (machine, room, id) => { reach('claim', machine, room); return structuredClone(remote.get(key(machine, room)).clientMessages[id] ??= { state: 'fenced', replySeqs: [] }); },
    importRoom: async (machine, payload) => {
      reach('import', machine, payload.moveId);
      const moveKey = `${machine}/${payload.moveId}`;
      if (!imports.has(moveKey)) { imports.set(moveKey, payload.id); remote.set(key(machine, payload.id), { ...snapshot(payload.entries), importProfiles: { null: 'saved-null' } }); }
      return { id: imports.get(moveKey), room: structuredClone(remote.get(key(machine, imports.get(moveKey)))), skipped: [] };
    },
    mergeHistory: async (machine) => { reach('merge', machine); return { added: 0 }; },
    archive: async (machine, room) => { reach('archive', machine, room); remote.get(key(machine, room)).archived = true; },
    stop: async (machine) => { reach('stop', machine); },
  };
  const create = () => new ChatDeliveryController({ storage, rpc, id: () => `id-${++next}`, now: () => 100 });
  const controller = create();
  // The chat as Task 3 caches it: under the id chatRoute gives a room it hasn't seen.
  const chatId = chatRoute(controller.snapshot(), A.id, 'r1').chatId;
  controller.cacheChat({ id: chatId, title: 'Denver trip', machine: A, room: 'r1', profiles: { null: 'saved-null' }, snapshot: snapshot([human(1, 'hi')]) });
  return { controller, create, chatId, local, disk, remote, offline, calls, rpc };
}
const listed = (hostId, rooms) => parseChatList(hostId, { rooms });
const chatRow = (id, extra = {}) => ({ id, kind: 'chat', title: 'Denver trip', participants: [nullBot], updatedAt: 50, archived: false, profiles: { null: 'saved-null' }, ...extra });

test('a move from an offline machine follows the chat: old row drops out, new home shows, Send goes where the screen says', async () => {
  const h = phone();
  h.offline.add(A.id);
  await h.controller.move(h.chatId, B);
  const state = h.controller.snapshot();
  // A never answered, so its own list still has the chat with no movedTo.
  const catalog = withHostRooms(emptyCatalog(), A.id, A.name, listed(A.id, [chatRow('r1')]));
  const route = chatRoute(state, A.id, 'r1');
  assert.equal(route.moved, true);
  assert.equal(route.chatId, h.chatId);
  assert.equal(route.hostId, B.id);
  const shown = projectChats(catalog, state);
  const rows = chatRows(shown, false).rows;
  assert.deepEqual(rows.map((row) => `${row.hostId}/${row.id}`), [`${B.id}/${route.room}`]);
  assert.equal(rows[0].title, 'Denver trip');
  assert.deepEqual(rows[0].bots, [{ id: 'null', name: 'Null' }]);
  // The new home's row resolves to the same outbox, and a send there goes to B, never A.
  assert.deepEqual(chatRoute(state, B.id, route.room), { chatId: h.chatId, hostId: B.id, room: route.room, moved: false });
  const sent = h.controller.enqueue(h.chatId, 'from the new home');
  await h.controller.send(h.chatId, sent);
  assert.deepEqual(h.calls.filter((call) => call[0] === 'post').map((call) => call[1]), [B.id]);
});

test('a lost import answer, then a relaunch whose recovery finishes the move, still lands the chat on B', async () => {
  const h = phone();
  const actual = h.rpc.importRoom;
  h.rpc.importRoom = async (...args) => { await actual(...args); throw Error('Import ack lost'); };
  await assert.rejects(h.controller.move(h.chatId, B), /Import ack lost/);
  // Before recovery the chat is still A's: nothing is redirected yet.
  assert.equal(chatRoute(h.controller.snapshot(), A.id, 'r1').moved, false);
  h.rpc.importRoom = actual;
  let changes = 0;
  const watched = new ChatDeliveryController({ storage: new JsonChatDeliveryStorage(h.local), rpc: h.rpc, id: () => `again-${++changes}`, onChange: () => { changes += 1; } });
  await watched.resume();
  assert.ok(changes > 0, 'recovery reports the change, which re-renders the open chat');
  const route = chatRoute(watched.snapshot(), A.id, 'r1');
  assert.equal(route.moved, true);
  assert.equal(route.hostId, B.id);
  const catalog = withHostRooms(emptyCatalog(), A.id, A.name, listed(A.id, [chatRow('r1')]));
  assert.deepEqual(chatRows(projectChats(catalog, watched.snapshot()), false).rows.map((row) => row.hostId), [B.id]);
});

test('after a relaunch with the machine off, the kept copy holds the transcript and bots for the open chat', () => {
  const h = phone();
  const later = h.create();
  const route = chatRoute(later.snapshot(), A.id, 'r1');
  const kept = later.snapshot().chats[route.chatId];
  assert.equal(kept.machine.id, A.id);
  assert.deepEqual(kept.snapshot.transcript.map((message) => message.text), ['hi']);
  assert.deepEqual(kept.snapshot.participants.map((bot) => bot.id), ['null']);
});

test('two machines with a room of the same name never share an outbox', () => {
  const h = phone();
  const state = h.controller.snapshot();
  assert.equal(chatRoute(state, A.id, 'r1').chatId, h.chatId);
  assert.equal(chatRoute(state, B.id, 'r1').chatId, freshChatId(B.id, 'r1'));
  assert.notEqual(freshChatId(A.id, 'shared'), freshChatId(B.id, 'shared'));
});

test('the projection leaves a chat that never moved exactly as its machine listed it', () => {
  const h = phone();
  const catalog = withHostRooms(emptyCatalog(), A.id, A.name, listed(A.id, [chatRow('r1')]));
  assert.equal(projectChats(catalog, h.controller.snapshot()), catalog);
});

const pending = (extra) => ({ chats: { c: { id: 'c', title: 'T', machine: B, room: 'b1', snapshot: snapshot(), outbox: [{ id: 'm1', text: 'Hi', targets: [], replySeqs: [], createdAt: 1, ...extra }] } }, moves: {}, version: 1 }).chats.c;
const view = (extra = {}) => ({ hostId: B.id, room: 'b1', online: true, shown: new Set(), confirming: null, sendWhy: '', ...extra });

test('a message already copied into the chat keeps its Send here anyway line while its answer is stuck on the old machine', () => {
  const chat = pending({ machine: A, room: 'r1', state: 'delivered', accepted: 'running' });
  const rows = chatOutboxRows(chat, view({ shown: new Set(['m1']) }));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].line, 'Answer pending on Studio MacBook');
  assert.equal(rows[0].canSendAnyway, true);
});

test('an uncertain message that also shows in the chat keeps its recovery line once it is stuck elsewhere', () => {
  const chat = pending({ machine: A, room: 'r1', state: 'uncertain' });
  assert.equal(chatOutboxRows(chat, view({ shown: new Set(['m1']) }))[0].canSendAnyway, true);
});

test('a stopped answer keeps Retry even when its message shows; a delivered one on this machine shows nothing', () => {
  assert.equal(chatOutboxRows(pending({ machine: B, room: 'b1', state: 'delivered', accepted: 'interrupted' }), view({ shown: new Set(['m1']) }))[0].canRetry, true);
  assert.deepEqual(chatOutboxRows(pending({ machine: B, room: 'b1', state: 'delivered', accepted: 'done' }), view()), []);
  assert.deepEqual(chatOutboxRows(pending({ machine: B, room: 'b1', state: 'uncertain' }), view({ shown: new Set(['m1']) })), []);
});

test('a queued message on a connected machine that lacks chat delivery says why instead of Waiting', () => {
  const rows = chatOutboxRows(pending({ machine: B, room: 'b1', state: 'unsent' }), view({ sendWhy: 'Update Deck on Apex-Terminal to chat here.' }));
  assert.equal(rows[0].line, 'Update Deck on Apex-Terminal to chat here.');
});

test('chat rights: listing is open to every level; sending needs both capabilities; starting needs every thread', () => {
  const base = { name: 'Apex-Terminal', online: true, rooms: true, delivery: true };
  assert.deepEqual(chatRights({ ...base, access: { tier: 'full', threads: 'all' } }), { list: true, post: true, create: true, why: '', postWhy: '' });
  const roomsOnly = chatRights({ ...base, delivery: false, access: { tier: 'full', threads: 'all' } });
  assert.equal(roomsOnly.list, true);
  assert.equal(roomsOnly.post, false);
  assert.equal(roomsOnly.create, false);
  assert.match(roomsOnly.why, /Update Deck on Apex-Terminal/);
  const reader = chatRights({ ...base, access: { tier: 'read_only', threads: 'all' } });
  assert.deepEqual([reader.list, reader.post, reader.create], [true, false, false]);
  const scoped = chatRights({ ...base, access: { tier: 'chat', threads: ['c1'] } });
  assert.deepEqual([scoped.list, scoped.post, scoped.create], [true, true, false]);
  assert.match(scoped.why, /only sees some threads/);
  const away = chatRights({ ...base, online: false, rooms: false, delivery: false, access: null });
  assert.deepEqual([away.list, away.post], [false, false]);
  assert.match(away.postWhy, /Waiting for Apex-Terminal/);
});

test('New chat starts with the saved group once the machine list arrives, else the first bot that can join', () => {
  const list = [{ profile: { id: 'claude' }, ok: true }, { profile: { id: 'codex' }, ok: false }, { profile: { id: 'deepseek' }, ok: true }];
  assert.deepEqual(startingBots(list, ['deepseek', 'codex']), ['deepseek']);
  assert.deepEqual(startingBots(list, []), ['claude']);
  assert.deepEqual(startingBots([], ['claude']), []);
});

function disk({ failWrites = false, lieOnRead = false } = {}) {
  const map = new Map();
  return { map, getItem: (key) => lieOnRead ? '{}' : map.get(key) ?? null, setItem: (key, value) => { if (failWrites) throw Error('QuotaExceededError'); map.set(key, value); } };
}

test('a move to a Work thread whose answer was lost is only resent exactly as it was asked', () => {
  const local = disk();
  const key = promoteKey(A.id, 'r1');
  let made = 0;
  const fresh = () => ({ target: `pane-${++made}`, requestId: `req-${made}` });
  const first = promoteRequest(undefined, '/srv/denver', { null: 'full' }, fresh);
  assert.equal(first.fresh, true);
  writePromoteTickets(local, { [key]: first.ticket });
  // Relaunch: the sheet would start on Ask; the saved Full move must not be resent as Ask.
  const saved = readPromoteTickets(local)[key];
  assert.deepEqual(saved, { target: 'pane-1', requestId: 'req-1', cwd: '/srv/denver', access: { null: 'full' } });
  assert.throws(() => promoteRequest(saved, '/srv/denver', { null: 'ask' }, fresh), /started and not confirmed/);
  assert.throws(() => promoteRequest(saved, '/srv/other', { null: 'full' }, fresh), /started and not confirmed/);
  const again = promoteRequest(saved, '/srv/denver', { null: 'full' }, fresh);
  assert.deepEqual([again.fresh, again.ticket.requestId, made], [false, 'req-1', 1]);
});

test('a move that cannot be saved on the phone is refused before anything is sent', () => {
  assert.throws(() => writePromoteTickets(disk({ failWrites: true }), { k: { target: 't', requestId: 'r', cwd: '/x', access: {} } }), /nothing was sent/);
  assert.throws(() => writePromoteTickets(disk({ lieOnRead: true }), { k: { target: 't', requestId: 'r', cwd: '/x', access: {} } }), /nothing was sent/);
});

test('saved moves that are malformed are ignored rather than resent', () => {
  const local = disk();
  local.setItem(PROMOTES_KEY, JSON.stringify({ a: { target: 't', requestId: 'r', cwd: '/x', access: { null: 'root' } }, b: { target: 't' }, c: 'nope' }));
  assert.deepEqual(readPromoteTickets(local), {});
  local.setItem(PROMOTES_KEY, 'not json');
  assert.deepEqual(readPromoteTickets(local), {});
});

test('a promoted Work thread is found on its machine for its menu', () => {
  const catalog = withHostRooms(emptyCatalog(), B.id, B.name, listed(B.id, [chatRow('c1', { promotedTo: 'w1' }), { id: 'w1', kind: 'work', title: 'Denver', participants: [nullBot], cwd: '/srv/denver', folderName: 'denver', promotedFrom: 'c1' }]));
  const work = findRoom(catalog, B.id, 'w1');
  assert.equal(work.kind, 'work');
  assert.equal(work.promotedFrom, 'c1');
});
