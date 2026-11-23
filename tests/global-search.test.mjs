import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ROWS_PER_GROUP, SEARCH_NEEDS_PAIRING, SEARCH_REFUSED, createSearch, emptyView, groupOrder, loadRecents, machineLine,
  parseQuery, pushRecent, queryMatches, reduceSearch, resolveMessage, saveRecents, shownRows, showMoreLabel,
} from '../src/globalSearch.ts';

const machines = [{ id: 'local', name: 'MacBook Pro', offline: false }, { id: 'vps', name: 'Hetzner', offline: false }];
const message = (room, seq, text, at, extra = {}) => ({
  kind: 'message', title: 'Release handoff', snippet: text, ranges: [[0, 3]], at, project: '/work/app', roomTitle: 'Release handoff', archived: false, trashed: false,
  target: { type: 'message', room, roomKind: 'work', seq, originSeq: null, clientMessageId: null, speaker: 'You', ...extra },
});
const thread = (room, title) => ({ kind: 'thread', title, snippet: title, ranges: [], at: 1, project: null, roomTitle: null, archived: false, trashed: false, target: { type: 'room', room, roomKind: 'work' } });
const reply = (hits, totals = {}, skipped = []) => ({ hits, totals, skipped, tookMs: 1 });
const started = (query = 'installer', list = machines) => reduceSearch(emptyView(), { type: 'start', run: 1, query, machines: list, kinds: ['project', 'thread', 'agent', 'message'] });

test('groups come in the fixed order', () => {
  assert.deepEqual(groupOrder(), ['project', 'thread', 'agent', 'message', 'setting', 'task', 'note', 'library', 'file_name', 'file_text', 'step']);
  let view = started();
  view = reduceSearch(view, { type: 'reply', run: 1, machineId: 'local', reply: reply([message('r1', 4, 'the installer', 5), thread('r2', 'Installer QA')], { message: { count: 1, exact: true }, thread: { count: 1, exact: true } }) });
  assert.deepEqual(view.groups.map((g) => g.kind), ['thread', 'message']);
});

test('three rows show, the rest wait behind Show all', () => {
  assert.equal(ROWS_PER_GROUP, 3);
  let view = started();
  const hits = [1, 2, 3, 4, 5, 6].map((n) => message('r1', n, `installer ${n}`, n));
  view = reduceSearch(view, { type: 'reply', run: 1, machineId: 'local', reply: reply(hits, { message: { count: 6, exact: true } }) });
  const group = view.groups[0];
  assert.equal(shownRows(group, new Set()).length, 3);
  assert.equal(shownRows(group, new Set(['message'])).length, 6);
  assert.equal(showMoreLabel(group), 'Show all 6');
  // Newest first.
  assert.deepEqual(group.hits.map((h) => h.at), [6, 5, 4, 3, 2, 1]);
});

test('an inexact total says Show more', () => {
  let view = started();
  const hits = [1, 2, 3, 4].map((n) => message('r1', n, `installer ${n}`, n));
  view = reduceSearch(view, { type: 'reply', run: 1, machineId: 'local', reply: reply(hits, { message: { count: 4, exact: false } }) });
  assert.equal(showMoreLabel(view.groups[0]), 'Show more');
});

test('the same room id on two machines stays two hits', () => {
  let view = started();
  for (const id of ['local', 'vps']) view = reduceSearch(view, { type: 'reply', run: 1, machineId: id, reply: reply([thread('r1', 'Installer QA')], { thread: { count: 1, exact: true } }) });
  const group = view.groups[0];
  assert.equal(group.hits.length, 2);
  assert.equal(group.total, 2);
  assert.notEqual(group.hits[0].key, group.hits[1].key);
  assert.deepEqual(group.hits.map((h) => h.machineName).sort(), ['Hetzner', 'MacBook Pro']);
});

test('an answer for an older query is dropped', () => {
  let view = started();
  view = reduceSearch(view, { type: 'start', run: 2, query: 'installers', machines, kinds: ['message'] });
  const after = reduceSearch(view, { type: 'reply', run: 1, machineId: 'local', reply: reply([message('r1', 1, 'installer', 1)], { message: { count: 1, exact: true } }) });
  assert.equal(after, view);
});

test('a Busy answer is dropped and the machine keeps searching', () => {
  const view = started();
  const after = reduceSearch(view, { type: 'reply', run: 1, machineId: 'local', reply: reply([], {}, [{ source: 'content', reason: 'busy' }]) });
  assert.equal(after, view);
  assert.equal(after.machines[0].state, 'searching');
});

