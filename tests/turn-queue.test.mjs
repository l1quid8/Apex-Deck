import test from 'node:test';
import assert from 'node:assert/strict';
import { TurnQueue } from '../src/turnQueue.ts';
const tick = () => new Promise(r => setTimeout(r, 0));
test('queued messages wait, can be edited or removed, and run in order', async () => {
  let release; const sent = []; const snapshots = [];
  const q = new TurnQueue(async text => { sent.push(text); if (text === 'first') await new Promise(r => release = r); }, async () => {}, items => snapshots.push(items));
  q.send('first'); const second = q.send('second'); const third = q.send('third');
  q.edit(second, 'edited'); q.remove(third); assert.deepEqual(sent, ['first']);
  release(); await tick(); assert.deepEqual(sent, ['first', 'edited']); assert.deepEqual(snapshots.at(-1), []);
});
test('steer stops the active turn and takes priority without overlapping turns', async () => {
  let release; let active = 0; const sent = [];
  const q = new TurnQueue(async text => { assert.equal(active++, 0); sent.push(text); if(text === 'first') await new Promise(r => release = r); active--; }, async () => release(), () => {});
  q.send('first'); q.send('queued'); await q.steer('@other take over'); await tick();
  assert.deepEqual(sent, ['first', '@other take over', 'queued']);
});
test('a failed message pauses queued work and retains it', async () => {
  let reject; const errors=[];
  const q = new TurnQueue(() => new Promise((_, r) => reject=r), async()=>{}, ()=>{}, e=>errors.push(e));
  q.send('first'); q.send('later'); reject(new Error('offline')); await tick();
  assert.equal(q.items.length,1); assert.equal(q.items[0].text,'later'); assert.equal(errors.length,1);
});
test('a failed stop retains the steering message for retry', async () => {
  let release; const errors = [];
  const q = new TurnQueue(() => new Promise(r => release = r), async () => { throw new Error('stop failed'); }, () => {}, e => errors.push(e));
  q.send('first'); q.send('later'); await q.steer('@other take over');
  assert.deepEqual(q.items.map(item => item.text), ['@other take over', 'later']);
  assert.equal(q.paused, true); assert.equal(errors.length, 1);
  release(); await tick();
});

test('literal command text cannot become compaction without explicit kind', async () => {
  const sent = [];
  const q = new TurnQueue(async (text, kind) => sent.push({text,kind}), async()=>{}, ()=>{});
  q.paused = true;
  const id = q.send('/compact');
  q.send('/compact', 'compact');
  q.edit(id, '/clear');
  q.resume(); await tick();
  assert.deepEqual(sent, [{text:'/clear',kind:'message'}, {text:'/compact',kind:'compact'}]);
});

test('participant queues let idle Jigga start while Null works', async () => {
  const { ParticipantQueues } = await import('../src/turnQueue.ts');
  const sent = [];
  const q = new ParticipantQueues(async text => [text.includes('jigga') ? 'jigga' : 'null'], async (text, to) => sent.push({text,to}), async () => {}, () => {});
  await q.send('@null first'); await q.send('@null later'); await q.send('@jigga plan');
  assert.deepEqual(sent.map(x=>x.text), ['@null first', '@jigga plan']);
  q.idle('null'); await tick();
  assert.deepEqual(sent.map(x=>x.text), ['@null first', '@jigga plan', '@null later']);
});

test("a tag by a renamed bot's new name counts as a tag", async () => {
  const { queuedSticky } = await import('../src/turnQueue.ts');
  const people = [{ id: 'null', display_name: 'Null' }, { id: 'jigga', display_name: 'Atlas' }];
  const queued = [{ id: 1, text: '@null look', kind: 'message', to: ['null'] }];
  assert.equal(queuedSticky('@atlas and this', people, 'mention', queued), null);
  assert.deepEqual(queuedSticky('and this', people, 'mention', queued), ['null']);
});

