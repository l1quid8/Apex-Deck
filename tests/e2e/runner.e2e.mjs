// Real daemon and provider dispatch. Only the fixture binary admits these
// temporary-directory UI actions without installed desktop receipts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DaemonClient } from '../../src/daemon/client.ts';
import { socketLink } from './link.mjs';
const BIN=process.env.APEX_DAEMON_BIN??path.resolve('target/debug/apex-daemon-fixture');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(what,fn,ms=10000){const end=Date.now()+ms;for(;;){const value=await fn();if(value)return value;if(Date.now()>end)throw Error(`Timed out: ${what}`);await sleep(25);}}
const limits={schemaVersion:1,maxTurns:30,maxInvocations:120,lifetimeMs:7200000,maxCostMicros:5000000};
function report(disposition='done',done='Verified result',evidence=['Observed fixture result']){return `Result: ${done}\n\`\`\`apex-runner\n${JSON.stringify({version:1,disposition,done,next:disposition==='working'?'Continue':'',blocker:disposition==='blocked'?'Need human input':null,criteria:[{id:'result',status:disposition==='done'?'done':'pending',evidence}]})}\n\`\`\``;}
const bot=(id,lines)=>({id,display_name:id,access:'read',backend:{kind:'scripted',lines}});
async function serve(data){fs.rmSync(path.join(data,'daemon.json'),{force:true});const child=spawn(BIN,['serve','--exit-on-stdin-close','--data-dir',data],{stdio:['pipe','ignore','pipe']});let errors='';child.stderr.on('data',d=>errors+=d);await until('daemon ready',()=>{if(child.exitCode!==null)throw Error(errors);return fs.existsSync(path.join(data,'daemon.json'));});return {kill:()=>new Promise(r=>{child.once('exit',r);child.kill('SIGKILL');}),stop:()=>new Promise(r=>{child.once('exit',r);child.stdin.end();})};}
async function setup(t){const data=fs.mkdtempSync('/tmp/runner-e2e-');let daemon=await serve(data);let client=new DaemonClient(()=>socketLink(path.join(data,'daemon.sock')));await client.start();t.after(async()=>{client.close();await daemon.stop();fs.rmSync(data,{recursive:true,force:true});});return {data,get client(){return client;},async restart(kill=false){client.close();if(kill)await daemon.kill();else await daemon.stop();daemon=await serve(data);client=new DaemonClient(()=>socketLink(path.join(data,'daemon.sock')));await client.start();}};}
async function room(client,id,participants,cwd=null){await client.call('room_create',{id,participants,cwd,options:{policy:'mention',max_bot_hops:3}});}
const state=(c,id)=>c.call('room_runner_state',{id});
async function start(c,id,kind='goal',extra={}){return (await c.call('room_runner_start',{id,requestId:crypto.randomUUID(),runner:{schemaVersion:1,kind,objective:kind==='goal'?'Verify the fixture result':undefined,prompt:kind==='loop'?'Check fixture':undefined,intervalSeconds:kind==='loop'?60:undefined,workers:['w'],limits,...extra}})).applied;}
async function action(c,id,tag,extra={}){for(let i=0;i<10;i++){const s=await state(c,id);const r=await c.call('room_runner_action',{id,runnerId:s.id,expectedRevision:s.revision,requestId:crypto.randomUUID(),action:{action:tag,...extra}});if(r.applied)return r.applied;}throw Error('Action kept conflicting');}
async function phase(c,id,want,ms){return until(`${id}: ${want}`,async()=>{const s=await state(c,id);return s.phase===want?s:null;},ms);}

