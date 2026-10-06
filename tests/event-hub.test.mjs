import test from 'node:test';
import assert from 'node:assert/strict';
const mod=await import('../src/eventHub.ts').catch(()=>({}));
import { applyApprovalEvent } from '../src/approvals.ts';
import { representedRoomEvent } from '../src/roomRecovery.ts';
test('identical room/pty ids never cross hosts and mod denial uses source host',async()=>{
  assert.equal(typeof mod.createEventHub,'function');
  const callbacks={};const heard=[];const decisions=[];
  const backend=h=>({onPtyData:async cb=>{callbacks[h+'pty']=cb;return ()=>{};},onPtyExit:async()=>()=>{},onRoomEvent:async cb=>{callbacks[h]=cb;return ()=>{};},roomDecide:async(...args)=>decisions.push([h,...args])});
  const hub=mod.createEventHub({toolCall:()=>Promise.resolve('denied')});
  await hub.start(backend('local'),'local');await hub.start(backend('at'),'at');
  hub.registerRoom('r',e=>heard.push(['local',e.type]),'local');hub.registerRoom('r',e=>heard.push(['at',e.type]),'at');
  hub.registerPty('p',{onData:d=>heard.push(['local',d])},'local');
  callbacks.at('r',{type:'idle'});callbacks.atpty('p','wrong');
  callbacks.at('r',{type:'approval_requested',id:'bot',request:'ask',action:{kind:'command',title:'Run',detail:'pwd'}});
  await new Promise(r=>setTimeout(r,0));
  assert.deepEqual(heard,[['at','idle'],['at','approval_requested']]);assert.deepEqual(decisions,[['at','r','ask',false]]);
});
test('subscriptions share per host and a partial failure unwinds',async()=>{
  assert.equal(typeof mod.createEventHub,'function');
  let subscriptions=0;let off=0;
  const backend={onPtyData:async()=>{subscriptions++;return ()=>off++;},onPtyExit:async()=>()=>off++,onRoomEvent:async()=>()=>off++};
  const hub=mod.createEventHub({});const a=await hub.start(backend);const b=await hub.start(backend);
  assert.equal(subscriptions,1);a();assert.equal(off,0);b();assert.equal(off,3);
  await assert.rejects(hub.start({...backend,onPtyExit:async()=>{throw Error('broken');}},'at'));assert.equal(off,4);
});

test('an approval already settled in the snapshot cannot reappear in the global store',async()=>{
  let emit; let approvals={};
  const backend={onPtyData:async()=>()=>{},onPtyExit:async()=>()=>{},onRoomEvent:async cb=>{emit=cb;return()=>{};}};
  const state={snapshot:{},active:[],approvals:[],recovery_seq:5};
  const hub=mod.createEventHub({approval:(_host,room,event)=>{approvals=applyApprovalEvent(approvals,room,event,100,'at');}});
  await hub.start(backend,'at');
  hub.registerRoom('r',()=>{},'at',event=>!representedRoomEvent(state,event));
  emit('r',{type:'approval_requested',id:'bot',request:'old',action:{kind:'command'},recovery_seq:3});
  assert.deepEqual(approvals,{});
  emit('r',{type:'approval_requested',id:'bot',request:'new',action:{kind:'command'},recovery_seq:6});
  assert.deepEqual(approvals.r.map(c=>c.request),['new']);
});
