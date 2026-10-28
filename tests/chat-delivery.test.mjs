import test from 'node:test';
import assert from 'node:assert/strict';
import { ChatDeliveryController, JsonChatDeliveryStorage, ChatPendingAnswersError, chatDeliveryStatus } from '../src/chatDelivery.ts';

const A = { id: 'studio', name: 'Studio MacBook' };
const B = { id: 'server', name: 'Hetzner' };
const human = (seq, text, extra = {}) => ({ seq, speaker: { kind: 'human' }, text, ...extra });
const bot = (seq, text, extra = {}) => ({ seq, speaker: { kind: 'bot', id: 'null' }, text, ...extra });
const snapshot = (transcript = [], clientMessages = {}) => ({ kind: 'chat', participants: [{ id: 'null', display_name: 'Null', backend: { kind: 'agent', tool: 'codex', model: null }, persona: '', access: 'read', effort: null }], options: { policy: 'everyone', max_bot_hops: 0 }, transcript, clientMessages });
function harness() {
  const disk = new Map();
  const local = { getItem: key => disk.get(key) ?? null, setItem: (key, value) => { disk.set(key, value); } };
  const storage = new JsonChatDeliveryStorage(local);
  let next = 0;
  const remote = new Map([['studio/r1', snapshot()]]);
  const imports = new Map();
  const calls = [];
  const offline = new Set();
  const fail = new Map();
  const key = (machine, room) => `${machine}/${room}`;
  const before = (method, machine, args) => {
    calls.push([method, machine, ...args]);
    if (offline.has(machine)) throw Error(`Offline ${machine}`);
    if (fail.has(method)) { const fn = fail.get(method); fail.delete(method); fn(); }
  };
  const rpc = {
    exportRoom: async (machine, room) => { before('export', machine, [room]); return structuredClone(remote.get(key(machine, room))); },
    post: async (machine, room, message) => {
      before('post', machine, [room, message]);
      const saved = remote.get(key(machine, room));
      const known = saved.clientMessages[message.clientMessageId];
      if (known) return { ...known, clientMessageId: message.clientMessageId };
      saved.transcript.push(human(saved.transcript.length + 1, message.text, { clientMessageId: message.clientMessageId }));
      const result = { state: 'running', replySeqs: [] };
      saved.clientMessages[message.clientMessageId] = result;
      return { ...result, clientMessageId: message.clientMessageId };
    },
    claim: async (machine, room, id) => {
      before('claim', machine, [room, id]);
      const saved = remote.get(key(machine, room));
      return structuredClone(saved.clientMessages[id] ??= { state: 'fenced', replySeqs: [] });
    },
    importRoom: async (machine, payload) => {
      before('import', machine, [payload]);
      const moveKey = `${machine}/${payload.moveId}`;
      if (!imports.has(moveKey)) {
        imports.set(moveKey, payload.id);
        remote.set(key(machine, payload.id), { ...snapshot(payload.entries),
          participants: payload.participants.map(request => ({ ...snapshot().participants[0], id: request.id ?? request.profile,
            display_name: request.display_name ?? request.profile, backend: { kind: 'agent', tool: 'codex', model: request.model ?? null },
            effort: request.effort ?? null, ...(request.speed ? { speed: request.speed } : {}) })),
          importProfiles: Object.fromEntries(payload.participants.map(request => [request.id ?? request.profile, request.profile])) });
      }
      return { room: structuredClone(remote.get(key(machine, imports.get(moveKey)))), skipped: [] };
    },
    mergeHistory: async (machine, room, entries) => {
      before('merge', machine, [room, entries]);
      const saved = remote.get(key(machine, room));
      let added = 0;
      for (const entry of entries) {
        const originKey = e => JSON.stringify(e.origin);
        if (saved.transcript.some(e => originKey(e) === originKey(entry))) continue;
        saved.transcript.push({ ...entry, seq: saved.transcript.length + 1 });
        added++;
      }
      return { added };
    },
    archive: async (machine, room, movedTo) => { before('archive', machine, [room, movedTo]); remote.get(key(machine, room)).archived = true; },
    stop: async (machine, room) => {
      before('stop', machine, [room]);
      for (const value of Object.values(remote.get(key(machine, room)).clientMessages)) if (value.state === 'running') value.state = 'interrupted';
    },
  };
  const create = () => new ChatDeliveryController({ storage, rpc, id: () => `id-${++next}`, now: () => 100 });
  const controller = create();
  controller.cacheChat({ id: 'chat', title: 'Chat', machine: A, room: 'r1', profiles: { null: 'saved-null' }, snapshot: snapshot() });
  return { controller, create, disk, local, storage, remote, calls, rpc, offline, fail };
}
const message = h => h.controller.snapshot().chats.chat.outbox[0];

