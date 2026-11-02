import test from 'node:test';
import assert from 'node:assert/strict';
import { collectWorkspaceTasks, filterWorkspaceTasks, workspaceTaskRoute, workspaceTaskKey, reconcileWorkspaceTaskSources, personalTaskForRow, workspaceTaskHostMatches, guardWorkspaceTaskBackend } from '../src/workspaceTasks.ts';

const assistant = (hostId='h1', assistantId='asst-1') => ({hostId,assistantId});
const project = (workspaceId='p1', hostId='h1') => ({hostId,workspaceId,cwd:`/projects/${workspaceId}`});
const owner = (p=project()) => ({...p,conversationId:'monitor-1'});
const task = (id='task-1', p=project(), extra={}) => ({id,workspaceId:p.workspaceId,owner:owner(p),originalRequest:`Build ${p.workspaceId}`,brief:'Brief',status:'queued',revision:3,updatedAtMs:100,createdAtMs:10,resultData:null,...extra});
const source = (p=project(), tasks=[task('task-1',p)], extra={}) => ({project:p,owner:owner(p),name:p.workspaceId,snapshot:{workspaceId:p.workspaceId,revision:4,tasks,executions:[]},offline:false,observedAt:200,...extra});
const personal = (ref=assistant(), extra={}) => ({assistant:ref,name:ref.assistantId,tasks:[{id:'pt-1',goal:'Research',status:'running',updatedAt:90,receipts:[]}],offline:false,observedAt:200,...extra});

