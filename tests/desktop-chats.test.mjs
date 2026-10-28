import test from 'node:test';
import assert from 'node:assert/strict';
import { abandonPromote, botPatch, chatKey, deliveryId, readOpenChat, restoredChat, saveOpenChat, sendBlock, sendPromote, workThreadPlace, DESKTOP_CHAT_DELIVERY_KEY } from '../src/desktopChats.ts';
import { DESKTOP_PROMOTES_KEY, PROMOTES_KEY, promoteHolds, promoteKey, readPromoteTickets, settleForPromote } from '../src/chatPromote.ts';
import { chatRows, emptyCatalog, findRoom, parseChatList, withListedRooms } from '../src/chatCatalog.ts';
import { ChatDeliveryController, JsonChatDeliveryStorage } from '../src/chatDelivery.ts';

const memory = () => { const data = new Map(); return { getItem: k => data.has(k) ? data.get(k) : null, setItem: (k, v) => data.set(k, String(v)), removeItem: k => data.delete(k), data }; };
const listed = (catalog, hostId, rooms, at = 1) => withListedRooms(catalog, hostId, hostId, parseChatList(hostId, { rooms }), at);
const chat = (id, extra = {}) => ({ id, kind: 'chat', title: id, participants: [{ id: 'jigga', display_name: 'Jigga' }], updatedAt: 1, ...extra });
const bot = (backend, extra = {}) => ({ id: 'jigga', display_name: 'Jigga', persona: '', access: 'read', effort: null, backend, ...extra });

test('two machines with the same room id stay two chats, with two outboxes', () => {
  let catalog = listed(emptyCatalog(), 'local', [chat('shared')]);
  catalog = listed(catalog, 'vps', [chat('shared')]);
  const rows = chatRows(catalog, false).rows;
  assert.equal(rows.length, 2);
  assert.notEqual(chatKey({ hostId: 'local', room: 'shared' }), chatKey({ hostId: 'vps', room: 'shared' }));
  assert.notEqual(deliveryId({ hostId: 'local', room: 'shared' }), deliveryId({ hostId: 'vps', room: 'shared' }));
});

test('a chat moved to a Work thread stays listed with its link; one the phone carried elsewhere is hidden', () => {
  const catalog = listed(emptyCatalog(), 'local', [
    chat('promoted', { promotedTo: 'pane-work' }),
    chat('carried', { movedTo: { host: 'vps', room: 'chat-2' } }),
    chat('put-away', { archived: true }),
    { id: 'pane-work', kind: 'work', title: 'Work', participants: [], cwd: '/repo', promotedFrom: 'promoted' },
  ]);
  const all = chatRows(catalog, true).rows.map(row => row.id).sort();
  assert.deepEqual(all, ['promoted', 'put-away']);
  assert.equal(chatRows(catalog, true).rows.find(row => row.id === 'promoted').promotedTo, 'pane-work');
  assert.deepEqual(chatRows(catalog, false).rows.map(row => row.id), ['promoted']);
  assert.match(sendBlock(chatRows(catalog, false).rows[0], { id: 'local', name: 'This Mac' }, true), /moved to a Work thread/);
});

test('a restored open chat waits for its machine, stays if listed, and is dropped if gone or moved', () => {
  const place = { hostId: 'vps', room: 'chat-1' };
  assert.equal(restoredChat(emptyCatalog(), place), 'unknown');
  assert.equal(restoredChat(listed(emptyCatalog(), 'vps', [chat('chat-1')]), place), 'keep');
  assert.equal(restoredChat(listed(emptyCatalog(), 'vps', []), place), 'drop');
  assert.equal(restoredChat(listed(emptyCatalog(), 'vps', [chat('chat-1', { movedTo: { host: 'local', room: 'x' } })]), place), 'drop');
  // The same room id on another machine is not this chat.
  assert.equal(restoredChat(listed(emptyCatalog(), 'local', [chat('chat-1')]), place), 'unknown');
  const storage = memory();
  saveOpenChat(storage, place);
  assert.deepEqual(readOpenChat(storage), place);
  saveOpenChat(storage, null);
  assert.equal(readOpenChat(storage), null);
  storage.setItem('apex-deck.desktop-open-chat', '{"hostId":1}');
  assert.equal(readOpenChat(storage), null);
});