test('an untagged message behind a queued tag follows that tag, as the desktop routes it', async () => {
  const { ParticipantQueues, queuedSticky } = await import('../src/turnQueue.ts');
  const people = [{ id: 'null', display_name: 'Null' }, { id: 'jigga', display_name: 'Jigga' }];
  const ids = people.map((p) => p.id);
  // The thread still remembers "@everyone": it hasn't heard the queued "@null" yet.
  const thread = async text => text.includes('@null') ? ['null'] : text.includes('@jigga') ? ['jigga'] : ids;
  const sent = [];
  let q;
  q = new ParticipantQueues(async text => queuedSticky(text, people, 'mention', q.items) ?? thread(text), async (text, to) => sent.push({text,to}), async () => {}, () => {});
  await q.send('@everyone review this');
  await q.send('@null also the tests'); await q.send('and the docs');
  assert.deepEqual(q.items.map(x => x.to), [['null'], ['null']]);
  await q.send('@jigga plan'); assert.deepEqual(q.items.at(-1).to, ['jigga'], 'a typed tag still wins');
});

test('steering and stopping Null preserve Jigga and its queue', async () => {
  const { ParticipantQueues } = await import('../src/turnQueue.ts');
  const sent = [], stops = [];
  let q;
  q = new ParticipantQueues(async text => [text.includes('jigga') ? 'jigga' : 'null'], async text => {sent.push(text)}, async id => {stops.push(id); q.idle(id)}, () => {});
  await q.send('@null first'); await q.send('@jigga first'); await q.send('@jigga later');
  await q.steer('null', '@null steer'); await tick();
  assert.deepEqual(stops, ['null']); assert.equal(q.state.jigga, 'working');
  assert.equal(q.items[0].text, '@jigga later'); assert.ok(sent.includes('@null steer'));
  await q.halt('null'); assert.equal(q.items[0].text, '@jigga later');
});

test('failure pauses only the failed participant', async () => {
  const { ParticipantQueues } = await import('../src/turnQueue.ts');
  const sent = [];
  const q = new ParticipantQueues(async text => [text.includes('jigga') ? 'jigga' : 'null'], async text => {sent.push(text); if(text==='@null fail') throw Error('offline')}, async()=>{}, ()=>{});
  await q.send('@null fail'); await q.send('@null later'); await q.send('@jigga plan');
  assert.deepEqual(sent, ['@null fail', '@jigga plan']); assert.equal(q.items.length, 2); assert.equal(q.items[0].failed, true);
});

test('compaction waits for all models and blocks new participant turns until settled', async () => {
  const { ParticipantQueues } = await import('../src/turnQueue.ts');
  const sent = []; let release;
  const q = new ParticipantQueues(async text => [text.includes('jigga') ? 'jigga' : 'null'], async (text, _to, kind) => { sent.push(text); if(kind==='compact') await new Promise(r=>release=r); }, async()=>{}, ()=>{});
  await q.send('@null first'); await q.send('/compact','compact');
  q.idle('null'); await tick();
  await q.send('@jigga later'); assert.deepEqual(sent, ['@null first', '/compact']);
  release(); await tick(); assert.deepEqual(sent, ['@null first', '/compact', '@jigga later']);
});

