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