test('a bot edit sends only what changed: model, reasoning or Speed, never a whole config', () => {
  const saved = bot({ kind: 'agent', tool: 'claude_code', model: 'opus' }, { effort: 'high', speed: null });
  assert.deepEqual(botPatch(saved, { model: 'opus', effort: 'high', speed: null }), {});
  assert.deepEqual(botPatch(saved, { model: 'sonnet' }), { model: 'sonnet' });
  assert.deepEqual(botPatch(saved, { effort: null }), { effort: null });
  assert.deepEqual(botPatch(saved, { speed: 'fast' }), { speed: 'fast' });
  const patch = botPatch(saved, { model: '', effort: 'low', speed: 'standard' });
  assert.deepEqual(Object.keys(patch).sort(), ['effort', 'model', 'speed']);
  assert.equal(patch.model, null);
  assert.equal(sendBlock({ promotedTo: null }, { id: 'old', name: 'Old box' }, false), 'Update Deck on Old box to chat here.');
  assert.equal(sendBlock({ promotedTo: null }, { id: 'vps', name: 'VPS' }, undefined), null);
});

test('the desktop outbox saves a message before sending, and after a relaunch asks about an uncertain one by the same id instead of posting it twice', async () => {
  const storage = memory();
  const posts = [];
  let fail = true;
  const rpc = {
    async post(machine, room, message) {
      posts.push({ machine, room, ...message });
      if (fail) { fail = false; throw new Error('link dropped'); }
      return { state: 'running', replySeqs: [], clientMessageId: message.clientMessageId };
    },
    async claim(_m, _r, id) { return { state: 'running', replySeqs: [], clientMessageId: id }; },
    async exportRoom() { return { kind: 'chat', participants: [], options: { policy: 'everyone', max_bot_hops: 3 }, transcript: [] }; },
  };
  const make = () => new ChatDeliveryController({ storage: new JsonChatDeliveryStorage(storage, { key: DESKTOP_CHAT_DELIVERY_KEY }), rpc });
  const id = deliveryId({ hostId: 'local', room: 'chat-1' });
  const first = make();
  first.cacheChat({ id, title: 'Hi', machine: { id: 'local', name: 'This Mac' }, room: 'chat-1', profiles: {}, snapshot: { kind: 'chat', participants: [], options: { policy: 'everyone', max_bot_hops: 3 }, transcript: [] } });
  const messageId = first.enqueue(id, 'hello', []);
  assert.ok(storage.data.get(DESKTOP_CHAT_DELIVERY_KEY).includes(messageId), 'saved before any send');
  assert.ok(!storage.data.has('apex.phone.chat-delivery.v1'), 'never the phone\'s outbox');
  await assert.rejects(first.send(id, messageId), /link dropped/);
  assert.equal(first.snapshot().chats[id].outbox[0].state, 'uncertain');
  // After a relaunch, recovery asks about the same id instead of posting a second copy.
  const second = make();
  await second.resume();
  assert.equal(posts.length, 1);
  assert.equal(second.snapshot().chats[id].outbox[0].id, messageId);
  assert.equal(second.snapshot().chats[id].outbox[0].state, 'delivered');
});

test('a draft belongs to its machine and room, so switching chats keeps each one', () => {
  const drafts = {};
  drafts[chatKey({ hostId: 'local', room: 'a' })] = 'half a thought';
  drafts[chatKey({ hostId: 'vps', room: 'a' })] = 'other machine';
  assert.equal(drafts[chatKey({ hostId: 'local', room: 'a' })], 'half a thought');
  assert.equal(drafts[chatKey({ hostId: 'vps', room: 'a' })], 'other machine');
});

