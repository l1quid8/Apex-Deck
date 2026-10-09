import test from 'node:test';
import assert from 'node:assert/strict';
const mod=await import('../src/roomRecovery.ts').catch(()=>({}));
test('late state cannot overwrite newer recovery, and disposed panes ignore replies',async()=>{
  assert.equal(typeof mod.createRoomRecovery,'function');
  const waiting=[];const applied=[];
  const recovery=mod.createRoomRecovery({load:()=>new Promise(r=>waiting.push(r)),apply:s=>applied.push(s),fail:()=>assert.fail('unexpected failure')});
  const a=recovery.refresh();const b=recovery.refresh();waiting[1]('new');await b;waiting[0]('old');await a;
  const c=recovery.refresh();recovery.dispose();waiting[2]('closed');await c;assert.deepEqual(applied,['new']);
});
test('old helper falls back only for unsupported room_state, never a lost request',async()=>{
  assert.equal(typeof mod.loadRoomState,'function');
  const snapshot={transcript:[],participants:[],options:{},pins:[]};let creates=0;
  const backend={roomCreate:async()=>{creates++;return snapshot;},roomState:async()=>{throw Error('unknown variant `room_state`, expected room_create');}};
  const state=await mod.loadRoomState(backend,'r',[],{},'');assert.equal(state.snapshot,snapshot);assert.equal(state.live,false);assert.equal(creates,1);
  backend.roomState=async()=>{throw Error('connection lost');};await assert.rejects(mod.loadRoomState(backend,'r',[],{},''),/lost/);
});

test('message deduplication permits reused numbers after clear and revert', () => {
  assert.equal(typeof mod.messageDedup, 'function');
  const seen = mod.messageDedup();
  seen.restore([{seq:0}, {seq:1}, {seq:2}]);
  assert.equal(seen.accept(2), false);
  seen.truncate(1);
  assert.equal(seen.accept(1), true);
  assert.equal(seen.accept(2), true);
  seen.truncate(0);
  assert.equal(seen.accept(0), true);
});

test('a failed room load stays pending until a later successful recovery', async () => {
  let succeeds = false;
  const recovery = mod.createRoomRecovery({load:async()=>{if(!succeeds)throw Error('drop');return 'ok';},apply:()=>{},fail:()=>{}});
  assert.equal(typeof recovery.pending, 'function');
  await recovery.refresh(); assert.equal(recovery.pending(), true);
  succeeds = true; await recovery.refresh(); assert.equal(recovery.pending(), false);
});

test('snapshot boundary prevents doubled usage, changes and summaries while retaining later events', async () => {
  let finish; let usage=0; const changes=[]; const summaries=[];
  const recovery=mod.createRoomRecovery({
    load:()=>new Promise(r=>finish=r),
    apply:state=>{usage=state.usage;changes.push('saved');summaries.push('saved');},
    fail:()=>assert.fail('load failed'),
    represented:(state,event)=>event.recovery_seq<=state.recovery_seq,
    event:event=>{if(event.type==='usage')usage+=event.tokens;if(event.type==='changed')changes.push('new');if(event.type==='compacted')summaries.push('new');},
  });
  const loading=recovery.refresh();
  recovery.capture({type:'usage',tokens:10,recovery_seq:1});
  recovery.capture({type:'changed',recovery_seq:2});
  recovery.capture({type:'compacted',recovery_seq:3});
  recovery.capture({type:'usage',tokens:4,recovery_seq:4});
  finish({usage:10,recovery_seq:3});await loading;
  assert.equal(usage,14);assert.deepEqual(changes,['saved']);assert.deepEqual(summaries,['saved']);
});

test('events received after subscription but before the snapshot starts are replayed past its boundary', async () => {
  let finish; const applied=[]; const events=[];
  const recovery=mod.createRoomRecovery({
    load:()=>new Promise(resolve=>finish=resolve), apply:state=>applied.push(state.recovery_seq),
    fail:error=>assert.fail(String(error)),
    represented:(state,event)=>event.recovery_seq <= state.recovery_seq,
    event:event=>events.push(event.recovery_seq),
  });
  assert.equal(recovery.capture({recovery_seq:2}), true);
  const loading=recovery.refresh();
  recovery.capture({recovery_seq:3});
  finish({recovery_seq:2}); await loading;
  assert.deepEqual(applied,[2]);
  assert.deepEqual(events,[3]);
});