test('each machine state has its own line', () => {
  let view = started('installer', [...machines, { id: 'old', name: 'Old box', offline: true }]);
  assert.deepEqual(view.machines.map((m) => m.state), ['searching', 'searching', 'offline']);
  view = reduceSearch(view, { type: 'reply', run: 1, machineId: 'local', reply: reply([]) });
  view = reduceSearch(view, { type: 'failed', run: 1, machineId: 'vps', state: 'needs_update' });
  assert.deepEqual(view.machines.map((m) => m.state), ['ok', 'needs_update', 'offline']);
  assert.equal(machineLine({ id: 'x', name: 'Hetzner', state: 'offline' }), 'Hetzner is offline · not searched');
  assert.equal(machineLine({ id: 'x', name: 'Hetzner', state: 'needs_update' }), 'Hetzner needs an update before it can be searched');
  assert.equal(machineLine({ id: 'x', name: 'Hetzner', state: 'needs_pairing' }), 'Hetzner needs pairing to search');
  assert.equal(machineLine({ id: 'x', name: 'Hetzner', state: 'refused' }), 'Hetzner refused the search');
  assert.equal(machineLine({ id: 'x', name: 'Hetzner', state: 'ok' }), null);
});

test('skipped sources and the 200 cap become notes', () => {
  let view = started();
  const many = Array.from({ length: 200 }, (_, n) => message('r1', n, `installer ${n}`, n));
  view = reduceSearch(view, { type: 'reply', run: 1, machineId: 'local', reply: reply(many, { message: { count: 950, exact: true } },
    [{ source: '/a', reason: 'missing_folder' }, { source: '/b', reason: 'missing_folder' }, { source: 'r9', reason: 'being_written' }]) });
  assert.ok(view.notes.includes('Showing the first 200. Add a word to narrow it.'));
  assert.ok(view.notes.includes('2 projects skipped: folder missing'));
  assert.ok(view.notes.includes('1 thread skipped: it was being saved'));
});

test('a later answer for one kind replaces only that kind on that machine', () => {
  let view = started();
  view = reduceSearch(view, { type: 'reply', run: 1, machineId: 'local', reply: reply([thread('r2', 'Installer QA'), message('r1', 1, 'installer', 1)], { thread: { count: 1, exact: true }, message: { count: 9, exact: true } }) });
  view = reduceSearch(view, { type: 'reply', run: 1, machineId: 'local', kinds: ['message'], reply: reply([message('r1', 1, 'installer', 1), message('r1', 2, 'installer again', 2)], { message: { count: 9, exact: true } }) });
  assert.equal(view.groups.find((g) => g.kind === 'thread').hits.length, 1);
  assert.equal(view.groups.find((g) => g.kind === 'message').hits.length, 2);
});

// ---- The fan-out ----

function port(script) {
  const calls = [];
  return { calls, supports: (cap) => script.supports !== false && cap === 'search_v1', call: async (cmd, args) => { calls.push(cmd); return script.call(cmd, args, calls); } };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));
function harness(ports, list = machines) {
  const views = [];
  const search = createSearch({ machines: () => list, portOf: (id) => ports[id] ?? null, settings: () => [], onView: (v) => views.push(v), delayMs: 0 });
  return { search, views, last: () => views[views.length - 1] };
}

test('one open per machine, then one search per machine', async () => {
  const ok = () => port({ call: async (cmd) => cmd === 'search_open' ? { ttlMs: 1 } : reply([thread('r1', 'Installer QA')], { thread: { count: 1, exact: true } }) });
  const ports = { local: ok(), vps: ok() };
  const h = harness(ports);
  h.search.setQuery('installer');
  await settle(); await settle();
  h.search.setQuery('installer qa');
  await settle(); await settle();
  assert.deepEqual(ports.local.calls, ['search_open', 'search', 'search']);
  assert.deepEqual(h.last().machines.map((m) => m.state), ['ok', 'ok']);
  assert.equal(h.last().groups[0].hits.length, 2);
});

test('a refused search re-opens once and retries once, never a loop', async () => {
  let searches = 0;
  const flaky = port({ call: async (cmd) => { if (cmd === 'search_open') return { ttlMs: 1 }; searches += 1; if (searches === 1) throw new Error(SEARCH_REFUSED); return reply([]); } });
  const h = harness({ local: flaky }, [machines[0]]);
  h.search.setQuery('installer');
  await settle(); await settle();
  assert.deepEqual(flaky.calls, ['search_open', 'search', 'search_open', 'search']);
  assert.equal(h.last().machines[0].state, 'ok');

  const stuck = port({ call: async (cmd) => { if (cmd === 'search_open') return { ttlMs: 1 }; throw new Error(SEARCH_REFUSED); } });
  const g = harness({ local: stuck }, [machines[0]]);
  g.search.setQuery('installer');
  await settle(); await settle();
  assert.deepEqual(stuck.calls, ['search_open', 'search', 'search_open', 'search']);
  assert.equal(g.last().machines[0].state, 'refused');
});