test('machine moves send saved profile references for copied aliases with only allowed settings', async () => {
  const h = harness();
  const source = snapshot([human(1, 'saved history')]);
  source.participants = [{ id: 'reviewer-2', display_name: 'Second reviewer',
    backend: { kind: 'open_ai_compatible', base_url: 'https://source.example/v1', model: 'source-model', api_key_env: 'SOURCE_KEY' },
    persona: 'Source machine instructions', access: 'full', effort: 'high', speed: 'fast', voice: 'source-voice' }];
  h.remote.set('studio/r1', source);
  h.controller.cacheChat({ id: 'chat', title: 'Chat', machine: A, room: 'r1', profiles: { 'reviewer-2': 'saved-reviewer' }, snapshot: source });
  await h.controller.move('chat', B);
  assert.deepEqual(h.calls.find(call => call[0] === 'import')[2].participants,
    [{ profile: 'saved-reviewer', id: 'reviewer-2', display_name: 'Second reviewer', model: 'source-model', effort: 'high', speed: 'fast' }]);
});

test('profile provenance survives online refresh, a lost import acknowledgement and phone restart', async () => {
  const h = harness();
  const source = snapshot();
  source.participants[0].id = 'copy-2';
  h.remote.set('studio/r1', source);
  h.controller.cacheChat({ id: 'chat', title: 'Chat', machine: A, room: 'r1', profiles: { 'copy-2': 'saved-original' }, snapshot: source });
  await h.controller.reconnect(A.id);
  const actualImport = h.rpc.importRoom;
  h.rpc.importRoom = async (...args) => { await actualImport(...args); throw Error('Import ack lost'); };
  await assert.rejects(h.controller.move('chat', B), /Import ack lost/);
  assert.deepEqual(Object.values(h.storage.load().moves)[0].snapshot.importProfiles, { 'copy-2': 'saved-original' });
  h.rpc.importRoom = actualImport;
  h.controller = h.create();
  await h.controller.resume();
  assert.deepEqual(h.create().snapshot().chats.chat.snapshot.importProfiles, { 'copy-2': 'saved-original' });
  assert.deepEqual(h.calls.filter(call => call[0] === 'import').map(call => call[2].participants[0].profile), ['saved-original', 'saved-original']);
});

test('cache uses durable roster mappings over a stale catalog before export and after restart', async () => {
  const h = harness();
  const source = snapshot();
  source.participants = ['x', 'new-bot'].map(id => ({ ...snapshot().participants[0], id }));
  source.importProfiles = { x: 'b', 'new-bot': 'a' };
  h.remote.set('studio/r1', source);
  h.controller.cacheChat({ id: 'chat', title: 'Chat', machine: A, room: 'r1', profiles: { x: 'a', removed: 'a' }, snapshot: source });
  assert.deepEqual(h.controller.snapshot().chats.chat.snapshot.importProfiles, { x: 'b', 'new-bot': 'a' });
  h.controller = h.create();
  await h.controller.reconnect(A.id);
  assert.deepEqual(h.controller.snapshot().chats.chat.snapshot.importProfiles, { x: 'b', 'new-bot': 'a' });
  h.offline.add(A.id);
  await h.controller.move('chat', B);
  assert.deepEqual(h.calls.find(call => call[0] === 'import')[2].participants.map(({ id, profile }) => ({ id, profile })),
    [{ id: 'x', profile: 'b' }, { id: 'new-bot', profile: 'a' }]);
});

test('legacy cached copies without profile provenance are skipped and explicit sends stay held', async () => {
  const h = harness();
  const saved = h.storage.load();
  saved.chats.chat.snapshot.participants[0].id = 'null-2';
  delete saved.chats.chat.snapshot.importProfiles;
  h.disk.set('apex.phone.chat-delivery.v1', JSON.stringify(saved));
  h.controller = h.create();
  h.offline.add(A.id);
  h.controller.enqueue('chat', 'only this copy', ['null-2']);
  await h.controller.move('chat', B);
  assert.deepEqual(h.calls.find(call => call[0] === 'import')[2].participants, []);
  const move = Object.values(h.controller.snapshot().moves)[0];
  assert.equal(move.skipped[0].participant, 'null-2');
  assert.match(move.skipped[0].reason, /profile.*unknown|unknown.*profile/i);
  assert.match(message(h).blockedReason, /not set up/i);
  assert.equal(h.calls.filter(call => call[0] === 'post').length, 0);
});