test('runner dispatch: completion, blocked, stuck, limits, stale End, restart, exclusive ownership and checks',{timeout:45000},async t=>{
 const f=await setup(t);let c=f.client;
 await room(c,'done',[bot('w',[report()]),bot('other',[report()])]);
 let turns=0,other=0;c.on('room-event',p=>{if(p.room==='done'&&p.event.type==='turn_started'){if(p.event.id==='w')turns++;else other++;}});
 const started=await start(c,'done');const completed=await phase(c,'done','completed');
 assert.equal(turns,1);assert.equal(other,0);assert.equal(completed.usage.turns,1);assert.equal(completed.usage.invocations,1);assert.equal(completed.usage.costMicros,null);assert.equal(completed.usage.unknownCostTurns,1);
 await assert.rejects(c.call('room_runner_action',{id:'done',runnerId:started.id,expectedRevision:completed.revision,requestId:'old-resume',action:{action:'resume'}}));
 await room(c,'blocked',[bot('w',[report('blocked')])]);await start(c,'blocked');assert.equal((await phase(c,'blocked','paused')).reason,'blocked');
 await room(c,'stuck',[bot('w',Array(5).fill(report('working','Same checkpoint',[])))]);await start(c,'stuck');const stuck=await phase(c,'stuck','paused');assert.equal(stuck.reason,'stuck');assert.equal(stuck.usage.invocations,3);
 await room(c,'cap',[bot('w',[report('working'),report()])]);await start(c,'cap','goal',{limits:{...limits,maxTurns:1}});const capped=await phase(c,'cap','paused');assert.equal(capped.reason,'limit');assert.equal(capped.usage.invocations,1);
 await assert.rejects(action(c,'cap','resume'),/limit/i);await action(c,'cap','update_limits',{limits:{...limits,maxTurns:3}});await action(c,'cap','resume');assert.equal((await phase(c,'cap','completed')).usage.invocations,2);
 await room(c,'end',[bot('w',[report('working')])]);await start(c,'end','loop');await phase(c,'end','scheduled');const ended=await action(c,'end','end');await assert.rejects(c.call('room_decide',{id:'end',request:'stale-request',approve:true}));await sleep(250);assert.equal((await state(c,'end')).generation,ended.generation);assert.equal((await state(c,'end')).phase,'ended');
 await room(c,'restart',[bot('w',[report('done')])]);await start(c,'restart','loop');await until('first run settles',async()=>{const s=await state(c,'restart');return s.phase==='scheduled'&&s.usage.turns===1;});await f.restart();c=f.client;const recovered=await state(c,'restart');assert.equal(recovered.phase,'paused');assert.equal(recovered.inFlight,null);assert.equal(recovered.reason,'recovery');await sleep(250);assert.equal((await state(c,'restart')).usage.invocations,1);
 // Checks execute under the selected worker's Full access in a temporary cwd.
 const folder=path.join(f.data,'checks');fs.mkdirSync(folder);
 const full={...bot('w',[report()]),access:'full'};
 await room(c,'check-fail',[full],folder);await start(c,'check-fail','goal',{checks:[{id:'fails',argv:['/bin/sh','-c','echo CHECK_FAILED; exit 7'],timeoutMs:1000}]});const failed=await phase(c,'check-fail','paused');assert.equal(failed.reason,'blocked');assert.match(failed.checkpoint.blocker,/exit 7/);
 await room(c,'checker',[bot('w',[report()]),bot('checker',[report('blocked')])]);await start(c,'checker','goal',{checker:'checker'});const checked=await phase(c,'checker','paused');assert.equal(checked.usage.invocations,2);assert.equal(checked.reason,'blocked');
});

test('one-minute loop really fires twice, never overlaps; Stop during countdown prevents more calls',{timeout:85000},async t=>{
 const {client:c}=await setup(t);await room(c,'loop',[bot('w',[report(),report(),report()])]);let active=0,peak=0,count=0;const times=[];
 c.on('room-event',p=>{if(p.room!=='loop')return;if(p.event.type==='turn_started'){active++;peak=Math.max(peak,active);count++;times.push(Date.now());}if(p.event.type==='participant_idle')active=Math.max(0,active-1);});
 await start(c,'loop','loop');await until('two scheduled runs',()=>count===2,75000);const s=await until('second run settles',async()=>{const s=await state(c,'loop');return s.phase==='scheduled'&&s.usage.turns===2?s:null;});
 assert.equal(peak,1);assert.ok(times[1]-times[0]>=60000);assert.equal(s.usage.invocations,2);
 await c.call('room_stop',{id:'loop'});assert.equal((await state(c,'loop')).phase,'paused');await sleep(350);assert.equal(count,2);
});

