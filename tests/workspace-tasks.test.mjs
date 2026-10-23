import test from 'node:test';
import assert from 'node:assert/strict';
import { collectWorkspaceTasks, filterWorkspaceTasks, workspaceTaskRoute, workspaceTaskKey, reconcileWorkspaceTaskSources, personalTaskForRow } from '../src/workspaceTasks.ts';

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
test('personal timer/dependency waits stay working while an open approval needs the human',()=>{
  const rows=collectWorkspaceTasks([personal(assistant(),{tasks:[
    {id:'timer',goal:'Scheduled wait',status:'waiting',wait:{kind:'timer',at:999},updatedAt:100,receipts:[]},
    {id:'approval',goal:'Approval',status:'needsYou',decision:{status:'open'},updatedAt:100,receipts:[]},
  ]})],[]);
  assert.equal(rows.find(row=>row.taskId==='timer').group,'working');
  assert.equal(rows.find(row=>row.taskId==='approval').group,'waiting');
});