test('persists uncertain before writing and a lost acknowledgement never becomes unsent on restart', async () => {
  const h = harness();
  const id = h.controller.enqueue('chat', 'hello', ['null']);
  const actualPost = h.rpc.post;
  h.rpc.post = async (...args) => {
    assert.equal(h.storage.load().chats.chat.outbox[0].state, 'uncertain');
    await actualPost(...args);
    throw Error('Acknowledgement lost');
  };
  await assert.rejects(h.controller.send('chat', id), /Acknowledgement lost/);
  assert.equal(h.create().snapshot().chats.chat.outbox[0].state, 'uncertain');
  h.controller = h.create();
  await h.controller.reconnect(A.id);
  assert.equal(message(h).state, 'delivered');
  assert.equal(message(h).accepted, 'running');
  assert.equal(h.remote.get('studio/r1').transcript.length, 1);
});

test('storage write failure and quota exhaustion stop all network writes', async () => {
  const h = harness();
  const id = h.controller.enqueue('chat', 'hello');
  h.local.setItem = () => { throw Error('Disk full'); };
  await assert.rejects(h.controller.send('chat', id), /Disk full/);
  assert.equal(message(h).state, 'unsent');
  assert.equal(h.calls.length, 0);
  const quota = new JsonChatDeliveryStorage({ getItem: () => null, setItem: () => assert.fail('must not write') }, { maxBytes: 8 });
  assert.throws(() => quota.save({ version: 1, chats: {}, moves: {} }), /quota/i);
});

test('offline move imports saved history and only never-sent messages can reach B', async () => {
  const h = harness();
  h.controller.cacheChat({ id: 'chat', title: 'Chat', machine: A, room: 'r1', profiles: { null: 'saved-null' }, snapshot: snapshot([human(1, 'old')]) });
  const maybe = h.controller.enqueue('chat', 'maybe', ['null']);
  h.offline.add(A.id);
  await assert.rejects(h.controller.send('chat', maybe));
  h.controller.enqueue('chat', 'never sent', ['null']);
  await h.controller.move('chat', B);
  const state = h.controller.snapshot();
  assert.equal(state.chats.chat.machine.id, B.id);
  assert.equal(state.chats.chat.outbox[0].machine.id, A.id);
  assert.equal(state.chats.chat.outbox[0].state, 'uncertain');
  assert.equal(state.chats.chat.outbox[1].machine.id, B.id);
  assert.equal(h.remote.get('server/id-3').transcript[0].text, 'old');
  assert.deepEqual(h.calls.filter(c => c[0] === 'post' && c[1] === B.id).map(c => c[3].text), ['never sent']);
});

test('claim winning delayed-post race fences A and permits the exact id once on B', async () => {
  const h = harness();
  const id = h.controller.enqueue('chat', 'racing', ['null']);
  let release;
  const actualPost = h.rpc.post;
  h.rpc.post = async (...args) => {
    if (args[0] === A.id) await new Promise(resolve => { release = resolve; });
    return actualPost(...args);
  };
  const pending = h.controller.send('chat', id);
  await Promise.resolve();
  await h.controller.move('chat', B);
  release();
  await pending;
  assert.equal(h.remote.get('studio/r1').transcript.length, 0);
  assert.deepEqual(h.remote.get('server/id-2').transcript.map(m => m.text), ['racing']);
  assert.equal(message(h).machine.id, B.id);
  assert.equal(message(h).accepted, 'running');
});

test('post winning delayed-claim race stays A-owned and moving requires a pending-answer choice', async () => {
  const h = harness();
  const id = h.controller.enqueue('chat', 'accepted');
  await h.controller.send('chat', id);
  await assert.rejects(h.controller.move('chat', B), ChatPendingAnswersError);
  assert.equal(h.calls.filter(c => c[0] === 'import').length, 0);
  await h.controller.move('chat', B, { pending: 'leave' });
  assert.equal(message(h).machine.id, A.id);
  assert.equal(message(h).accepted, 'running');
  assert.equal(h.calls.filter(c => c[0] === 'post' && c[1] === B.id).length, 0);
});

test('late replies append after B conversation, keep reply links, and repeat merge changes nothing', async () => {
  const h = harness();
  const id = h.controller.enqueue('chat', 'A question');
  await h.controller.send('chat', id);
  await h.controller.move('chat', B, { pending: 'leave' });
  for (const text of ['new one', 'new two']) {
    const queued = h.controller.enqueue('chat', text);
    await h.controller.send('chat', queued);
  }
  const source = h.remote.get('studio/r1');
  source.transcript.push(bot(2, 'late answer', { replyToClientMessageId: id }));
  source.clientMessages[id] = { state: 'done', replySeqs: [2] };
  await h.controller.reconnect(A.id);
  await h.controller.reconnect(A.id);
  const target = h.remote.get('server/id-2');
  assert.deepEqual(target.transcript.map(m => m.text), ['A question', 'new one', 'new two', 'late answer']);
  assert.deepEqual(target.transcript.at(-1).origin, { machine: A.id, room: 'r1', seq: 2 });
  assert.equal(target.transcript.at(-1).replyToClientMessageId, id);
  assert.equal(target.transcript.at(-1).lateReplyFrom, 'Studio MacBook');
  assert.equal(h.create().snapshot().chats.chat.snapshot.transcript.at(-1).lateReplyFrom, 'Studio MacBook');
  assert.equal(target.transcript[0].lateReplyFrom, undefined, 'history copied during the move is not a late reply');
  assert.equal(message(h).accepted, 'done');
});