for (const kind of ['compact', 'curate']) {
  test(`a message removed during ${kind} is never dispatched`, async () => {
    const { ParticipantQueues } = await import('../src/turnQueue.ts');
    const sent = []; let release;
    const pending = new Promise(resolve => { release = resolve; });
    const q = new ParticipantQueues(async text => [text.startsWith('@jigga') ? 'jigga' : 'null'], async (text, _to, action) => {
      sent.push(text);
      if (action === kind) await pending;
    }, async () => {}, () => {});
    q.started('blocker');
    await q.send(`/${kind}`, kind);
    const id = await q.send('@jigga remove me');
    q.idle('blocker'); await tick();
    assert.deepEqual(sent, [`/${kind}`]);
    q.remove(id);
    release(); await tick();
    assert.deepEqual(sent, [`/${kind}`]);
    assert.deepEqual(q.items, []);
  });

  test(`a message edited during ${kind} dispatches its latest text and recipients once`, async () => {
    const { ParticipantQueues } = await import('../src/turnQueue.ts');
    const sent = []; let release;
    const pending = new Promise(resolve => { release = resolve; });
    const q = new ParticipantQueues(async text => [text.startsWith('@jigga') ? 'jigga' : text.startsWith('@forge') ? 'forge' : 'null'], async (text, to, action) => {
      sent.push({text, to, kind: action});
      if (action === kind) await pending;
    }, async () => {}, () => {});
    q.started('blocker');
    await q.send(`/${kind}`, kind);
    const id = await q.send('@jigga original');
    q.idle('blocker'); await tick();
    assert.equal(sent.length, 1);
    await q.edit(id, '@forge edited');
    release(); await tick();
    assert.deepEqual(sent, [
      {text: `/${kind}`, to: ['null'], kind},
      {text: '@forge edited', to: ['forge'], kind: 'message'},
    ]);
    assert.deepEqual(q.items, []);
  });

  test(`a failed ${kind} blocks messages already queued until explicit retry`, async () => {
    const { ParticipantQueues } = await import('../src/turnQueue.ts');
    const sent = [], errors = []; let reject, fail = true;
    const pending = new Promise((_, rejectJob) => { reject = rejectJob; });
    const q = new ParticipantQueues(async text => [text.startsWith('@jigga') ? 'jigga' : 'null'], async (text, _to, action) => {
      sent.push(text);
      if (action === kind && fail) {
        try { await pending; }
        finally { q.idle('null'); }
      }
    }, async () => {}, () => {}, error => errors.push(error));
    q.started('blocker');
    const id = await q.send(`/${kind}`, kind);
    const later = await q.send('@jigga later');
    q.idle('blocker'); await tick();
    assert.deepEqual(sent, [`/${kind}`]);
    reject(Error('context job refused')); await tick();
    assert.deepEqual(sent, [`/${kind}`]);
    assert.deepEqual(q.items.map(item => item.id), [id, later]);
    assert.equal(q.items[0].failed, true);
    assert.equal(errors.length, 1);
    q.resume(); await tick();
    assert.deepEqual(sent, [`/${kind}`], 'Resume cannot retry an uncertain command');
    fail = false; q.retry(id); await tick();
    assert.deepEqual(sent, [`/${kind}`, `/${kind}`, '@jigga later']);
    assert.deepEqual(q.items, []);
  });
}

for (const kind of ['curate', 'curate_undo']) {
  test(`${kind} waits for every bot, blocks later turns, and releases its reservation on reply`, async () => {
    const { ParticipantQueues } = await import('../src/turnQueue.ts');
    const sent = []; let release;
    const pending = new Promise(resolve => { release = resolve; });
    const q = new ParticipantQueues(async text => [text.startsWith('@third') ? 'third' : 'null'], async (text, _to, action) => {
      sent.push(text);
      if (action === kind) await pending;
    }, async () => {}, () => {});
    q.started('jigga');
    const accepted = q.send('/curate', kind);
    await tick();
    assert.deepEqual(sent, [], 'a different active bot must still block the whole-room job');
    await accepted;
    await q.send('@third later');
    assert.deepEqual(sent, [], 'a different active bot must still block the whole-room job');
    q.idle('jigga'); await tick();
    assert.deepEqual(sent, ['/curate']);
    release(); await tick();
    assert.deepEqual(sent, ['/curate', '@third later']);
    assert.equal(q.state.null, 'idle', 'the command reply releases the reservation without a participant event');
  });

  test(`a failed ${kind} blocks later bots until explicitly retried`, async () => {
    const { ParticipantQueues } = await import('../src/turnQueue.ts');
    let fail = true; const sent = [];
    const q = new ParticipantQueues(async text => [text.startsWith('@third') ? 'third' : 'null'], async (text, _to, action) => {
      if (action === kind && fail) throw Error('curation refused');
      sent.push(text);
    }, async () => {}, () => {}, () => {});
    const id = await q.send('/curate', kind);
    await q.send('@third later');
    assert.deepEqual(sent, []);
    assert.equal(q.items[0].failed, true);
    fail = false; q.retry(id); await tick();
    assert.deepEqual(sent, ['/curate', '@third later']);
  });
}

test('wholeRoom identifies only context-changing queue jobs', async () => {
  const { wholeRoom } = await import('../src/turnQueue.ts');
  assert.equal(typeof wholeRoom, 'function');
  for (const kind of ['compact', 'curate', 'curate_undo']) assert.equal(wholeRoom(kind), true);
  for (const kind of ['message', 'turn']) assert.equal(wholeRoom(kind), false);
});