test('room event boundary retains active streaming text but suppresses completed overlap', () => {
  const state={snapshot:{},active:['bot'],approvals:[],recovery_seq:3};
  assert.equal(typeof mod.representedRoomEvent,'function');
  assert.equal(mod.representedRoomEvent(state,{type:'usage',recovery_seq:3}),true);
  assert.equal(mod.representedRoomEvent(state,{type:'usage',recovery_seq:4}),false);
  assert.equal(mod.representedRoomEvent(state,{type:'delta',id:'bot',recovery_seq:2}),false);
  assert.equal(mod.representedRoomEvent({...state,active:[]},{type:'delta',id:'bot',recovery_seq:2}),true);
  assert.equal(mod.representedRoomEvent(state,{type:'context_usage',id:'bot',recovery_seq:2}),false);
});

test('cursorless helper totals reconcile from its authoritative snapshot after overlapping events', async () => {
  assert.equal(typeof mod.loadRoomTotals, 'function');
  const snapshot={transcript:[],participants:[],options:{},usage:{bot:{input:10,output:2,turns:1}},changes:[{by:'bot',path:'a',added:1,removed:0,seq:1}]};
  const result=await mod.loadRoomTotals({roomCreate:async()=>snapshot},'r');
  assert.deepEqual(result.usage,{bot:{input:10,output:2,turns:1}});
  assert.equal(result.changes.length,1);
});

test('cursorless totals serialize reads and coalesce a burst into one fresh snapshot', async () => {
  assert.equal(typeof mod.createRoomTotalsRefresh, 'function');
  const waiting=[]; const applied=[]; let concurrent=0; let maxConcurrent=0;
  const recovery=mod.createRoomTotalsRefresh({
    load:()=>{ concurrent++; maxConcurrent=Math.max(maxConcurrent,concurrent); return new Promise(resolve=>waiting.push(value=>{concurrent--;resolve(value);})); },
    apply:state=>applied.push(state), fail:()=>assert.fail('unexpected error'),
  });
  const first=recovery.refresh();
  for(let i=0;i<20;i++) void recovery.refresh();
  assert.equal(waiting.length,1);
  waiting[0]({usage:10,changes:1}); await new Promise(resolve=>setImmediate(resolve));
  assert.equal(waiting.length,2);
  waiting[1]({usage:30,changes:21}); await first;
  assert.equal(maxConcurrent,1); assert.equal(waiting.length,2);
  assert.deepEqual(applied,[{usage:10,changes:1},{usage:30,changes:21}]);
});

test('coalesced totals recover after a failed read and discard replies after disposal', async () => {
  assert.equal(typeof mod.createRoomTotalsRefresh, 'function');
  const waiting=[]; const applied=[]; const failures=[];
  const recovery=mod.createRoomTotalsRefresh({load:()=>new Promise((resolve,reject)=>waiting.push({resolve,reject})),apply:s=>applied.push(s),fail:e=>failures.push(String(e))});
  const first=recovery.refresh(); void recovery.refresh();
  waiting[0].reject(Error('SSH lost')); await new Promise(resolve=>setImmediate(resolve));
  assert.equal(waiting.length,2); waiting[1].resolve(20); await first;
  assert.deepEqual(failures,['Error: SSH lost']); assert.deepEqual(applied,[20]);
  const late=recovery.refresh(); recovery.dispose(); waiting[2].resolve(30); await late;
  await recovery.refresh(); assert.equal(waiting.length,3); assert.deepEqual(applied,[20]);
});

test('an event at the end of a totals read cannot leave its reread stranded', async () => {
  const applied=[]; let count=0;
  const recovery=mod.createRoomTotalsRefresh({
    load:async()=>++count,
    apply:value=>{applied.push(value); if(value===1)queueMicrotask(()=>{void recovery.refresh();});},
    fail:()=>assert.fail('unexpected error'),
  });
  await recovery.refresh(); await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(applied,[1,2]);
});