test('a late reply retains the original machine name when the chat moves again', async () => {
  const h = harness();
  const id = h.controller.enqueue('chat', 'A question');
  await h.controller.send('chat', id);
  await h.controller.move('chat', B, { pending: 'leave' });
  const source = h.remote.get('studio/r1');
  source.transcript.push(bot(2, 'late answer', { replyToClientMessageId: id }));
  source.clientMessages[id] = { state: 'done', replySeqs: [2] };
  await h.controller.reconnect(A.id);
  await h.controller.move('chat', { id: 'third', name: 'Windows PC' }, { pending: 'leave' });
  const chat = h.create().snapshot().chats.chat;
  const answer = h.remote.get(`third/${chat.room}`).transcript.find(entry => entry.text === 'late answer');
  assert.equal(answer.lateReplyFrom, 'Studio MacBook');
  assert.deepEqual(answer.origin, { machine: A.id, room: 'r1', seq: 2 });
});

test('an interrupted message remains history until an explicit Retry creates a fresh id', async () => {
  const h = harness();
  const id = h.controller.enqueue('chat', 'try this');
  await h.controller.send('chat', id);
  h.remote.get('studio/r1').clientMessages[id] = { state: 'interrupted', replySeqs: [] };
  await h.controller.reconnect(A.id);
  assert.equal(message(h).accepted, 'interrupted');
  assert.equal(h.calls.filter(c => c[0] === 'post').length, 1);
  const fresh = await h.controller.retry('chat', id);
  assert.notEqual(fresh, id);
  assert.equal(h.remote.get('studio/r1').transcript.length, 2);
});

test('Send anyway requires explicit duplicate-risk acknowledgement and leaves original ownership intact', async () => {
  const h = harness();
  const id = h.controller.enqueue('chat', 'maybe');
  h.offline.add(A.id);
  await assert.rejects(h.controller.send('chat', id));
  await h.controller.move('chat', B);
  await assert.rejects(h.controller.sendAnyway('chat', id, { acknowledgeDuplicateRisk: false }), /acknowledge/i);
  const fresh = await h.controller.sendAnyway('chat', id, { acknowledgeDuplicateRisk: true });
  assert.notEqual(fresh, id);
  assert.equal(message(h).machine.id, A.id);
  assert.equal(message(h).state, 'uncertain');
  assert.deepEqual(h.remote.get('server/id-2').transcript.map(m => m.text), ['maybe']);
});

test('move journal is saved before export and an export crash resumes with a single target room', async () => {
  const h = harness();
  const actualExport = h.rpc.exportRoom;
  h.rpc.exportRoom = async (...args) => {
    assert.equal(Object.values(h.storage.load().moves)[0].step, 'export');
    return actualExport(...args);
  };
  let archiveCalls = 0;
  h.rpc.archive = async () => { archiveCalls++; throw Error('Archive offline'); };
  await h.controller.move('chat', B);
  assert.equal(Object.values(h.storage.load().moves)[0].step, 'archive');
  h.controller = h.create();
  h.rpc.exportRoom = actualExport;
  h.rpc.archive = async (machine, room) => { archiveCalls++; h.remote.get(`${machine}/${room}`).archived = true; };
  await h.controller.resume();
  assert.equal(Object.values(h.storage.load().moves)[0].step, 'complete');
  assert.equal(h.remote.get('studio/r1').archived, true);
  assert.equal([...h.remote.keys()].filter(k => k.startsWith('server/')).length, 1);
  assert.ok(archiveCalls >= 2);
});

test('reconnect refreshes an active transcript even when this phone has no outbox', async () => {
  const h = harness();
  h.remote.get('studio/r1').transcript.push(human(1, 'from another phone'), bot(2, 'answer'));
  await h.controller.reconnect(A.id);
  assert.deepEqual(h.controller.snapshot().chats.chat.snapshot.transcript.map(m => m.text), ['from another phone', 'answer']);
});

