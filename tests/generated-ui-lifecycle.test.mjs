import test from 'node:test';
import assert from 'node:assert/strict';
import { GeneratedRun, latestCardVersion } from '../src/interactiveAnswers/generatedRun.ts';

const identity = {threadId:'thread-a',seq:3,cardId:'chart',hostId:'local'};
const bounds = {x:20,y:40,width:500,height:300};
function setup() {
  const calls = [];
  let event;
  const api = {
    capability: async () => ({enabled:true,reason:''}),
    run: async request => { calls.push(['run',request]); return {runId:'r1',revisionDigest:'d1'}; },
    bounds: (...args) => calls.push(['bounds',...args]),
    cancel: async id => {calls.push(['cancel',id]);},
    stop: async id => {calls.push(['stop',id]);},
    onEvent: cb => {event=cb;return () => {event=null;};},
  };
  const run = new GeneratedRun(api, {source:'payload',identity}, () => {});
  return {api,run,calls,event:e=>event?.(e)};
}

test('capability checks and mounting never execute generated code; one click starts one run',async()=>{
  const {run,calls}=setup(); await run.checkCapability();
  assert.equal(calls.length,0);
  await run.start(bounds); assert.equal(calls[0][0],'run');
  await run.start(bounds); assert.equal(calls.filter(c=>c[0]==='run').length,1);
  await run.stop(); assert.equal(run.state.phase,'idle');
  await run.start(bounds); assert.equal(calls.filter(c=>c[0]==='run').length,2);
});
test('disposed pending run responses are stopped; they cannot remount or stage text',async()=>{
  const {api,run,calls,event}=setup(); await run.checkCapability();
  let resolve; api.run=()=>new Promise(r=>{resolve=r;});
  const pending=run.start(bounds); run.dispose();
  assert.equal(calls[0]?.[0],'cancel','main authority revoked before startup resolves');
  resolve({runId:'late',revisionDigest:'changed'}); await pending;
  assert.equal(calls[0][0],'cancel'); assert.deepEqual(calls.at(-1),['stop','late']);
  event({runId:'late',type:'discuss',text:'never append'});
  assert.equal(run.state.discuss,'');
});
test('only the active run can stage Discuss; draft changes require a separate trusted click',async()=>{
  const {run,event}=setup(); await run.checkCapability(); await run.start(bounds);
  event({runId:'old',type:'discuss',text:'forged'}); assert.equal(run.state.discuss,'');
  event({runId:'r1',type:'discuss',text:'Count is 4'}); assert.equal(run.state.discuss,'Count is 4');
  assert.equal(run.takeDiscuss(),'Count is 4'); assert.equal(run.state.discuss,'');
  event({runId:'r1',type:'discuss',text:'x'.repeat(4001)}); assert.equal(run.state.discuss,'');
  event({runId:'r1',type:'discuss',text:'old draft'}); await run.stop(); assert.equal(run.takeDiscuss(),'');
});
test('stop cancels pending start and a geometry loss revokes the run',async()=>{
  const {run,api,calls,event}=setup(); await run.checkCapability();
  let resolve; api.run=()=>new Promise(r=>{resolve=r;});
  const pending=run.start(bounds); await run.stop();
  resolve({runId:'cancelled',revisionDigest:'d'});await pending;
  assert.equal(calls[0][0],'cancel'); assert.deepEqual(calls.at(-1),['stop','cancelled']);
  api.run=async()=>({runId:'r1',revisionDigest:'d1'}); await run.start(bounds);
  run.place(null); await Promise.resolve();
  assert.deepEqual(calls.at(-1),['stop','r1']);
  event({runId:'r1',type:'ready'}); assert.equal(run.state.phase,'idle');
});
test('capability absent or disabled cannot be bypassed by calling start',async()=>{
  const {api,run,calls}=setup(); api.capability=async()=>({enabled:false,reason:'Release tests pending'});
  await run.checkCapability(); await run.start(bounds); assert.equal(calls.length,0);
  assert.equal(run.state.reason,'Release tests pending');
  const absent=new GeneratedRun(undefined,{source:'payload',identity},()=>{});
  await absent.checkCapability();await absent.start(bounds);assert.equal(absent.state.enabled,false);
});
test('a new card version is historical only when a later same-id card exists',()=>{
  const versions=new Map([['2:chart',1],['3:chart',2],['9:other',9]]);
  assert.equal(latestCardVersion(versions,'chart'),2);
  assert.equal(latestCardVersion(versions,'fresh'),1);
});