test('pairing, update and offline answers set the machine state', async () => {
  const ports = {
    pair: port({ call: async () => { throw new Error(SEARCH_NEEDS_PAIRING); } }),
    old: port({ supports: false, call: async () => { throw new Error('never asked'); } }),
    older: port({ call: async () => { throw new Error('unknown variant `search_open`, expected one of'); } }),
    gone: port({ call: async () => { throw new Error('Hetzner is not connected'); } }),
  };
  const list = [{ id: 'pair', name: 'A', offline: false }, { id: 'old', name: 'B', offline: false }, { id: 'older', name: 'C', offline: false }, { id: 'gone', name: 'D', offline: false }, { id: 'none', name: 'E', offline: false }];
  const h = harness(ports, list);
  h.search.setQuery('installer');
  await settle(); await settle();
  assert.deepEqual(h.last().machines.map((m) => m.state), ['needs_pairing', 'needs_update', 'needs_update', 'offline', 'offline']);
  assert.deepEqual(ports.old.calls, []);
});

test('Retry asks only that machine again', async () => {
  let up = false;
  const ports = {
    local: port({ call: async (cmd) => cmd === 'search_open' ? { ttlMs: 1 } : reply([]) }),
    vps: port({ call: async (cmd) => { if (!up) throw new Error('timed out'); return cmd === 'search_open' ? { ttlMs: 1 } : reply([thread('r1', 'Installer QA')], { thread: { count: 1, exact: true } }); } }),
  };
  const h = harness(ports);
  h.search.setQuery('installer');
  await settle(); await settle();
  assert.equal(h.last().machines[1].state, 'offline');
  const before = ports.local.calls.length;
  up = true;
  h.search.retry('vps');
  await settle(); await settle();
  assert.equal(ports.local.calls.length, before);
  assert.equal(h.last().machines[1].state, 'ok');
  assert.equal(h.last().groups[0].hits.length, 1);
});

test('a query under two characters asks no machine and clears the view', async () => {
  const p = port({ call: async () => reply([]) });
  const h = harness({ local: p }, [machines[0]]);
  h.search.setQuery('i');
  await settle();
  assert.deepEqual(p.calls, []);
  assert.equal(h.last().query, '');
});

test('settings match locally, before any machine answers', async () => {
  const views = [];
  const never = port({ call: () => new Promise(() => {}) });
  const search = createSearch({ machines: () => [machines[0]], portOf: () => never, onView: (v) => views.push(v), delayMs: 0,
    settings: (q) => q === 'voice' ? [{ id: 'voice', label: 'Voice', section: 'voice', sectionLabel: 'Voice' }] : [] });
  search.setQuery('voice');
  await settle();
  const view = views[views.length - 1];
  assert.equal(view.groups[0].kind, 'setting');
  assert.equal(view.groups[0].hits[0].title, 'Voice');
  assert.equal(view.machines[0].state, 'searching');
});

test('Show all asks that machine for up to 200 of one kind', async () => {
  const asked = [];
  const p = port({ call: async (cmd, args) => { if (cmd === 'search_open') return { ttlMs: 1 }; asked.push(args);
    const n = args.limit === 200 ? 30 : 20;
    return reply(Array.from({ length: n }, (_, i) => message('r1', i, `installer ${i}`, i)), { message: { count: 30, exact: true } }); } });
  const h = harness({ local: p }, [machines[0]]);
  h.search.setQuery('installer');
  await settle(); await settle();
  assert.equal(h.last().groups[0].hits.length, 20);
  h.search.expand('message');
  await settle(); await settle();
  assert.deepEqual(asked[1].kinds, ['message']);
  assert.equal(asked[1].limit, 200);
  assert.equal(h.last().groups[0].hits.length, 30);
});

// ---- Recents ----

