import test from 'node:test';
import assert from 'node:assert/strict';
import { DaemonClient } from '../src/daemon/client.ts';

const tick = async () => { for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r)); };

/** Timers the test moves by hand. */
function fakeTimers() {
  let now = 1000; let next = 1; const pending = new Map();
  return {
    now: () => now,
    setTimeout(fn, ms) { const id = next++; pending.set(id, { fn, at: now + ms }); return id; },
    clearTimeout(id) { pending.delete(id); },
    pending: () => [...pending.values()].map(p => p.at - now),
    advance(ms) {
      now += ms;
      for (const [id, p] of [...pending]) if (p.at <= now) { pending.delete(id); p.fn(); }
    },
  };
}

/** Links the test plays the daemon on. `fail` makes the next connect reject. */
function fakeDaemon() {
  const links = [];
  const daemon = {
    links,
    fail: null,
    last: () => links.at(-1),
    connect: async () => {
      if (daemon.fail) { const why = daemon.fail; daemon.fail = null; throw new Error(why); }
      let lineCb = () => {}; let closeCb = () => {};
      const link = {
        sent: [], closed: false,
        send(line) { this.sent.push(JSON.parse(line)); },
        close() { this.closed = true; },
        onLine(cb) { lineCb = cb; },
        onClose(cb) { closeCb = cb; },
        receive(frame) { lineCb(typeof frame === 'string' ? frame : JSON.stringify(frame)); },
        drop(reason) { closeCb(reason); },
      };
      links.push(link);
      return link;
    },
  };
  return daemon;
}

const welcome = (over = {}) => ({ host_id: 'h1', boot_id: 'b1', protocol: 1, last_seq: 10, resumed: false, ...over });

/** A client past its first welcome. */
async function connected(options = {}) {
  const daemon = fakeDaemon(); const timers = fakeTimers();
  const client = new DaemonClient(daemon.connect, { timers, ...options });
  const statuses = []; client.onStatus(s => statuses.push(s));
  const started = client.start();
  await tick();
  const hello = daemon.last().sent[0];
  daemon.last().receive({ id: hello.id, ok: welcome() });
  const w = await started;
  return { daemon, timers, client, statuses, welcome: w };
}

test('start says hello first, sends nothing else until the welcome, and resolves with it', async () => {
  const daemon = fakeDaemon(); const timers = fakeTimers();
  const client = new DaemonClient(daemon.connect, { timers });
  const statuses = []; client.onStatus(s => statuses.push(s));
  assert.deepEqual(statuses, [{ kind: 'connecting' }]);
  const started = client.start();
  await tick();
  const link = daemon.last();
  assert.equal(link.sent.length, 1);
  assert.equal(link.sent[0].cmd, 'hello');
  assert.deepEqual(link.sent[0].args, { protocol: 1 });
  const early = client.call('session_load').catch(e => e.message);
  await tick();
  assert.equal(link.sent.length, 1, 'nothing goes out before the welcome');
  assert.equal(await early, 'Not connected to the host.');
  link.receive({ id: link.sent[0].id, ok: welcome() });
  assert.deepEqual(await started, welcome());
  assert.deepEqual(statuses.at(-1), { kind: 'connected', hostId: 'h1' });
});

test('calls carry increasing ids and are answered by id, in any order', async () => {
  const { daemon, client } = await connected();
  const link = daemon.last();
  const a = client.call('room_post', { id: 't', text: 'hi' });
  const b = client.call('session_load');
  const c = client.call('room_stop', { id: 't' });
  const [ra, rb, rc] = link.sent.slice(1);
  assert.deepEqual(ra, { id: ra.id, cmd: 'room_post', args: { id: 't', text: 'hi' } });
  assert.deepEqual(rb, { id: rb.id, cmd: 'session_load', args: {} });
  assert.ok(ra.id < rb.id && rb.id < rc.id);
  link.receive({ id: rc.id, err: 'no such room' });
  link.receive({ id: rb.id, ok: { version: 1 } });
  link.receive({ id: ra.id, ok: null });
  assert.equal(await a, null);
  assert.deepEqual(await b, { version: 1 });
  await assert.rejects(c, (e) => e instanceof Error && e.message === 'no such room');
});