test('global collection includes three projects regardless of focused pane and legacy unassigned tasks', () => {
  const rows=collectWorkspaceTasks([],['p1','p2','p3'].map(id=>source(project(id))));
  assert.equal(rows.length,3);
  assert.deepEqual(rows.map(row=>row.project.workspaceId).sort(),['p1','p2','p3']);
  assert.ok(rows.every(row=>row.assistant===null && row.source==='project'));
});
test('duplicate local IDs on separate hosts and assistants never collide', () => {
  const rows=collectWorkspaceTasks([personal(assistant('h1')),personal(assistant('h2')),personal(assistant('h1','asst-2'))],[source(),source(project('p1','h2'))]);
  assert.equal(new Set(rows.map(row=>row.key)).size,5);
  assert.notEqual(workspaceTaskKey('personal',assistant('h1'),'pt-1'),workspaceTaskKey('personal',assistant('h1','asst-2'),'pt-1'));
});
test('lineage identifies owning assistant and exact-owner route includes task revision', () => {
  const a=assistant(), p=project();
  const t=task('task-1',p,{lineage:{assistant:a,project:p,sourceEventId:'event-1',delegationId:'delegation-1'}});
  const [row]=collectWorkspaceTasks([],[source(p,[t])]);
  assert.deepEqual(row.assistant,a);
  assert.deepEqual(workspaceTaskRoute(row),{source:'project',owner:owner(p),taskId:t.id,revision:3});
  const [personalRow]=collectWorkspaceTasks([personal()],[]);
  assert.deepEqual(workspaceTaskRoute(personalRow),{source:'personal',assistant:a,taskId:'pt-1'});
});
test('assistant, project and case-insensitive text filters compose without mutating source rows', () => {
  const a=assistant(), p=project();
  const rows=collectWorkspaceTasks([personal(a)],[source(p,[task('t1',p,{lineage:{assistant:a,project:p,sourceEventId:'e',delegationId:'d'}})]),source(project('p2'))]);
  assert.equal(filterWorkspaceTasks(rows,{assistant:a,project:p,query:'BUILD P1'}).length,1);
  assert.equal(filterWorkspaceTasks(rows,{assistant:'unassigned'}).length,1);
  assert.equal(filterWorkspaceTasks(rows,{query:'no match'}).length,0);
  assert.equal(rows.length,3);
});
test('offline sources retain last snapshot and freshness while rejecting stale late refreshes', () => {
  const p=project(), initial=source(p);
  const saved=reconcileWorkspaceTaskSources([],initial);
  const offline=reconcileWorkspaceTaskSources(saved,{...initial,snapshot:null,offline:true,problem:'Disconnected',observedAt:300});
  const [row]=collectWorkspaceTasks([],offline);
  assert.equal(row.offline,true);
  assert.equal(row.observedAt,200);
  assert.equal(row.title,'Build p1');
  assert.equal(reconcileWorkspaceTaskSources(offline,{...initial,observedAt:100}),offline);
});
test('mismatched project snapshots and forged lineage cannot reroute a row', () => {
  const p=project();
  assert.throws(()=>collectWorkspaceTasks([],[source(p,[task('t1',project('other'))])]),/different/);
  assert.throws(()=>collectWorkspaceTasks([],[source(p,[task('t1',p,{lineage:{assistant:assistant(),project:project('other'),sourceEventId:'e',delegationId:'d'}})])]),/lineage/i);
});
test('host-supplied canonical project metadata relates lineage to unchanged legacy owner aliases',()=>{
  const p={hostId:'host-1',workspaceId:'project',cwd:'/private/tmp/project'};
  const legacyOwner={hostId:'local',workspaceId:'project',cwd:'/tmp/project',conversationId:'m1'};
  const t=task('t1',p,{owner:legacyOwner,lineage:{assistant:assistant('host-1'),project:p,sourceEventId:'e',delegationId:'d'}});
  const data=source(p,[t],{owner:legacyOwner});data.snapshot.project=p;
  const [row]=collectWorkspaceTasks([],[data]);
  assert.deepEqual(row.project,p); assert.deepEqual(row.owner,legacyOwner);assert.equal(row.routeHostId,'local');
  delete data.snapshot.project;
  assert.throws(()=>collectWorkspaceTasks([],[data]),/different/);
});
test('same legacy local owner tuple on different authoritative hosts remains two global tasks',()=>{
  const legacy={hostId:'local',workspaceId:'shared',cwd:'/project',conversationId:'monitor-1'};
  const sources=['h1','h2'].map(hostId=>{
    const p={hostId,workspaceId:'shared',cwd:'/project'};
    const data=source(p,[task('same-task',p,{owner:legacy})],{owner:legacy});data.snapshot.project=p;return data;
  });
  const rows=collectWorkspaceTasks([],sources);
  assert.equal(rows.length,2);assert.equal(new Set(rows.map(row=>row.key)).size,2);
});
test('waiting and approval states precede working; queued and silent running remain working', () => {
  const statuses=['queued','running','proposed','needs_you','ready_for_review','done'];
  const rows=collectWorkspaceTasks([],[source(project(),statuses.map(status=>task(status,project(),{status})))]);
  for(const status of ['queued','running']) assert.equal(rows.find(row=>row.taskId===status).group,'working');
  for(const status of ['proposed','needs_you','ready_for_review']) assert.equal(rows.find(row=>row.taskId===status).group,'waiting');
  assert.equal(rows.find(row=>row.taskId==='done').group,'done');
});
test('personal task detail refuses a same-ID task from another assistant or host', () => {
  const data=personal(), [row]=collectWorkspaceTasks([data],[]);
  const record={id:'asst-1',hostId:'h1',tasks:data.tasks};
  assert.equal(personalTaskForRow(row,record).id,'pt-1');
  assert.equal(personalTaskForRow(row,{...record,id:'asst-2'}),null);
  assert.equal(personalTaskForRow(row,{...record,hostId:'h2'}),null);
  assert.equal(personalTaskForRow(row,{...record,tasks:[]}),null);
});
test('personal timer/dependency waits stay working while an open approval needs the user',()=>{
  const rows=collectWorkspaceTasks([personal(assistant(),{tasks:[
    {id:'timer',goal:'Scheduled wait',status:'waiting',wait:{kind:'timer',at:999},updatedAt:100,receipts:[]},
    {id:'approval',goal:'Approval',status:'needsYou',decision:{status:'open'},updatedAt:100,receipts:[]},
  ]})],[]);
  assert.equal(rows.find(row=>row.taskId==='timer').group,'scheduled');
  assert.equal(rows.find(row=>row.taskId==='approval').group,'waiting');
});
test('global status derives Pausing and Paused from durable control without rewriting ledger status',()=>{
  const rows=collectWorkspaceTasks([],[source(project(),[
    task('active',project(),{status:'running',desiredState:'paused',attempts:[{finishedAtMs:null}]}),
    task('queued',project(),{status:'queued',desiredState:'paused'}),
  ])]);
  assert.equal(rows.find(row=>row.taskId==='active').status,'pausing');
  assert.equal(rows.find(row=>row.taskId==='active').group,'working');
  assert.equal(rows.find(row=>row.taskId==='queued').status,'paused');
  assert.equal(rows.find(row=>row.taskId==='queued').group,'waiting');
});
test('retained task rows cannot act through a route rebound to another authenticated host',()=>{
  const p=project(), data=source(p);data.snapshot.project=p;
  const [row]=collectWorkspaceTasks([],[data]);
  assert.equal(workspaceTaskHostMatches(row,{kind:'connected',hostId:'h1'}),true);
  assert.equal(workspaceTaskHostMatches(row,{kind:'connected',hostId:'h2'}),false);
  assert.equal(workspaceTaskHostMatches(row,{kind:'reconnecting'}),false);
  const [legacy]=collectWorkspaceTasks([],[source(p,undefined,{authenticatedHostId:'h1'})]);
  assert.equal(workspaceTaskHostMatches(legacy,{kind:'connected',hostId:'h1'}),true);
  assert.equal(workspaceTaskHostMatches(legacy,{kind:'connected',hostId:'h2'}),false);
});
test('task backend checks captured host at invocation and rejects a late reply after rebinding',async()=>{
  let status={kind:'connected',hostId:'h1'},calls=0,finish;
  const backend={host:{connection:{get:()=>({status})}},call:async()=>{calls++;return new Promise(resolve=>{finish=resolve;});}};
  const guarded=guardWorkspaceTaskBackend({verifiedHostId:'h1'},backend);
  status={kind:'connected',hostId:'h2'};
  await assert.rejects(async()=>guarded.call('assistant_task_action',{}),/owning machine/);assert.equal(calls,0);
  status={kind:'connected',hostId:'h1'};const reply=guarded.call('assistant_tasks_list',{});assert.equal(calls,1);
  status={kind:'connected',hostId:'h2'};finish({tasks:[]});await assert.rejects(reply,/owning machine/);
});