test('Open Work thread finds the pane on the chat\'s machine, or adds the project and thread a phone made', () => {
  let catalog = listed(emptyCatalog(), 'vps', [chat('c1', { promotedTo: 'w1' }), { id: 'w1', kind: 'work', title: 'Trip plan', cwd: '/srv/trip', folderName: 'trip', participants: [], updatedAt: 2 }]);
  const work = findRoom(catalog, 'vps', 'w1');
  let n = 0; const makeId = () => `ws${++n}`; const nameOf = p => p.split('/').at(-1);

  const added = workThreadPlace([], [], 'vps', work, makeId, nameOf);
  assert.equal(added.added, true);
  assert.deepEqual(added.workspaces, [{ id: 'ws1', name: 'trip', path: '/srv/trip', hostId: 'vps', family: added.workspaces[0].family }]);
  assert.deepEqual(added.pane, { id: 'w1', workspaceId: 'ws1', kind: 'chat', title: 'Trip plan' });

  // Already open on that machine: focus it, add nothing.
  const again = workThreadPlace(added.workspaces, [added.pane], 'vps', work, makeId, nameOf);
  assert.equal(again.added, false);
  assert.equal(again.pane, added.pane);

  // The project is open but not the thread: reuse the project.
  const reuse = workThreadPlace(added.workspaces, [], 'vps', work, makeId, nameOf);
  assert.equal(reuse.pane.workspaceId, 'ws1');
  assert.equal(reuse.workspaces.length, 1);

  // The same folder path on This Mac is a different project.
  const local = [{ id: 'mine', name: 'trip', path: '/srv/trip' }];
  const other = workThreadPlace(local, [], 'vps', work, makeId, nameOf);
  assert.notEqual(other.pane.workspaceId, 'mine');

  // The same room id open from another machine can't show beside it.
  assert.equal(workThreadPlace(local, [{ id: 'w1', workspaceId: 'mine', kind: 'chat', title: 'x' }], 'vps', work, makeId, nameOf), 'clash');
  // A project inside its Remove/Undo window comes back, whether its thread pane is still kept or not.
  const removed = added.workspaces.map(w => ({ ...w, hidden: true }));
  const kept = workThreadPlace(removed, [{ ...added.pane, closed: true }], 'vps', work, makeId, nameOf);
  assert.equal(kept.added, false);
  assert.equal(kept.restored, 'ws1');
  assert.equal(kept.workspaces[0].hidden, false);
  const readded = workThreadPlace(removed, [], 'vps', work, makeId, nameOf);
  assert.equal(readded.restored, 'ws1');
  assert.equal(readded.pane.workspaceId, 'ws1');
  assert.equal(readded.workspaces[0].hidden, false);
  assert.equal(again.restored, null);
  assert.equal(other.restored, null);

  // Not listed yet, or not a Work thread.
  assert.equal(workThreadPlace([], [], 'vps', null, makeId, nameOf), 'unlisted');
  assert.equal(workThreadPlace([], [], 'vps', findRoom(catalog, 'vps', 'c1'), makeId, nameOf), 'unlisted');
});

test('Move to a Work thread is saved before it is sent, resent unchanged after a lost answer, and forgotten once confirmed', async () => {
  const disk = memory();
  const row = chatRows(listed(emptyCatalog(), 'vps', [chat('c1')]), false).rows[0];
  const sent = [];
  let lose = true;
  let ids = 0;
  const fresh = () => ({ target: `pane-${++ids}`, requestId: `req-${ids}` });
  const call = async (command, args) => {
    sent.push({ command, args, saved: readPromoteTickets(disk, DESKTOP_PROMOTES_KEY)[promoteKey('vps', 'c1')] });
    if (lose) throw new Error('connection dropped');
    return { work: { id: args.target, kind: 'work', title: 'c1', participants: [], cwd: args.cwd, promotedFrom: 'c1' }, chat: { ...chat('c1'), promotedTo: args.target } };
  };
  await assert.rejects(sendPromote(disk, call, row, '/srv/denver', { jigga: 'full' }, fresh, 'Apex-Terminal'), /connection dropped/);
  assert.equal(sent[0].saved.requestId, 'req-1', 'saved before it was sent');
  assert.equal(disk.getItem(PROMOTES_KEY), null, 'never in the phone\'s store');
  // Other choices are refused until the first move is finished or started over.
  await assert.rejects(sendPromote(disk, call, row, '/srv/denver', { jigga: 'read' }, fresh, 'Apex-Terminal'), /started and not confirmed/);
  assert.equal(sent.length, 1);
  lose = false;
  const { work, chat: source } = await sendPromote(disk, call, row, '/srv/denver', { jigga: 'full' }, fresh, 'Apex-Terminal');
  assert.deepEqual(sent[1].args, { source: 'c1', target: 'pane-1', cwd: '/srv/denver', access: { jigga: 'full' }, requestId: 'req-1' });
  assert.equal(work.id, 'pane-1');
  assert.equal(work.hostId, 'vps');
  assert.equal(source.promotedTo, 'pane-1');
  assert.deepEqual(readPromoteTickets(disk, DESKTOP_PROMOTES_KEY), {});
});