test('events reach only their own listeners, and one already seen is dropped', async () => {
  const { daemon, client } = await connected();
  const rooms = []; const ptys = [];
  client.on('room-event', p => rooms.push(p));
  const off = client.on('pty-data', p => ptys.push(p));
  const link = daemon.last();
  link.receive({ seq: 11, event: 'room-event', payload: { room: 't', n: 1 } });
  link.receive({ seq: 12, event: 'pty-data', payload: { id: 'p', data: 'x' } });
  link.receive({ seq: 12, event: 'pty-data', payload: { id: 'p', data: 'again' } });
  link.receive({ seq: 9, event: 'room-event', payload: { room: 't', n: 0 } });
  off();
  link.receive({ seq: 13, event: 'pty-data', payload: { id: 'p', data: 'unheard' } });
  assert.deepEqual(rooms, [{ room: 't', n: 1 }]);
  assert.deepEqual(ptys, [{ id: 'p', data: 'x' }]);
});

test('a lost connection fails calls in flight with words, refuses new ones, and says it is reconnecting', async () => {
  const { daemon, client, statuses, timers } = await connected();
  const pending = client.call('room_post', { id: 't', text: 'hi' });
  daemon.last().drop('read ECONNRESET');
  await assert.rejects(pending, { message: 'The connection to the host was lost, so this may not have finished.' });
  await assert.rejects(client.call('session_load'), { message: 'Not connected to the host.' });
  assert.deepEqual(statuses.at(-1), { kind: 'reconnecting', attempt: 1, reason: 'read ECONNRESET', retryAt: timers.now() + 1000 });
});

test('reconnecting waits 1, 2, 4, 8, 16, then 30 s, and resumes where it left off', async () => {
  const { daemon, client, statuses, timers } = await connected();
  const heard = []; client.on('room-event', p => heard.push(p.n));
  daemon.last().receive({ seq: 11, event: 'room-event', payload: { n: 11 } });
  daemon.last().drop('gone');
  const waits = [];
  for (let attempt = 1; attempt <= 7; attempt++) {
    waits.push(timers.pending()[0]);
    const before = daemon.links.length;
    timers.advance(timers.pending()[0]);
    await tick();
    assert.equal(daemon.links.length, before + 1, `attempt ${attempt} connects`);
    if (attempt < 7) daemon.last().drop(`still gone ${attempt}`);
  }
  assert.deepEqual(waits, [1000, 2000, 4000, 8000, 16000, 30000, 30000]);
  const link = daemon.last();
  assert.deepEqual(link.sent[0].args, { protocol: 1, since: { boot_id: 'b1', seq: 11 } });
  link.receive({ id: link.sent[0].id, ok: welcome({ resumed: true, last_seq: 13 }) });
  link.receive({ seq: 11, event: 'room-event', payload: { n: 11 } });
  link.receive({ seq: 12, event: 'room-event', payload: { n: 12 } });
  link.receive({ seq: 13, event: 'room-event', payload: { n: 13 } });
  assert.deepEqual(heard, [11, 12, 13]);
  assert.deepEqual(statuses.at(-1), { kind: 'connected', hostId: 'h1' });
  // Back to the short wait after a good connection.
  link.drop('again');
  assert.equal(timers.pending()[0], 1000);
});

test('retryNow skips the wait', async () => {
  const { daemon, client, timers } = await connected();
  daemon.last().drop('gone');
  assert.equal(daemon.links.length, 1);
  client.retryNow();
  await tick();
  assert.equal(daemon.links.length, 2);
  assert.deepEqual(timers.pending(), []);
});

test('a welcome that does not resume after a drop asks for a resync', async () => {
  const { daemon, statuses, timers } = await connected();
  daemon.last().drop('gone');
  timers.advance(1000);
  await tick();
  const link = daemon.last();
  link.receive({ id: link.sent[0].id, ok: welcome({ boot_id: 'b2', resumed: false }) });
  assert.deepEqual(statuses.at(-1), { kind: 'resync' });
});