test('revised worker creation cannot follow a task route rebound to another host',async()=>{
  let status={kind:'connected',hostId:'h1'},calls=0;
  const backend={host:{connection:{get:()=>({status})}},roomCreate:async()=>{calls++;}};
  const guarded=guardWorkspaceTaskBackend({verifiedHostId:'h1'},backend);
  status={kind:'connected',hostId:'h2'};
  await assert.rejects(async()=>guarded.roomCreate('worker',[],{},'/p'),/owning machine/);
  assert.equal(calls,0);
});

test('scheduled tasks and dismissed cleanup remain reachable without polluting ordinary groups',()=>{
  const p=project();
  const rows=collectWorkspaceTasks([personal(assistant(),{tasks:[{id:'timer',goal:'Later',status:'waiting',wait:{kind:'timer',at:999},updatedAt:100,receipts:[]}]})],[source(p,[task('dismissed',p,{status:'done',resultData:{dismissedAtMs:10}})])]);
  assert.equal(rows.find(row=>row.taskId==='timer').group,'scheduled');
  assert.equal(rows.find(row=>row.taskId==='dismissed').dismissed,true);
});
test('purge verifies selected personal revision and sends only explicit task IDs',async()=>{
  const {purgeWorkspaceTasks}=await import('../src/workspaceTasks.ts');
  assert.equal(typeof purgeWorkspaceTasks,'function');
  const data=personal(assistant(),{revision:9,tasks:[{id:'pt-1',goal:'Research',status:'done',updatedAt:90,receipts:[]}]});
  const [row]=collectWorkspaceTasks([data],[]), calls=[];
  const backend={supports:()=>true,host:{connection:{get:()=>({status:{kind:'connected',hostId:'h1'}})}},call:async(command,args)=>{calls.push({command,args});return {id:'asst-1',hostId:'h1',revision:9,tasks:data.tasks};}};
  await purgeWorkspaceTasks([row],()=>backend);
  assert.equal(calls.at(-1).command,'personal_task_lifecycle');
  assert.deepEqual(calls.at(-1).args.tasks,[{source:'personal',taskId:'pt-1'}]);
  assert.equal(calls.at(-1).args.expectedRevision,9);
  await assert.rejects(()=>purgeWorkspaceTasks([{...row,offline:true}],()=>backend),/offline|Reconnect/i);
  await assert.rejects(()=>purgeWorkspaceTasks([{...row,updatedAt:89}],()=>backend),/changed/i);
});
test('to-dos have independent host-qualified identities and exact permanent deletion',async()=>{
 const {purgeWorkspaceTasks}=await import('../src/workspaceTasks.ts');
 const data=personal(assistant(),{revision:2,todos:[{id:'pt-1',text:'Buy milk',status:'open',createdAt:1,updatedAt:2}]});
 const rows=collectWorkspaceTasks([data],[]),row=rows.find(row=>row.source==='todo');
 assert.ok(row); assert.notEqual(row.key,rows.find(row=>row.source==='personal').key);
 const calls=[];const backend={supports:()=>true,host:{connection:{get:()=>({status:{kind:'connected',hostId:'h1'}})}},call:async(command,args)=>{calls.push({command,args});return {id:'asst-1',hostId:'h1',revision:2,taskManagerTodos:data.todos};}};
 await purgeWorkspaceTasks([row],()=>backend);
 assert.equal(calls.at(-1).command,'personal_todo'); assert.equal(calls.at(-1).args.todoId,'pt-1');assert.equal(calls.at(-1).args.action,'purge');
});
test('project purge uses the exact confirmed owner and revision, refusing new revisions and integration',async()=>{
 const {purgeWorkspaceTasks}=await import('../src/workspaceTasks.ts');
 const p=project(),t=task('same',p,{status:'done'}),data=source(p,[t],{authenticatedHostId:'h1'}),[row]=collectWorkspaceTasks([],[data]);
 const calls=[];const backend={supports:()=>true,host:{connection:{get:()=>({status:{kind:'connected',hostId:'h1'}})}},call:async(command,args)=>{calls.push({command,args});return data.snapshot;}};
 await purgeWorkspaceTasks([row],()=>backend);
 assert.deepEqual(calls.at(-1),{command:'project_task_lifecycle',args:{taskId:'same',revision:3,owner:owner(p),action:'purge'}});
 calls.length=0;t.revision=4;
 await assert.rejects(()=>purgeWorkspaceTasks([row],()=>backend),/changed/);assert.equal(calls.length,1);
 t.revision=3;t.mode='isolated';t.status='interrupted';t.resultData={integrationPlan:{status:'pending'},applyJournal:'pending.json'};
 await assert.rejects(()=>purgeWorkspaceTasks([row],()=>backend),/changed/);assert.equal(calls.filter(call=>call.command==='project_task_lifecycle').length,0);
});
test('batch deletion preflights every confirmed row and refuses unsupported hosts before mutations',async()=>{
 const {purgeWorkspaceTasks}=await import('../src/workspaceTasks.ts');
 const data=personal(assistant(),{revision:9,tasks:[{id:'pt-1',goal:'Research',status:'done',updatedAt:90,receipts:[]}]}),[row]=collectWorkspaceTasks([data],[]);
 let mutations=0;const backend={supports:()=>false,host:{connection:{get:()=>({status:{kind:'connected',hostId:'h1'}})}},call:async()=>{mutations++;}};
 await assert.rejects(()=>purgeWorkspaceTasks([row],()=>backend),/Update/);assert.equal(mutations,0);
 backend.supports=()=>true;
 await assert.rejects(()=>purgeWorkspaceTasks([row,{...row,key:'offline',offline:true}],()=>backend),/offline/);assert.equal(mutations,0);
});
test('partial batch failure reports exact successful keys so remaining rows stay reviewable',async()=>{
 const {purgeWorkspaceTasks}=await import('../src/workspaceTasks.ts');
 const p=project(),data=source(p,[task('one',p,{status:'done'}),task('two',p,{status:'done'})],{authenticatedHostId:'h1'}),rows=collectWorkspaceTasks([],[data]);let mutations=0;
 const backend={supports:()=>true,host:{connection:{get:()=>({status:{kind:'connected',hostId:'h1'}})}},call:async(command)=>{if(command==='assistant_tasks_list')return data.snapshot;if(++mutations===2)throw new Error('Disconnected');return {};}};
 await assert.rejects(()=>purgeWorkspaceTasks(rows,()=>backend),error=>error.purgedKeys?.length===1 && /1 task removed/.test(error.message));
});
test('a concurrent assistant update after the first purge requires reconfirming remaining todos',async()=>{
 const {purgeWorkspaceTasks}=await import('../src/workspaceTasks.ts');
 const record={id:'a',hostId:'h',revision:3,tasks:[],taskManagerTodos:[{id:'one',text:'One',status:'done',updatedAt:1},{id:'two',text:'Two',status:'done',updatedAt:2}]};
 const rows=collectWorkspaceTasks([{assistant:{hostId:'h',assistantId:'a'},name:'A',revision:3,tasks:[],todos:record.taskManagerTodos,offline:false,observedAt:3}],[]);
 const mutations=[];
 const backend={supports:()=>true,host:{connection:{get:()=>({status:{kind:'connected',hostId:'h'}})}},call:async(command,args)=>{if(command==='personal_get')return structuredClone(record);mutations.push(args);return {assistant:{...record,revision:5}};}};
 await assert.rejects(()=>purgeWorkspaceTasks(rows,()=>backend),error=>error.purgedKeys?.length===1&&/changed/i.test(error.message));
 assert.equal(mutations.length,1);
});
test('standalone host schedules stay visible separately from executable task records',()=>{
 const rows=collectWorkspaceTasks([personal(assistant(),{schedules:[{id:'schedule',goal:'Daily report',status:'active',nextAt:999,runs:0,createdAt:10,argv:[]}]})],[]);
 const row=rows.find(row=>row.source==='schedule');assert.ok(row);assert.equal(row.group,'scheduled');assert.equal(row.purgeBlocked,true);
});
test('real failures need attention until explicitly dismissed and remain eligible for cleanup',()=>{
 const p=project();const rows=collectWorkspaceTasks([personal(assistant(),{tasks:[{id:'failed',goal:'Failure',status:'failed',updatedAt:90,receipts:[]},{id:'dismissed',goal:'Old failure',status:'failed',deletedAt:99,updatedAt:90,receipts:[]}]})],[source(p,[task('project-failed',p,{status:'failed'})])]);
 assert.equal(rows.find(row=>row.taskId==='failed').group,'waiting');assert.equal(rows.find(row=>row.taskId==='project-failed').group,'waiting');assert.equal(rows.find(row=>row.taskId==='dismissed').group,'done');
});
test('cancelled schedules remain locked while their generated task has an unfinished receipt',()=>{
 const rows=collectWorkspaceTasks([personal(assistant(),{schedules:[{id:'schedule',goal:'Daily',status:'cancelled',createdAt:10}],tasks:[{id:'run',goal:'Daily run',scheduleId:'schedule',status:'cancelled',updatedAt:20,receipts:[{phase:'attempted',startedAt:20}]}]})],[]);
 assert.equal(rows.find(row=>row.source==='schedule').purgeBlocked,true);
});
test('task search includes authoritative reported results',()=>{
 const p=project();const rows=collectWorkspaceTasks([],[source(p,[task('result',p,{status:'done',result:'Unique result excerpt'})])]);assert.equal(filterWorkspaceTasks(rows,{query:'unique result'}).length,1);
});
