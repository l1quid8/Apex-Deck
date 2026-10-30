import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

// Resolve the browser's extensionless TS imports without changing its modules.
const hooks = registerHooks({resolve(specifier, context, nextResolve) {
  return nextResolve(specifier.startsWith('.') && !/\.[a-z0-9]+$/i.test(specifier) ? specifier + '.ts' : specifier, context);
}});
const { getBackend } = await import('../src/backend.ts');
hooks.deregister();

test('preview curation protects recent, compacted, pinned and long Human messages and persists undo', async t => {
  const data = new Map();
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {configurable:true,value:{
    getItem:key=>data.get(key) ?? null,
    setItem:(key,value)=>data.set(key,value), removeItem:key=>data.delete(key),
  }});
  t.after(()=>{if(previous)Object.defineProperty(globalThis,'localStorage',previous);else delete globalThis.localStorage;});
  const backend = await getBackend();
  assert.equal(backend.demo,true);
  const events = [];
  const unlisten = await backend.onRoomEvent((id,event)=>{if(id==='curate-preview')events.push(event);});
  t.after(unlisten);
  const transcript = Array.from({length:50},(_,seq)=>({seq,speaker:{kind:'bot',id:'null'},text:`Reply ${seq}`}));
  transcript[3] = {seq:3,speaker:{kind:'human'},text:'🙂'.repeat(2001)};
  const snapshot = {participants:[{id:'null',display_name:'Null',backend:{kind:'scripted',lines:[]}}],
    options:{policy:'mention',max_bot_hops:3}, transcript, compaction:{upto:2,summary:'earlier'},
    pins:['[Pinned response #2]\nReply 2']};
  await backend.roomImport('curate-preview',snapshot,'');
  await backend.roomCreate('curate-preview',[],snapshot.options,'');
  const reply = await backend.roomCurate('curate-preview');
  assert.deepEqual(reply,{by:'null',status:'hidden',count:13,unchecked:0});
  const saved = JSON.parse(data.get('apex-deck.demo.room.curate-preview'));
  assert.deepEqual(saved.transcript,transcript,'preview visibility never edits the transcript');
  assert.deepEqual(saved.curations[0].hidden,[[4,16]]);
  assert.match(saved.curations[0].reason,/preview/i);
  assert.equal(events.find(e=>e.type==='curations_changed').curations[0].at,50);
  assert.ok(events.some(e=>e.type==='participant_idle'&&e.id==='null'));
  await backend.roomClose('curate-preview');
  const reopened = await backend.roomCreate('curate-preview',[],snapshot.options,'');
  assert.deepEqual(reopened.curations,saved.curations);
  assert.deepEqual(await backend.roomCurateUndo('curate-preview'),{restored:13,sealed:0});
  assert.deepEqual(await backend.roomCurateUndo('curate-preview'),{restored:0,sealed:0});
  // The next curation is sealed by /compact, so undo reports it without reviving it.
  await backend.roomCurate('curate-preview');
  await backend.roomCompact('curate-preview');
  assert.deepEqual(await backend.roomCurateUndo('curate-preview'),{restored:0,sealed:13});
  await backend.roomDelete('curate-preview');
});

async function fixture(t, id, snapshot) {
  const data = new Map();
  const previous = Object.getOwnPropertyDescriptor(globalThis,'localStorage');
  Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{
    getItem:key=>data.get(key) ?? null, setItem:(key,value)=>data.set(key,value), removeItem:key=>data.delete(key),
  }});
  const backend = await getBackend();
  t.after(async()=>{
    await backend.roomDelete(id);
    if(previous)Object.defineProperty(globalThis,'localStorage',previous);else delete globalThis.localStorage;
  });
  await backend.roomImport(id,snapshot,'');
  await backend.roomCreate(id,[],snapshot.options,'');
  return backend;
}

const snapshot = {
  participants:[{id:'null',display_name:'Null',backend:{kind:'scripted',lines:[]}}],
  options:{policy:'mention',max_bot_hops:3},
  transcript:Array.from({length:60},(_,seq)=>({seq,speaker:{kind:'bot',id:'null'},text:`Reply ${seq}`})),
  curations:[{by:'null',at:50,hidden:[[0,9]],reason:'Earlier work',when:1}],
};

for (const operation of ['fork','rewind','revert','clear']) {
  test(`preview ${operation} drops curation records beyond the history boundary`, async t => {
    const id = `curate-${operation}`;
    const backend = await fixture(t,id,snapshot);
    let target = id;
    if (operation === 'fork') { target = 'curate-fork-copy'; await backend.roomFork(id,target,40); }
    else if (operation === 'rewind') await backend.roomRewind(id,40);
    else if (operation === 'revert') await backend.roomRevert(id,40,null,true,[]);
    else await backend.roomClear(id);
    try {
      assert.deepEqual((await backend.roomCreate(target,[],snapshot.options,'')).curations,[]);
    } finally { if (target !== id) await backend.roomDelete(target); }
  });
}

test('stopping the preview curator leaves the transcript and curation records unchanged', async t => {
  const backend = await fixture(t,'curate-stop',snapshot);
  const pending = backend.roomCurate('curate-stop');
  await backend.roomStop('curate-stop','null');
  assert.deepEqual(await pending,{by:'null',status:'stopped'});
  const state = await backend.roomCreate('curate-stop',[],snapshot.options,'');
  assert.deepEqual(state.transcript,snapshot.transcript);
  assert.deepEqual(state.curations,snapshot.curations);
});