test('human interruption yields the room and automation continues without Resume',{timeout:20000},async t=>{
 const {client:c,data}=await setup(t);const count=path.join(data,'turn-count');const script=`n=0; test ! -f '${count}' || n=$(cat '${count}'); n=$((n+1)); echo "$n" > '${count}'; if [ "$n" -eq 1 ]; then sleep 2; fi; printf '%s' '${report().replaceAll("'","'\\''")}'`;
 await room(c,'human',[{id:'w',display_name:'w',access:'read',backend:{kind:'cli',program:'/bin/sh',args:['-c',script]}}]);await start(c,'human');await until('worker began',()=>fs.existsSync(count));
 await c.call('room_post_to',{id:'human',text:'Human steering message',targets:['w']});const done=await phase(c,'human','completed');assert.ok(done.usage.invocations>=2);assert.ok(Number(fs.readFileSync(count,'utf8'))>=3);
});


test('review regressions: configuration cancel, old End replay, limit lowering, and crashed-check cleanup',{timeout:25000},async t=>{
 const f=await setup(t);let c=f.client;
 const counter=path.join(f.data,'config-count');
 const shell={id:'w',display_name:'w',access:'read',backend:{kind:'cli',program:'/bin/sh',args:['-c',`echo invocation >> '${counter}'; sleep 1; printf '%s' '${report().replaceAll("'","'\\''")}'`]}};
 await room(c,'config',[shell]);await start(c,'config');await until('config worker accepted',()=>fs.existsSync(counter));
 await c.call('room_update_participant',{id:'config',participant:{...shell,display_name:'Renamed'}});
 const paused=await state(c,'config');assert.equal(paused.phase,'paused');assert.equal(paused.inFlight,null);assert.equal(paused.usage.unknownCostTurns,1);
 await action(c,'config','resume');assert.equal((await phase(c,'config','completed')).usage.invocations,2);
 await room(c,'replay',[shell]);let old=await start(c,'replay');const oldEnd={id:'replay',runnerId:old.id,expectedRevision:old.revision,requestId:'old-end-receipt',action:{action:'end'}};
 await c.call('room_runner_action',oldEnd);const fresh=await start(c,'replay');await until('replacement attempt accepted',async()=>Boolean((await state(c,'replay')).inFlight));
 await c.call('room_runner_action',oldEnd);assert.equal((await phase(c,'replay','completed')).id,fresh.id);
 await room(c,'lower',[shell]);await start(c,'lower');await until('lower worker accepted',async()=>Boolean((await state(c,'lower')).inFlight));
 const lowered=await action(c,'lower','update_limits',{limits:{...limits,maxInvocations:1}});assert.equal(lowered.phase,'paused');assert.equal(lowered.reason,'limit');assert.equal(lowered.inFlight,null);
 await sleep(100);assert.equal((await state(c,'lower')).phase,'paused');
 const cwd=path.join(f.data,'crash-check');fs.mkdirSync(cwd);const started=path.join(cwd,'started'),after=path.join(cwd,'after');
 await room(c,'crash-check',[{...bot('w',[report()]),access:'full'}],cwd);
 await start(c,'crash-check','goal',{checks:[{id:'sleeping',argv:['/bin/sh','-c',`touch '${started}'; sleep 3; touch '${after}'`],timeoutMs:10000}]});
 await until('check process began',()=>fs.existsSync(started));await f.restart(true);c=f.client;
 assert.equal((await state(c,'crash-check')).phase,'paused');await sleep(3300);assert.equal(fs.existsSync(after),false,'recovery must terminate the orphan check group');
});