test('a crash after import succeeds but before phone saves archive step repeats moveId without creating a second room', async () => {
  const h = harness();
  h.controller.enqueue('chat', 'queued');
  const save = h.storage.save.bind(h.storage);
  let crash = true;
  h.storage.save = state => {
    if (crash && Object.values(state.moves).some(move => move.step === 'archive')) { crash = false; throw Error('Phone killed after import'); }
    save(state);
  };
  await assert.rejects(h.controller.move('chat', B), /Phone killed/);
  assert.equal(Object.values(h.storage.load().moves)[0].step, 'import');
  assert.equal(h.calls.filter(c => c[0] === 'post').length, 0);
  h.controller = h.create();
  await h.controller.resume();
  assert.equal([...h.remote.keys()].filter(key => key.startsWith('server/')).length, 1);
  assert.equal(h.remote.get('studio/r1').archived, true);
  assert.deepEqual(h.remote.get('server/id-2').transcript.map(m => m.text), ['queued']);
});

test('a lost import acknowledgement resumes the same durable move rather than creating another room', async () => {
  const h = harness();
  const actual = h.rpc.importRoom;
  h.rpc.importRoom = async (...args) => { await actual(...args); throw Error('Import ack lost'); };
  await assert.rejects(h.controller.move('chat', B), /Import ack lost/);
  assert.equal(Object.values(h.storage.load().moves)[0].step, 'import');
  h.rpc.importRoom = actual;
  h.controller = h.create();
  await h.controller.resume();
  assert.equal([...h.remote.keys()].filter(key => key.startsWith('server/')).length, 1);
  const imports = h.calls.filter(c => c[0] === 'import').map(c => c[2].moveId);
  assert.deepEqual(imports, ['id-1', 'id-1']);
});

test('a crash after late merge succeeds repeats the saved merge without doubling the late answer', async () => {
  const h = harness();
  const id = h.controller.enqueue('chat', 'question');
  await h.controller.send('chat', id);
  await h.controller.move('chat', B, { pending: 'leave' });
  const source = h.remote.get('studio/r1');
  source.transcript.push(bot(2, 'late', { replyToClientMessageId: id }));
  source.clientMessages[id] = { state: 'done', replySeqs: [2] };
  const save = h.storage.save.bind(h.storage);
  let crash = true;
  h.storage.save = state => {
    if (crash && Object.values(state.moves).some(move => move.merges.some(merge => merge.confirmed))) { crash = false; throw Error('Phone killed after merge'); }
    save(state);
  };
  await assert.rejects(h.controller.reconnect(A.id), /Phone killed/);
  const persisted = Object.values(h.storage.load().moves)[0];
  assert.equal(persisted.merges[0].confirmed, false);
  h.controller = h.create();
  await h.controller.resume();
  assert.deepEqual(h.remote.get('server/id-2').transcript.map(m => m.text), ['question', 'late']);
  assert.equal(Object.values(h.storage.load().moves)[0].merges[0].confirmed, true);
});

test('the import result room ID is authoritative after an idempotent move was already created', async () => {
  const h = harness();
  const actual = h.rpc.importRoom;
  h.rpc.importRoom = async (machine, payload) => ({ ...await actual(machine, { ...payload, id: 'original-target' }), id: 'original-target' });
  await h.controller.move('chat', B);
  assert.equal(h.controller.snapshot().chats.chat.room, 'original-target');
  assert.equal(Object.values(h.controller.snapshot().moves)[0].targetRoom, 'original-target');
});

test('unsupported explicit targets are held rather than falling back to all destination bots', async () => {
  const h = harness();
  const id = h.controller.enqueue('chat', 'only for Null', ['null']);
  const actual = h.rpc.importRoom;
  h.rpc.importRoom = async (...args) => ({ ...await actual(...args), skipped: [{ participant: 'null', reason: 'Not configured on Hetzner' }] });
  await h.controller.move('chat', B);
  assert.equal(h.controller.snapshot().chats.chat.outbox[0].state, 'unsent');
  assert.match(h.controller.snapshot().chats.chat.outbox[0].blockedReason, /not set up/i);
  await h.controller.send('chat', id);
  assert.equal(h.calls.filter(c => c[0] === 'post').length, 0);
});

test('injected busy-bot scheduling guards automatic flush without changing the durable queued message', async () => {
  const h = harness();
  let ready = false;
  h.controller = new ChatDeliveryController({ storage: h.storage, rpc: h.rpc, id: () => 'guarded', canSend: () => ready });
  h.controller.enqueue('chat', 'wait for bot', ['null']);
  await h.controller.flush('chat');
  assert.equal(message(h).state, 'unsent');
  assert.equal(h.calls.filter(c => c[0] === 'post').length, 0);
  ready = true;
  await h.controller.flush('chat');
  assert.equal(message(h).state, 'delivered');
});

test('pending answers accepted on another device also require wait or stop before a reachable move', async () => {
  const h = harness();
  h.remote.get('studio/r1').clientMessages.other = { state: 'running', replySeqs: [] };
  await assert.rejects(h.controller.move('chat', B), ChatPendingAnswersError);
  await h.controller.move('chat', B, { pending: 'stop' });
  assert.equal(h.remote.get('studio/r1').clientMessages.other.state, 'interrupted');
  assert.equal(h.calls.filter(c => c[0] === 'stop').length, 1);
});