test('a different protocol or a refused hello fails without retrying, until asked', async () => {
  const daemon = fakeDaemon(); const timers = fakeTimers();
  const client = new DaemonClient(daemon.connect, { timers });
  const statuses = []; client.onStatus(s => statuses.push(s));
  const started = client.start();
  await tick();
  let link = daemon.last();
  link.receive({ id: link.sent[0].id, ok: welcome({ protocol: 2 }) });
  assert.equal(statuses.at(-1).kind, 'failed');
  assert.match(statuses.at(-1).reason, /protocol 2/);
  assert.ok(link.closed);
  assert.deepEqual(timers.pending(), []);
  client.retryNow();
  await tick();
  link = daemon.last();
  assert.equal(daemon.links.length, 2);
  link.receive({ id: link.sent[0].id, err: 'this daemon speaks protocol 1; the client asked for 3' });
  assert.deepEqual(statuses.at(-1), { kind: 'failed', reason: 'this daemon speaks protocol 1; the client asked for 3' });
  assert.deepEqual(timers.pending(), []);
  client.retryNow();
  await tick();
  link = daemon.last();
  link.receive({ id: link.sent[0].id, ok: welcome() });
  assert.equal((await started).host_id, 'h1');
});

test('start keeps trying through connections that close or fail before the welcome', async () => {
  const daemon = fakeDaemon(); const timers = fakeTimers();
  const client = new DaemonClient(daemon.connect, { timers });
  const statuses = []; client.onStatus(s => statuses.push(s));
  daemon.fail = 'connect ENOENT /data/daemon.sock';
  const started = client.start();
  await tick();
  assert.deepEqual(statuses.at(-1), { kind: 'reconnecting', attempt: 1, reason: 'connect ENOENT /data/daemon.sock', retryAt: timers.now() + 1000 });
  timers.advance(1000);
  await tick();
  daemon.last().drop('Permission denied (publickey).');
  assert.deepEqual(statuses.at(-1), { kind: 'reconnecting', attempt: 2, reason: 'Permission denied (publickey).', retryAt: timers.now() + 2000 });
  timers.advance(2000);
  await tick();
  const link = daemon.last();
  assert.deepEqual(link.sent[0].args, { protocol: 1 }, 'never connected, so nothing to resume');
  link.receive({ id: link.sent[0].id, ok: welcome() });
  assert.equal((await started).boot_id, 'b1');
  assert.deepEqual(statuses.at(-1), { kind: 'connected', hostId: 'h1' });
});

test('a line that is not JSON closes the link and reconnects', async () => {
  const { daemon, statuses, timers } = await connected();
  const link = daemon.last();
  link.receive('ssh: warning: something');
  assert.ok(link.closed);
  assert.equal(statuses.at(-1).kind, 'reconnecting');
  // The link's own close report afterwards changes nothing.
  link.drop('closed');
  assert.equal(statuses.at(-1).attempt, 1);
  timers.advance(1000);
  await tick();
  assert.equal(daemon.links.length, 2);
});

test('a connection-level error from the daemon is the reason shown when it closes', async () => {
  const { daemon, statuses } = await connected();
  daemon.last().receive({ id: null, err: 'resync: this connection fell 9000 events behind; reconnect and reload' });
  daemon.last().drop('closed');
  assert.equal(statuses.at(-1).reason, 'resync: this connection fell 9000 events behind; reconnect and reload');
});

test('close stops everything', async () => {
  const { daemon, client, timers } = await connected();
  const pending = client.call('session_load');
  client.close();
  assert.ok(daemon.last().closed);
  await assert.rejects(pending, /may not have finished/);
  daemon.last().drop('closed');
  assert.deepEqual(timers.pending(), []);
  await assert.rejects(client.call('session_load'), { message: 'Not connected to the host.' });
});