test('recent searches and places keep five, newest first, and can be cleared', () => {
  let list = [];
  for (const word of ['a1', 'b2', 'c3', 'd4', 'e5', 'f6', 'b2']) list = pushRecent(list, word, (x) => x);
  assert.deepEqual(list, ['b2', 'f6', 'e5', 'd4', 'c3']);
  const store = new Map();
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) };
  saveRecents(storage, { searches: list, places: [{ key: 'local:thread:r1', title: 'Installer QA', kind: 'thread', machineId: 'local', target: { type: 'room', room: 'r1', roomKind: 'work' } }] });
  const back = loadRecents(storage);
  assert.deepEqual(back.searches, list);
  assert.equal(back.places[0].title, 'Installer QA');
  store.set([...store.keys()][0], '{not json');
  assert.deepEqual(loadRecents(storage), { searches: [], places: [] });
});

// ---- Query and exact jumps ----

test('the query matches as the daemon does', () => {
  assert.equal(queryMatches(parseQuery('clean installer'), 'Try the INSTALLER on a clean Mac'), true);
  assert.equal(queryMatches(parseQuery('"clean installer"'), 'Try the installer on a clean Mac'), false);
  assert.equal(queryMatches(parseQuery('"installer on"'), 'Try the installer on a clean Mac'), true);
  assert.equal(queryMatches(parseQuery('ÉCOLE'), 'une école'), true);
  assert.equal(parseQuery('i'), null);
});

const said = (seq, text, extra = {}) => ({ seq, text, speaker: { kind: 'human' }, ...extra });
const bot = (seq, text, extra = {}) => ({ seq, text, speaker: { kind: 'bot', id: 'null', name: 'Null' }, ...extra });

test('duplicate_phrase_lands_on_the_clicked_one', () => {
  const messages = [said(0, 'run the installer', { clientMessageId: 'a' }), bot(1, 'ok'), said(2, 'run the installer', { clientMessageId: 'b' })];
  assert.deepEqual(resolveMessage(messages, { type: 'message', room: 'r', roomKind: 'work', seq: 2, originSeq: null, clientMessageId: 'b', speaker: 'You' }), { seq: 2 });
  assert.deepEqual(resolveMessage(messages, { type: 'message', room: 'r', roomKind: 'work', seq: 0, originSeq: null, clientMessageId: 'a', speaker: 'You' }), { seq: 0 });
});

test('curated_thread_resolves_by_origin_seq', () => {
  // The thread was tidied: the message that was at 7 now sits at 3.
  const messages = [said(0, 'hello'), bot(1, 'the installer is ready', { originSeq: 4 }), said(2, 'thanks'), bot(3, 'try the installer', { originSeq: 7 })];
  assert.deepEqual(resolveMessage(messages, { type: 'message', room: 'r', roomKind: 'work', seq: 7, originSeq: 7, clientMessageId: null, speaker: 'Null' }), { seq: 3 });
});

test('deleting one of two identical project replies from the same agent never selects its replacement', () => {
  const text = 'try the installer';
  const [first, second] = [bot(0, text, { originSeq: 8 }), bot(1, text, { originSeq: 9 })];
  const target = { type: 'message', room: 'r', roomKind: 'work', seq: 0, originSeq: first.originSeq, clientMessageId: null, speaker: 'Null' };
  const remaining = [{ ...second, seq: 0 }];
  assert.deepEqual(resolveMessage(remaining, target), { changed: true });
  assert.deepEqual(resolveMessage(remaining, { ...target, seq: 1, originSeq: second.originSeq }), { seq: 0 });
  // For older snapshots even a unique remaining match cannot prove identity.
  assert.deepEqual(resolveMessage([bot(0, text)], { ...target, originSeq: null }), { changed: true });
});

test('a client ID paired with a different origin cannot verify the reply', () => {
  const messages = [said(0, 'try the installer', { clientMessageId: 'a', originSeq: 5 })];
  const target = { type: 'message', room: 'r', roomKind: 'work', seq: 0, clientMessageId: 'a', originSeq: 4, speaker: 'You' };
  assert.deepEqual(resolveMessage(messages, target), { changed: true });
});

test('deleted_message_reports_changed', () => {
  const messages = [said(0, 'hello'), bot(1, 'nothing here')];
  assert.deepEqual(resolveMessage(messages, { type: 'message', room: 'r', roomKind: 'work', seq: 1, originSeq: null, clientMessageId: null, speaker: 'Null' }), { changed: true });
  assert.deepEqual(resolveMessage(messages, { type: 'message', room: 'r', roomKind: 'work', seq: 9, originSeq: 9, clientMessageId: 'gone', speaker: 'Null' }), { changed: true });
  // Two candidates share a client id (a prompt and its reply never do, but a merge can): never guess.
  const twins = [said(0, 'the installer', { clientMessageId: 'x' }), said(1, 'the installer', { clientMessageId: 'x' })];
  assert.deepEqual(resolveMessage(twins, { type: 'message', room: 'r', roomKind: 'work', seq: 5, originSeq: null, clientMessageId: 'x', speaker: 'You' }), { changed: true });
});