test('work snapshots and corrupted durable outbox data fail closed', () => {
  const h = harness();
  assert.throws(() => h.controller.cacheChat({ id: 'work', title: 'Work', machine: A, room: 'work', profiles: {}, snapshot: { ...snapshot(), kind: 'work' } }), /Only chat/);
  const saved = h.storage.load();
  saved.chats.chat.outbox.push({ id: 'bad', state: 'mystery' });
  h.disk.set('apex.phone.chat-delivery.v1', JSON.stringify(saved));
  assert.throws(h.create, /could not be read/i);
  assert.equal(h.calls.length, 0);
});

for (const accepted of ['running', 'done', 'interrupted']) test(`lost-ack move and phone restart retain ${accepted} ownership on A and merge saved replies`, async () => {
  const h = harness();
  const id = h.controller.enqueue('chat', 'lost acknowledgement');
  const actual = h.rpc.post;
  h.rpc.post = async (...args) => { await actual(...args); throw Error('Ack lost'); };
  await assert.rejects(h.controller.send('chat', id));
  const source = h.remote.get('studio/r1');
  source.clientMessages[id] = { state: accepted, replySeqs: accepted === 'running' ? [] : [2] };
  if (accepted !== 'running') source.transcript.push(bot(2, 'saved answer', { replyToClientMessageId: id }));
  h.offline.add(A.id);
  h.controller = h.create();
  await h.controller.move('chat', B);
  h.controller = h.create();
  h.offline.delete(A.id);
  await h.controller.reconnect(A.id);
  assert.equal(message(h).machine.id, A.id);
  assert.equal(message(h).accepted, accepted);
  assert.equal(h.calls.filter(c => c[0] === 'post' && c[1] === B.id).length, 0);
  const texts = h.remote.get('server/id-2').transcript.map(m => m.text);
  assert.deepEqual(texts, accepted === 'running' ? ['lost acknowledgement'] : ['lost acknowledgement', 'saved answer']);
});

test('an exported fence is confirmed by a fresh claim before its ID is released to B', async () => {
  const h = harness();
  const id = h.controller.enqueue('chat', 'unknown');
  h.offline.add(A.id);
  await assert.rejects(h.controller.send('chat', id));
  h.remote.get('studio/r1').clientMessages[id] = { state: 'fenced', replySeqs: [] };
  h.offline.delete(A.id);
  await h.controller.move('chat', B);
  const claim = h.calls.findIndex(call => call[0] === 'claim' && call[3] === id);
  const targetPost = h.calls.findIndex(call => call[0] === 'post' && call[1] === B.id);
  assert.ok(claim >= 0 && claim < targetPost);
});

test('a late source fence after a second machine move releases the message onto the current machine', async () => {
  const h = harness();
  const C = { id: 'third', name: 'Office Mac mini' };
  const id = h.controller.enqueue('chat', 'still unknown');
  h.offline.add(A.id);
  await assert.rejects(h.controller.send('chat', id));
  await h.controller.move('chat', B);
  await h.controller.move('chat', C);
  h.offline.delete(A.id);
  await h.controller.reconnect(A.id);
  assert.equal(message(h).machine.id, C.id);
  assert.equal(message(h).state, 'delivered');
  assert.deepEqual(h.calls.filter(call => call[0] === 'post' && call[1] !== A.id).map(call => call[1]), [C.id]);
});

test('a stopped source group carries partial saved replies as history without starting B bots for the old ID', async () => {
  const h = harness();
  const id = h.controller.enqueue('chat', 'question', ['null']);
  await h.controller.send('chat', id);
  const source = h.remote.get('studio/r1');
  source.transcript.push(bot(2, 'first saved reply', { replyToClientMessageId: id }));
  source.clientMessages[id].replySeqs.push(2);
  await h.controller.move('chat', B, { pending: 'stop' });
  assert.equal(message(h).accepted, 'interrupted');
  assert.deepEqual(h.remote.get('server/id-2').transcript.map(item => item.text), ['question', 'first saved reply']);
  assert.equal(h.calls.filter(call => call[0] === 'post' && call[1] === B.id).length, 0);
});

test('concurrent move requests reuse the same journal and import a single room', async () => {
  const h = harness();
  const [one, two] = await Promise.all([h.controller.move('chat', B), h.controller.move('chat', B)]);
  assert.equal(one, two);
  assert.equal(Object.keys(h.storage.load().moves).length, 1);
  assert.equal([...h.remote.keys()].filter(key => key.startsWith('server/')).length, 1);
});

