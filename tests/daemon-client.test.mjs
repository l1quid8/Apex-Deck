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

test('a refusal keeps the daemon\'s reason word on the error, for callers that switch on it', async () => {
  const { daemon, client } = await connected();
  const link = daemon.last();
  const a = client.call('pair_wait', { invitation: 'x' });
  const b = client.call('room_stop', { id: 't' });
  const [ra, rb] = link.sent.slice(1);
  link.receive({ id: ra.id, err: 'This pairing code expired. Start again.', reason: 'expired' });
  link.receive({ id: rb.id, err: 'no such room' });
  await assert.rejects(a, (e) => e instanceof Error && e.message === 'This pairing code expired. Start again.' && e.reason === 'expired');
  await assert.rejects(b, (e) => e instanceof Error && e.reason === undefined);
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

test('retryNow does not start a second dial while the first dial is pending', async () => {
  let finishDial;
  let attempts = 0;
  const daemon = fakeDaemon();
  const client = new DaemonClient(() => {
    attempts += 1;
    const pending = daemon.connect();
    return new Promise((resolve) => { finishDial = () => pending.then(resolve); });
  }, { timers: fakeTimers() });
  const started = client.start();
  client.retryNow();
  assert.equal(attempts, 1);

  finishDial();
  await tick();
  const link = daemon.last();
  link.receive({ id: link.sent[0].id, ok: welcome() });
  assert.equal((await started).host_id, 'h1');
  assert.equal(daemon.links.length, 1);
  client.close();
});

test('close invalidates and closes a dial that completes later', async () => {
  let finishDial;
  const daemon = fakeDaemon();
  const client = new DaemonClient(() => new Promise((resolve) => {
    daemon.connect().then((link) => { finishDial = () => resolve(link); });
  }), { timers: fakeTimers() });
  client.start();
  client.close();
  await tick();
  finishDial();
  await tick();
  assert.equal(daemon.last().closed, true);
  assert.equal(daemon.last().sent.length, 0, 'a closed client never sends hello on a late link');
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
  link.receive('Welcome to Ubuntu! (from ~/.bashrc)');
  assert.ok(link.closed);
  assert.equal(statuses.at(-1).kind, 'reconnecting');
  assert.equal(statuses.at(-1).reason, 'The host sent something that isn\'t part of the protocol: "Welcome to Ubuntu! (from ~/.bashrc)". A shell startup file there may be printing it.');
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

test('the welcome tells which apex-daemon version answered; an older helper does not say', async () => {
  const fresh = async (over) => {
    const daemon = fakeDaemon(); const client = new DaemonClient(daemon.connect, { timers: fakeTimers() });
    const started = client.start(); await tick();
    assert.equal(client.helperVersion, undefined, 'unknown before any welcome');
    daemon.last().receive({ id: daemon.last().sent[0].id, ok: welcome(over) });
    await started;
    return client.helperVersion;
  };
  assert.equal(await fresh({ version: '0.5.1' }), '0.5.1');
  assert.equal(await fresh({}), null);
});

test('capabilities are optional and missing features fail with an update instruction', async () => {
  const daemon = fakeDaemon(); const legacy = new DaemonClient(daemon.connect, { timers: fakeTimers() });
  const started = legacy.start(); await tick();
  daemon.last().receive({ id: daemon.last().sent[0].id, ok: welcome({ version: '0.6.4' }) });
  await started;
  assert.equal(legacy.helperVersion, '0.6.4');
  const ordinary = legacy.call('session_load');
  daemon.last().receive({ id: daemon.last().sent.at(-1).id, ok: { version: 1 } });
  assert.deepEqual(await ordinary, { version: 1 });
  assert.throws(() => legacy.requireCapability('assistant_delegation'), /does not advertise.*assistant delegation.*Update.*reconnect/i);
  legacy.close();
});

test('advertised capabilities work regardless of helper version', async () => {
  const daemon = fakeDaemon(); const client = new DaemonClient(daemon.connect, { timers: fakeTimers() });
  const started = client.start(); await tick();
  daemon.last().receive({ id: daemon.last().sent[0].id, ok: welcome({ version: '9.9.9-custom', capabilities: ['assistant_delegation'] }) });
  await started;
  assert.doesNotThrow(() => client.requireCapability('assistant_delegation'));
  client.close();
});


test('old hosts rejecting monitoring commands report an actionable compatibility error', async () => {
  const { client, daemon } = await connected();
  for (const command of ['monitor_get', 'monitor_assign', 'monitor_check_now']) {
    const pending = client.call(command, { workspaceId: 'project' });
    const check = assert.rejects(pending, /This host’s Apex Deck service does not support project monitoring.*Update.*reconnect/);
    daemon.last().receive({ id: daemon.last().sent.at(-1).id, err: `unknown variant \`${command}\`, expected one of \`session_load\`, \`session_save\`` });
    await check;
  }
  const pending = client.call('monitor_get');
  const check = assert.rejects(pending, /Permission denied/);
  daemon.last().receive({ id: daemon.last().sent.at(-1).id, err: 'Permission denied', reason: 'forbidden' });
  await check;
  client.close();
});