test('trying again runs the failed bot first, then what was queued for it', async () => {
  const { ParticipantQueues } = await import('../src/turnQueue.ts');
  const sent = [];
  const q = new ParticipantQueues(async () => ['null'], async (text, _to, kind, hops) => { sent.push({ text, kind, hops }); }, async () => {}, () => {});
  await q.send('@null first');
  q.error('null'); q.idle('null');
  await q.send('@null later');
  assert.deepEqual(sent.map(s => s.text), ['@null first'], 'the failure paused Null');
  q.turn(['null'], null); await tick();
  assert.deepEqual(sent.slice(1), [{ text: '', kind: 'turn', hops: null }]);
  q.idle('null'); await tick();
  assert.deepEqual(sent.map(s => s.text), ['@null first', '', '@null later']);
});

test('a turn for several bots waits until every one is free, then posts once', async () => {
  const { ParticipantQueues } = await import('../src/turnQueue.ts');
  const sent = [];
  const q = new ParticipantQueues(async text => [text.includes('jigga') ? 'jigga' : 'null'], async (_text, to, kind, hops) => { sent.push({ to, kind, hops }); }, async () => {}, () => {});
  await q.send('@jigga plan');
  q.turn(['null', 'jigga'], 0); await tick();
  assert.deepEqual(sent.map(s => s.kind), ['message']);
  q.idle('jigga'); await tick();
  assert.deepEqual(sent.at(-1), { to: ['null', 'jigga'], kind: 'turn', hops: 0 });
});

test('steering a queued message stops every bot it is for and sends it once, ahead of the rest', async () => {
  const { ParticipantQueues } = await import('../src/turnQueue.ts');
  const sent = [], stops = [];
  let q;
  q = new ParticipantQueues(async text => text.includes('@all') ? ['jigga', 'null'] : [text.includes('jigga') ? 'jigga' : 'null'], async text => {sent.push(text)}, async id => {stops.push(id); q.idle(id)}, () => {});
  await q.send('@jigga first'); await q.send('@null first'); await q.send('@jigga later'); const id = await q.send('@all both');
  await q.steerQueued(id); await tick();
  assert.deepEqual(stops.sort(), ['jigga', 'null']);
  assert.equal(sent.filter(text => text === '@all both').length, 1);
  assert.equal(sent.at(-1), '@all both'); assert.equal(q.items[0].text, '@jigga later');
});

test('a new message after Stop goes straight out; queued ones still wait', async () => {
  const { ParticipantQueues } = await import('../src/turnQueue.ts');
  const sent = [];
  const q = new ParticipantQueues(async text => [text.includes('jigga') ? 'jigga' : 'null'], async text => { sent.push(text); }, async () => {}, () => {});
  q.started('null'); await q.send('@null queued'); await q.halt(); q.idle('null'); await tick();
  assert.deepEqual(sent, []); assert.equal(q.items.length, 1);
  q.remove(q.items[0].id); q.started('jigga'); await q.halt(); q.idle('jigga');
  await q.send('@jigga fresh'); await tick();
  assert.deepEqual(sent, ['@jigga fresh']);
});

test('a next step goes to exactly the bot that suggested it, without working out targets', async () => {
  const { ParticipantQueues } = await import('../src/turnQueue.ts');
  const sent = []; let asked = 0;
  const q = new ParticipantQueues(async () => { asked++; return ['null']; }, async (text, to, kind) => { sent.push({ text, to, kind }); }, async () => {}, () => {});
  await q.sendTo('commit it', ['jigga']);
  assert.deepEqual(sent, [{ text: 'commit it', to: ['jigga'], kind: 'message' }]);
  assert.equal(asked, 0);
});

test('failed dispatch retains serialized attachments and context without retrying an uncertain post', async () => {
  const { ParticipantQueues } = await import('../src/turnQueue.ts');
  let calls = 0;
  const q = new ParticipantQueues(async () => ['null'], async () => { calls++; throw Error('receipt lost'); }, async () => {}, () => {});
  const text = '> quoted context\n\nimportant prompt\nAttached image: /saved/picture.png';
  await q.send(text);
  assert.equal(q.items[0]?.text, text);
  assert.equal(q.items[0]?.failed, true);
  q.resume(); q.idle('null'); await tick();
  assert.equal(calls, 1);
});