for (const terminal of ['done', 'interrupted']) test(`a delayed running post acknowledgement cannot erase ${terminal} receipt and saved reply sequences`, async () => {
  const h = harness();
  const id = h.controller.enqueue('chat', 'question');
  const actual = h.rpc.post;
  let release;
  h.rpc.post = async (...args) => {
    const result = await actual(...args);
    await new Promise(resolve => { release = resolve; });
    return result;
  };
  const posting = h.controller.send('chat', id);
  while (!release) await Promise.resolve();
  const latest = snapshot([human(1, 'question', { clientMessageId: id }), bot(2, 'saved', { replyToClientMessageId: id })], { [id]: { state: terminal, replySeqs: [2] } });
  await h.controller.observe('chat', A.id, 'r1', latest);
  release();
  await posting;
  assert.equal(message(h).accepted, terminal);
  assert.deepEqual(message(h).replySeqs, [2]);
  assert.equal(h.controller.snapshot().chats.chat.snapshot.clientMessages[id].state, terminal);
});

test('a delayed old active-room export cannot overwrite participants on the newly moved route', async () => {
  const h = harness();
  const C = { id: 'third', name: 'Office Mac mini' };
  await h.controller.move('chat', B);
  const actualExport = h.rpc.exportRoom;
  let release, began;
  const beganPromise = new Promise(resolve => { began = resolve; });
  let hold = true;
  h.rpc.exportRoom = async (machine, room) => {
    const result = await actualExport(machine, room);
    if (machine === B.id && hold) { hold = false; began(); await new Promise(resolve => { release = resolve; }); }
    return result;
  };
  const recovery = h.controller.reconnect(B.id);
  await beganPromise;
  const actualImport = h.rpc.importRoom;
  h.rpc.importRoom = async (machine, payload) => {
    const result = await actualImport(machine, payload);
    if (machine === C.id) { result.room.participants[0].id = 'c-bot'; h.remote.get(`${machine}/${payload.id}`).participants[0].id = 'c-bot'; }
    return result;
  };
  await h.controller.move('chat', C);
  release();
  await recovery;
  assert.equal(h.controller.snapshot().chats.chat.machine.id, C.id);
  assert.equal(h.controller.snapshot().chats.chat.snapshot.participants[0].id, 'c-bot');
});

test('malformed saved merge acknowledgements are refused rather than silently treated as delivered', async () => {
  const h = harness();
  await h.controller.move('chat', B);
  const saved = h.storage.load();
  Object.values(saved.moves)[0].merges.push({ id: 'bad', confirmed: 'false', entries: [bot(2, 'lost')] });
  h.disk.set('apex.phone.chat-delivery.v1', JSON.stringify(saved));
  assert.throws(h.create, /could not be read/i);
});

test('late replies reach current C while intermediate B is offline', async () => {
  const h = harness();
  const C = { id: 'third', name: 'Office Mac mini' };
  const id = h.controller.enqueue('chat', 'original question');
  await h.controller.send('chat', id);
  await h.controller.move('chat', B, { pending: 'leave' });
  h.offline.add(B.id);
  await h.controller.move('chat', C);
  const source = h.remote.get('studio/r1');
  source.transcript.push(bot(2, 'late answer while B offline', { replyToClientMessageId: id }));
  source.clientMessages[id] = { state: 'done', replySeqs: [2] };
  await h.controller.reconnect(A.id);
  const currentRoom = h.controller.snapshot().chats.chat.room;
  assert.deepEqual(h.remote.get(`third/${currentRoom}`).transcript.map(entry => entry.text), ['original question', 'late answer while B offline']);
  assert.equal(h.calls.filter(call => call[0] === 'post' && call[1] === C.id).length, 0);
});

test('monotonic originSeq distinguishes new content after transcript seq is reused', async () => {
  const h = harness();
  h.controller.cacheChat({ id: 'chat', title: 'Chat', machine: A, room: 'r1', profiles: { null: 'saved-null' }, snapshot: snapshot([human(1, 'old', { originSeq: 1 })]) });
  const cleared = snapshot([human(1, 'after clear', { originSeq: 2 })]);
  h.remote.set('studio/r1', cleared);
  await h.controller.observe('chat', A.id, 'r1', cleared);
  h.offline.add(A.id);
  await h.controller.move('chat', B);
  const moved = h.remote.get('server/id-1').transcript;
  assert.deepEqual(moved.map(entry => entry.text), ['after clear']);
  assert.deepEqual(moved[0].origin, { machine: A.id, room: 'r1', seq: 2 });
});


test('a newer observation on the same route survives an older in-flight export', async () => {
  const h = harness();
  const actualExport = h.rpc.exportRoom;
  let release, began;
  const started = new Promise(resolve => { began = resolve; });
  h.rpc.exportRoom = async (...args) => {
    const old = await actualExport(...args); began();
    await new Promise(resolve => { release = resolve; });
    return old;
  };
  const reconnecting = h.controller.reconnect(A.id);
  await started;
  await h.controller.observe('chat', A.id, 'r1', snapshot([human(1, 'newer observed message')]));
  release();
  await reconnecting;
  assert.deepEqual(h.controller.snapshot().chats.chat.snapshot.transcript.map(entry => entry.text), ['newer observed message']);
});