test('a move the machine never confirms keeps its ticket; one that can\'t be saved sends nothing', async () => {
  const row = chatRows(listed(emptyCatalog(), 'local', [chat('c1')]), false).rows[0];
  const disk = memory();
  await assert.rejects(sendPromote(disk, async () => ({}), row, '/repo', { jigga: 'ask' }, () => ({ target: 't', requestId: 'r' }), 'This Mac'), /didn't confirm the Work thread/);
  assert.equal(readPromoteTickets(disk, DESKTOP_PROMOTES_KEY)[promoteKey('local', 'c1')].requestId, 'r');
  const full = { ...memory(), setItem: () => { throw new Error('quota'); } };
  let called = false;
  await assert.rejects(sendPromote(full, async () => { called = true; return {}; }, row, '/repo', { jigga: 'ask' }, () => ({ target: 't', requestId: 'r' }), 'This Mac'), /Deck couldn't save the move, so nothing was sent/);
  assert.equal(called, false);
});

test('Start over drops an unconfirmed move only after the machine fences it, or opens the thread it already made', async () => {
  const row = chatRows(listed(emptyCatalog(), 'local', [chat('c1')]), false).rows[0];
  const seed = () => { const disk = memory(); disk.setItem(DESKTOP_PROMOTES_KEY, JSON.stringify({ [promoteKey('local', 'c1')]: { target: 'pane-1', requestId: 'req-1', cwd: '/repo', access: { jigga: 'full' } } })); return disk; };
  let disk = seed();
  const asked = [];
  assert.equal(await abandonPromote(disk, async (command, args) => { asked.push([command, args]); return { state: 'abandoned' }; }, row), null);
  assert.deepEqual(asked, [['chat_promote_abandon', { source: 'c1', requestId: 'req-1' }]]);
  assert.deepEqual(readPromoteTickets(disk, DESKTOP_PROMOTES_KEY), {});
  disk = seed();
  const done = await abandonPromote(disk, async () => ({ state: 'done', work: { id: 'pane-1', kind: 'work', title: 'c1', participants: [], cwd: '/repo' }, chat: { ...chat('c1'), promotedTo: 'pane-1' } }), row);
  assert.equal(done.work.id, 'pane-1');
  assert.equal(done.chat.promotedTo, 'pane-1');
  disk = seed();
  await assert.rejects(abandonPromote(disk, async () => ({}), row), /kept until it can be checked/);
  assert.equal(readPromoteTickets(disk, DESKTOP_PROMOTES_KEY)[promoteKey('local', 'c1')].requestId, 'req-1');
  assert.equal(await abandonPromote(memory(), async () => { throw new Error('not asked'); }, row), null);
});

test('a move waits for queued and uncertain messages, and holds every send after its ticket is saved, across a relaunch', async () => {
  const disk = memory();
  const log = [];
  let online = false, promotedTo = null, postFails = false, claimed = 'done';
  const rpc = {
    async post(machine, room, message) {
      log.push(['post', room, message.text]);
      if (postFails) { postFails = false; throw new Error('link dropped'); }
      return { state: 'done', replySeqs: [], clientMessageId: message.clientMessageId };
    },
    async claim(_m, _r, id) { log.push(['claim', id]); return { state: claimed, replySeqs: [], clientMessageId: id }; },
    async exportRoom() { if (!online) throw new Error('offline'); return { kind: 'chat', participants: [], options: { policy: 'everyone', max_bot_hops: 3 }, transcript: [] }; },
  };
  // The desktop's rule: online, and not held by a move.
  const make = () => new ChatDeliveryController({ storage: new JsonChatDeliveryStorage(disk, { key: DESKTOP_CHAT_DELIVERY_KEY }), rpc,
    canSend: (_chat, message) => online && !promoteHolds(readPromoteTickets(disk, DESKTOP_PROMOTES_KEY), message.machine.id, message.room, promotedTo) });
  const id = deliveryId({ hostId: 'local', room: 'c1' });
  const row = parseChatList('local', { rooms: [chat('c1')] })[0];
  const call = async (command) => { log.push([command]); return { work: { id: 'w1', kind: 'work', title: 'c1', participants: [], cwd: '/repo' }, chat: { ...chat('c1'), promotedTo: 'w1' } }; };
  const fresh = () => ({ target: 'w1', requestId: 'r1' });

  // Null's case: queued offline, back online, moved. The message lands in c1 before the move copies it.
  let outbox = make();
  outbox.cacheChat({ id, title: 'c1', machine: { id: 'local', name: 'This Mac' }, room: 'c1', profiles: {}, snapshot: { kind: 'chat', participants: [], options: { policy: 'everyone', max_bot_hops: 3 }, transcript: [] } });
  const queued = outbox.enqueue(id, 'queued offline', []);
  await outbox.send(id, queued);
  assert.equal(log.length, 0, 'offline: nothing sent');
  // Still offline at move time: refused, nothing moved.
  await assert.rejects(settleForPromote(outbox, id, 'local', 'c1', 'This Mac'), /A message hasn't reached This Mac yet/);
  online = true;
  await settleForPromote(outbox, id, 'local', 'c1', 'This Mac');
  await sendPromote(disk, call, row, '/repo', {}, fresh, 'This Mac');
  assert.deepEqual(log.map((entry) => entry[0]), ['post', 'chat_promote'], 'the queued message went to c1 first, then the move');
  promotedTo = 'w1';

  // After the move, a stray message for c1 never goes, now or after a relaunch.
  const stray = outbox.enqueue(id, 'too late', []);
  await outbox.flush(id);
  outbox = make();
  await outbox.resume();
  assert.equal(log.filter((entry) => entry[0] === 'post').length, 1, 'nothing posted to c1 after the move');
  assert.equal(outbox.snapshot().chats[id].outbox.find((item) => item.id === stray).state, 'unsent');
});

test('while a move is unconfirmed, sends wait through a relaunch; an uncertain message is checked first and a running answer blocks the move', async () => {
  const disk = memory();
  const posts = [];
  let postFails = true, claimed = 'running';
  const rpc = {
    async post(_m, room, message) { posts.push([room, message.text]); if (postFails) { postFails = false; throw new Error('link dropped'); } return { state: 'done', replySeqs: [], clientMessageId: message.clientMessageId }; },
    async claim(_m, _r, id) { return { state: claimed, replySeqs: [], clientMessageId: id }; },
    async exportRoom() { return { kind: 'chat', participants: [], options: { policy: 'everyone', max_bot_hops: 3 }, transcript: [] }; },
  };
  const make = () => new ChatDeliveryController({ storage: new JsonChatDeliveryStorage(disk, { key: DESKTOP_CHAT_DELIVERY_KEY }), rpc,
    canSend: (_chat, message) => !promoteHolds(readPromoteTickets(disk, DESKTOP_PROMOTES_KEY), message.machine.id, message.room, null) });
  const id = deliveryId({ hostId: 'vps', room: 'c1' });
  const row = parseChatList('vps', { rooms: [chat('c1')] })[0];
  let outbox = make();
  outbox.cacheChat({ id, title: 'c1', machine: { id: 'vps', name: 'Apex-Terminal' }, room: 'c1', profiles: {}, snapshot: { kind: 'chat', participants: [], options: { policy: 'everyone', max_bot_hops: 3 }, transcript: [] } });
  const first = outbox.enqueue(id, 'hello', []);
  await assert.rejects(outbox.send(id, first), /link dropped/);
  assert.equal(outbox.snapshot().chats[id].outbox[0].state, 'uncertain');
  // It reached the machine and a bot is still answering: the reply would stay behind, so no move yet.
  await assert.rejects(settleForPromote(outbox, id, 'vps', 'c1', 'Apex-Terminal'), /still answering/);
  assert.equal(posts.length, 1, 'checked by id, not posted again');
  claimed = 'done';
  await settleForPromote(outbox, id, 'vps', 'c1', 'Apex-Terminal');
  // The move's answer is lost: its ticket stays, and so does the hold.
  await assert.rejects(sendPromote(disk, async () => { throw new Error('connection dropped'); }, row, '/srv', {}, () => ({ target: 'w1', requestId: 'r1' }), 'Apex-Terminal'), /connection dropped/);
  const held = outbox.enqueue(id, 'during the move', []);
  await outbox.send(id, held);
  outbox = make();
  await outbox.resume();
  assert.equal(posts.length, 1, 'held while the move is unconfirmed, before and after a relaunch');
  assert.equal(outbox.snapshot().chats[id].outbox.find((item) => item.id === held).state, 'unsent');
});
