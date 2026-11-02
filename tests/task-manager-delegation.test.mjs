import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTaskQuickAdd, proposeWorkerTask } from '../src/taskManagerDelegation.ts';
const profile={id:'null',display_name:'Null Worker',backend:{kind:'codex'},persona:'',access:'read',effort:null};
const assistant={hostId:'host-a',assistantId:'alfred'};
const project={hostId:'host-a',workspaceId:'repo',cwd:'/repo'};
const owner={...project,conversationId:'monitor'};
function fixture(extra={}) {
 const calls=[]; const record={id:'alfred',hostId:'host-a',revision:7,name:'Alfred',profile,projects:[{project,tools:'ask'}],...extra};
 const task={id:'t1',workspaceId:'repo',owner,status:'proposed',revision:1,originalRequest:'Inspect',brief:'Inspect',updatedAtMs:1,attempts:[],lineage:{assistant,project,delegationId:'draft',sourceEventId:'event'}};
 const backend={host:{connection:{get:()=>({status:{kind:'connected',hostId:'host-a'}})}},call:async(name,args)=>{calls.push([name,args]);if(name==='personal_get')return record;if(name==='monitor_get')return {...owner};if(name==='personal_project_propose_ui')return {taskId:'t1'};if(name==='assistant_tasks_list')return {project,workspaceId:'repo',revision:1,tasks:[task],executions:[]};throw Error(name);}};
 return {calls,backend,record};
}
test('quick add resolves saved IDs and quoted display names and never treats bad handles as to-dos',()=>{
 assert.deepEqual(parseTaskQuickAdd('buy milk',[profile]),{kind:'todo',text:'buy milk'});
 assert.deepEqual(parseTaskQuickAdd('@alfred research',[profile]),{kind:'assistant',text:'research'});
 assert.deepEqual(parseTaskQuickAdd('@null Inspect',[profile]),{kind:'worker',text:'Inspect',profile});
 assert.equal(parseTaskQuickAdd('@"Null Worker" Inspect',[profile]).profile,profile);
 for(const input of ['@missing Inspect','@null','@','@"Null Worker Inspect'])assert.throws(()=>parseTaskQuickAdd(input,[profile]));
});
test('delegation keeps exact identity and fresh revision, returns proposal, never starts a task',async()=>{
 const {calls,backend}=fixture();let creations=0;const draft={id:'draft'};
 const args={backend,assistant,project,projectName:'Repo',assistantName:'Alfred',profile,brief:'Inspect',draft,createWorkerThread:async()=>{creations++;return 'worker';}};
 const rows=await proposeWorkerTask(args);await proposeWorkerTask(args);
 assert.equal(creations,1);assert.equal(rows[0].status,'proposed');assert.deepEqual(rows[0].project,project);assert.deepEqual(rows[0].assistant,assistant);
 const payload=calls.find(([name])=>name==='personal_project_propose_ui')[1];
 assert.equal(payload.expectedRevision,7);assert.equal(payload.delegationId,'draft');assert.equal(payload.mode,'read_only');assert.deepEqual(payload.destination,{threadId:'worker',workers:['null'],newThread:false});
 assert.ok(calls.every(([name])=>!['personal_todo','assistant_task_action','personal_send'].includes(name)));
});
test('owner drift, disabled assignments and unknown worker destinations fail before proposal',async()=>{
 for(const overrides of [{hostId:'other'},{projects:[]},{projects:[{project,tools:'off'}]}]){
 const {backend,calls}=fixture(overrides);
 await assert.rejects(proposeWorkerTask({backend,assistant,project,projectName:'Repo',assistantName:'Alfred',profile,brief:'Inspect',draft:{id:'draft'},createWorkerThread:async()=> 'worker'}));
 assert.ok(!calls.some(([name])=>name==='personal_project_propose_ui'));
 }
});
test('transport replacement, coordinator mismatch and forged canonical snapshots cannot create a proposal',async()=>{
 for(const mismatch of ['transport','coordinator','snapshot']){
  const {backend,calls}=fixture();const original=backend.call;
  if(mismatch==='transport')backend.host.connection.get=()=>({status:{kind:'connected',hostId:'other'}});
  if(mismatch==='coordinator')backend.call=async(name,args)=>name==='monitor_get'?{...owner,hostId:'other'}:original(name,args);
  if(mismatch==='snapshot')backend.call=async(name,args)=>name==='assistant_tasks_list'?{project:{...project,cwd:'/other'},tasks:[],executions:[],workspaceId:'repo',revision:1}:original(name,args);
  await assert.rejects(proposeWorkerTask({backend,assistant,project,projectName:'Repo',assistantName:'Alfred',profile,brief:'Inspect',draft:{id:'draft'},createWorkerThread:async()=> 'worker'}));
  assert.ok(!calls.some(([name])=>name==='personal_project_propose_ui'));
 }
});
test('unacknowledged proposal retry reuses delegation and worker thread',async()=>{
 const {backend,calls}=fixture();const original=backend.call;let failed=false;let creations=0;
 backend.call=async(name,args)=>{const result=await original(name,args);if(name==='personal_project_propose_ui'&&!failed){failed=true;throw Error('reply lost');}return result;};
 const args={backend,assistant,project,projectName:'Repo',assistantName:'Alfred',profile,brief:'Inspect',draft:{id:'draft'},createWorkerThread:async()=>{creations++;return 'worker';}};
 await assert.rejects(proposeWorkerTask(args),/reply lost/);const rows=await proposeWorkerTask(args);
 assert.equal(rows.length,1);assert.equal(creations,1);assert.deepEqual(calls.filter(([name])=>name==='personal_project_propose_ui').map(([,args])=>args.delegationId),['draft','draft']);
});
test('missing coordinator is assigned with assistant profile, never the requested worker configuration',async()=>{
 const {backend,calls,record}=fixture();const original=backend.call;let assigned;
 const coordinatorProfile={...profile,id:'coordinator'};record.profile=coordinatorProfile;
 backend.call=async(name,args)=>{if(name==='monitor_get')return null;if(name==='monitor_assign'){assigned=args;return {...owner};}return original(name,args);};
 await proposeWorkerTask({backend,assistant,project,projectName:'Repo',assistantName:'Alfred',profile,brief:'Inspect',draft:{id:'draft'},createWorkerThread:async()=> 'worker'});
 assert.equal(assigned.profile,coordinatorProfile);assert.equal(assigned.onlyIfAbsent,true);assert.equal(assigned.cwd,project.cwd);assert.equal(assigned.hostId,assistant.hostId);
 assert.equal(calls.filter(([name])=>name==='personal_project_propose_ui').length,1);
});