test('message status exposes source ownership and explicit recovery actions with the real machine name', async () => {
  const h = harness();
  const id = h.controller.enqueue('chat', 'question');
  h.offline.add(A.id);
  await assert.rejects(h.controller.send('chat', id));
  await h.controller.move('chat', B);
  const maybe = chatDeliveryStatus(message(h), B);
  assert.equal(maybe.kind, 'uncertain');
  assert.match(maybe.line, /Studio MacBook/);
  assert.equal(maybe.canSendAnyway, true);
  assert.equal(maybe.canRetry, false);
  h.offline.delete(A.id);
  h.remote.get('studio/r1').clientMessages[id] = { state: 'interrupted', replySeqs: [] };
  await h.controller.reconnect(A.id);
  const stopped = chatDeliveryStatus(message(h), B);
  assert.equal(stopped.kind, 'interrupted');
  assert.match(stopped.line, /Answer stopped on Studio MacBook/);
  assert.equal(stopped.canRetry, true);
  assert.equal(stopped.canSendAnyway, false);
});

test('a crash after export but before advancing its journal step resumes export safely', async () => {
  const h = harness();
  const save = h.storage.save.bind(h.storage);
  let crash = true;
  h.storage.save = state => {
    if (crash && Object.values(state.moves).some(move => move.step === 'import')) { crash = false; throw Error('Phone killed after export'); }
    save(state);
  };
  await assert.rejects(h.controller.move('chat', B), /Phone killed after export/);
  assert.equal(Object.values(h.storage.load().moves)[0].step, 'export');
  assert.equal(h.calls.filter(call => call[0] === 'import').length, 0);
  h.controller = h.create();
  await h.controller.resume();
  assert.equal([...h.remote.keys()].filter(key => key.startsWith('server/')).length, 1);
  assert.equal(Object.values(h.storage.load().moves)[0].step, 'complete');
});

test('a crash after source archive succeeds repeats archive as a no-op after restart', async () => {
  const h = harness();
  const save = h.storage.save.bind(h.storage);
  let crash = true;
  h.storage.save = state => {
    if (crash && Object.values(state.moves).some(move => move.step === 'complete')) { crash = false; throw Error('Phone killed after archive'); }
    save(state);
  };
  await assert.rejects(h.controller.move('chat', B), /Phone killed after archive/);
  assert.equal(Object.values(h.storage.load().moves)[0].step, 'archive');
  assert.equal(h.remote.get('studio/r1').archived, true);
  h.controller = h.create();
  await h.controller.resume();
  assert.equal(h.calls.filter(call => call[0] === 'archive').length, 2);
  assert.equal(Object.values(h.storage.load().moves)[0].step, 'complete');
});

test('failure to save the initial move journal prevents even the source export', async () => {
  const h = harness();
  h.local.setItem = () => { throw Error('Disk full'); };
  await assert.rejects(h.controller.move('chat', B), /Disk full/);
  assert.equal(h.calls.length, 0);
  assert.equal(Object.keys(h.controller.snapshot().moves).length, 0);
});

test('failure to save a source fence prevents destination writes until a fresh restart claim succeeds', async () => {
  const h = harness();
  const id = h.controller.enqueue('chat', 'fence me');
  h.offline.add(A.id);
  await assert.rejects(h.controller.send('chat', id));
  h.offline.delete(A.id);
  const save = h.storage.save.bind(h.storage);
  let crash = true;
  h.storage.save = state => {
    if (crash && state.chats.chat.outbox[0].fenceClaimed) { crash = false; throw Error('Fence save failed'); }
    save(state);
  };
  await assert.rejects(h.controller.move('chat', B), /Fence save failed/);
  assert.equal(h.calls.filter(call => call[0] === 'import').length, 0);
  assert.equal(h.remote.get('studio/r1').clientMessages[id].state, 'fenced');
  h.controller = h.create();
  await h.controller.resume();
  assert.equal(message(h).machine.id, B.id);
  assert.equal(message(h).state, 'delivered');
  assert.deepEqual(h.remote.get('server/id-2').transcript.map(entry => entry.text), ['fence me']);
});

test('a move retains the source group addressing and bot-hop policy', async () => {
  const h = harness();
  h.remote.get('studio/r1').options = { policy: 'round_robin', max_bot_hops: 4 };
  await h.controller.move('chat', B);
  assert.deepEqual(h.calls.find(call => call[0] === 'import')[2].options, { policy: 'round_robin', max_bot_hops: 4 });
});