// ---- Review round 2 (Null, 2026-11-22) ----

test('a_saved_id_that_is_gone_never_falls_back_to_the_old_position', () => {
  // The hit was deleted; another agent's reply with the same word now sits at its old position.
  const messages = [said(0, 'hello'), { seq: 1, text: 'try the installer', speaker: { kind: 'bot', id: 'jigga' } }];
  const target = { type: 'message', room: 'r', roomKind: 'chat', seq: 1, clientMessageId: null, originSeq: null, speaker: 'Null' };
  assert.deepEqual(resolveMessage(messages, { ...target, originSeq: 7 }), { changed: true });
  assert.deepEqual(resolveMessage(messages, { ...target, clientMessageId: 'gone' }), { changed: true });
  const mine = [said(0, 'run the installer')];
  assert.deepEqual(resolveMessage(mine, { ...target, seq: 0, clientMessageId: 'gone', speaker: 'You' }), { changed: true });
});

function gate() { let open; const wait = new Promise((resolve) => { open = resolve; }); return { wait, open }; }

test('an_older_query_never_searches_after_a_newer_one_started', async () => {
  const opens = [gate(), gate()];
  const searched = [];
  let n = 0;
  const p = port({ call: async (cmd, args) => { if (cmd === 'search_open') { await opens[n++].wait; return { ttlMs: 1 }; } if (cmd === 'search') searched.push(args.query); return reply([]); } });
  const h = harness({ local: p }, [machines[0]]);
  h.search.setQuery('inst');
  h.search.setQuery('installer');
  // The newer query's grant arrives first, the older one's last.
  opens[1].open(); await settle();
  opens[0].open(); await settle();
  assert.deepEqual(searched, ['installer']);
  assert.equal(h.last().machines[0].state, 'ok');
});

test('a_grant_that_arrives_after_the_panel_closed_starts_no_search', async () => {
  const open = gate();
  const p = port({ call: async (cmd) => { if (cmd === 'search_open') { await open.wait; return { ttlMs: 1 }; } return reply([]); } });
  const h = harness({ local: p }, [machines[0]]);
  h.search.setQuery('installer');
  h.search.close();
  open.open(); await settle();
  assert.deepEqual(p.calls, ['search_open']);
});

test('an_older_query_does_not_retry_after_a_refusal', async () => {
  const first = gate();
  let searches = 0;
  const p = port({ call: async (cmd) => { if (cmd === 'search_open') return { ttlMs: 1 }; searches += 1; if (searches === 1) { await first.wait; throw new Error(SEARCH_REFUSED); } return reply([]); } });
  const h = harness({ local: p }, [machines[0]]);
  h.search.setQuery('inst'); await settle();
  h.search.setQuery('installer'); await settle();
  first.open(); await settle();
  // The older query's refusal must not open or search again.
  assert.deepEqual(p.calls, ['search_open', 'search', 'search']);
  assert.equal(h.last().machines[0].state, 'ok');
});

test('assistant_conversation_hits_are_hidden', () => {
  const assistant = (seq) => message('conv-1', seq, 'run the installer', null, { roomKind: 'assistant', clientMessageId: 'ask-1' });
  // Everything the machine holds came back: the count is what is left.
  let view = reduceSearch(started(), { type: 'reply', run: 1, machineId: 'local', reply: reply([message('r1', 0, 'installer', 5), assistant(0), assistant(1)], { message: { count: 3, exact: true } }) });
  let group = view.groups.find((g) => g.kind === 'message');
  assert.deepEqual(group.hits.map((h) => h.target.room), ['r1']);
  assert.deepEqual([group.total, group.exact], [1, true]);
  // More is held than was sent: how much of the rest is Assistant text is unknown.
  view = reduceSearch(started(), { type: 'reply', run: 1, machineId: 'local', reply: reply([message('r1', 0, 'installer', 5), assistant(0)], { message: { count: 9, exact: true } }) });
  group = view.groups.find((g) => g.kind === 'message');
  assert.deepEqual([group.hits.length, group.total, group.exact], [1, 8, false]);
  // Only Assistant hits: no Messages group at all.
  view = reduceSearch(started(), { type: 'reply', run: 1, machineId: 'local', reply: reply([assistant(0)], { message: { count: 1, exact: true } }) });
  assert.equal(view.groups.find((g) => g.kind === 'message'), undefined);
  assert.equal(view.machines[0].state, 'ok');
});