test('recipient idle releases accepted Auto preparation canceled before turn_started', async () => {
  const { ParticipantQueues } = await import('../src/turnQueue.ts');
  const sent = [];
  const q = new ParticipantQueues(async () => ['null'], async text => sent.push(text), async () => {}, () => {});
  await q.send('first'); await q.halt();
  q.idle('null'); q.roomIdle();
  await q.send('next');
  assert.deepEqual(sent, ['first', 'next']);
});

test('old room idle preserves the next multi-recipient reservation', async () => {
  const { ParticipantQueues } = await import('../src/turnQueue.ts');
  const q = new ParticipantQueues(async () => ['null', 'jigga'], async () => {}, async () => {}, () => {});
  q.started('null'); q.started('jigga'); await q.send('next');
  q.idle('null'); q.idle('jigga'); q.roomIdle(); await tick();
  assert.equal(q.state.null, 'working'); assert.equal(q.state.jigga, 'working');
});

test('later failed queued messages retain their context and require an explicit retry', async () => {
  const { ParticipantQueues } = await import('../src/turnQueue.ts');
  const sent = []; let fail = true;
  const q = new ParticipantQueues(async () => ['null'], async text => { sent.push(text); if (text === 'later with attachments' && fail) throw Error('lost receipt'); }, async () => {}, () => {});
  await q.send('first');
  const id = await q.send('later with attachments');
  q.idle('null'); await tick();
  assert.equal(q.items[0].id, id); assert.equal(q.items[0].failed, true);
  q.resume(); await tick(); assert.equal(sent.length, 2);
  fail = false; q.retry(id); await tick();
  assert.deepEqual(sent, ['first', 'later with attachments', 'later with attachments']);
  assert.deepEqual(q.items, []);
});

test('a failed transient turn cannot hide a blocking item ahead of the next message', async () => {
  const { ParticipantQueues } = await import('../src/turnQueue.ts');
  const sent = [];
  const q = new ParticipantQueues(async () => ['null'], async (text, _to, kind) => {
    if (kind === 'turn') throw Error('turn refused');
    sent.push(text);
  }, async () => {}, () => {});
  q.turn(['null'], 1);
  await tick();
  await q.send('next human message');
  q.resume();
  await tick();
  assert.deepEqual(sent, ['next human message']);
  assert.deepEqual(q.items, []);
});

test('failed compaction remains visible and requires an explicit retry', async () => {
  const { ParticipantQueues } = await import('../src/turnQueue.ts');
  let fail = true;
  const q = new ParticipantQueues(async () => ['null'], async () => {
    if (fail) throw Error('compaction refused');
  }, async () => {}, () => {});
  const id = await q.send('/compact', 'compact');
  assert.equal(q.items[0].kind, 'compact');
  assert.equal(q.items[0].failed, true);
  fail = false;
  q.retry(id);
  await tick();
  assert.deepEqual(q.items, []);
});

test('a previous batch room Idle cannot release the next in-flight recipient reservation', async () => {
  const { ParticipantQueues } = await import('../src/turnQueue.ts');
  const posts = []; let acknowledge;
  const pending = new Promise(resolve => { acknowledge = resolve; });
  const q = new ParticipantQueues(async () => ['a'], async text => { posts.push(text); if (text === 'second') await pending; }, async () => {}, () => {});
  q.started('a'); await q.send('second'); await q.send('third');
  q.idle('a'); q.roomIdle(); acknowledge(); await tick();
  assert.deepEqual(posts, ['second']);
  q.started('a'); q.idle('a'); await tick();
  assert.deepEqual(posts, ['second', 'third']);
});

test('explicit retry after reconnection releases its connection hold, and offline retry changes nothing', async () => {
  const { ParticipantQueues } = await import('../src/turnQueue.ts');
  let online = true, fail = true; const posts = [];
  const q = new ParticipantQueues(async () => ['a'], async text => { posts.push(text); if (fail) throw Error('offline'); }, async () => {}, () => {}, () => {}, () => online);
  const id = await q.send('retry me');
  online = false; q.availabilityChanged(); q.retry(id);
  assert.equal(q.items[0].failed, true);
  online = true; fail = false; q.retry(id); await tick();
  assert.deepEqual(posts, ['retry me', 'retry me']); assert.equal(q.connectionPaused, false);
});
