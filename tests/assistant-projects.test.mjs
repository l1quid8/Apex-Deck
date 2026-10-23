import test from 'node:test';
import assert from 'node:assert/strict';
import { projectTasks, assignmentBlocked, activeProjectTask } from '../src/assistantProjectsModel.ts';
import { createProjectMemoryClient } from '../src/projectMemory.ts';
const assistant={hostId:'host',assistantId:'assistant'};
const project={hostId:'host',workspaceId:'workspace',cwd:'/work/project'};
const owner={hostId:'route-host',workspaceId:'workspace',cwd:'/work/project',conversationId:'monitor'};
const task={id:'task',workspaceId:'workspace',owner,lineage:{assistant,project,sourceEventId:'event',delegationId:'delegation'},status:'running'};
const snapshot=tasks=>({workspaceId:'workspace',project,tasks,executions:[],revision:1});
test('project task selection requires exact lineage, project identity and monitor scope',()=>{
  assert.deepEqual(projectTasks(snapshot([task,{...task,id:'other',lineage:{...task.lineage,assistant:{...assistant,assistantId:'other'}}},{...task,id:'old',owner:{...owner,conversationId:'previous'}}]),owner,project,assistant).map(t=>t.id),['task']);
  assert.throws(()=>projectTasks({...snapshot([task]),project:{...project,cwd:'/work/other'}},owner,project,assistant),/different project/);
  assert.throws(()=>projectTasks(snapshot([{...task,owner:{...owner,cwd:'/work/other'}}]),owner,project,assistant),/different project folder/);
  assert.throws(()=>projectTasks({...snapshot([task]),project:undefined},owner,{...project,hostId:'other'},assistant),/not on the assistant/);
});
test('assignment UI only offers existing host folder grants with path boundaries',()=>{
  const record={hostId:'host',allowedFolders:['/work/project']};
  assert.equal(assignmentBlocked(record,project),undefined);
  assert.equal(assignmentBlocked(record,{...project,cwd:'/work/project/child'}),undefined);
  assert.match(assignmentBlocked(record,{...project,cwd:'/work/project-copy'}),/outside/);
  assert.match(assignmentBlocked(record,{...project,hostId:'other'}),/machine/);
});
test('assignments waiting for review remain active until explicitly completed',()=>{
  assert.equal(activeProjectTask({status:'ready_for_review'}),true);
  assert.equal(activeProjectTask({status:'done'}),false);
});
const source={project,taskId:'task',attempt:1,runId:'run',expectedTaskRevision:7,text:'Verified result',kind:'fact'};
function client(call) {return createProjectMemoryClient({assistant,route:{supports:()=>true,call},assertAvailable(){},assertBinding(candidate){assert.deepEqual(candidate,project);}});}
test('scratch is staged separately and explicit promotion sends only inspected provenance',async()=>{
  const calls=[];
  const api=client(async(command,args)=>{
    calls.push({command,args});
    if(command==='project_memory_stage')return {...source,assistant,id:'scratch',createdAt:1,expiresAt:10};
    return {project,assistant,taskId:'task',attempt:1,runId:'run',scratchId:'scratch',expectedTaskRevision:7,promotionId:'promotion',noteId:'note',noteVersion:1,promotedAt:2};
  });
  const scratch=await api.stage(source);
  assert.deepEqual(calls.map(c=>c.command),['project_memory_stage']);
  const receipt=await api.promote({...scratch,promotionId:'promotion'});
  assert.equal(receipt.noteId,'note');
  assert.deepEqual(calls[1],{command:'project_memory_promote',args:{assistant,project,taskId:'task',attempt:1,runId:'run',scratchId:'scratch',expectedTaskRevision:7,promotionId:'promotion'}});
});
test('scratch and promotion reject mismatched evidence, revisions, owners and malformed requests',async()=>{
  await assert.rejects(client(async()=>({...source,assistant,id:'scratch',attempt:2})).stage(source),/different task/);
  await assert.rejects(client(async()=>({...source,assistant:{...assistant,assistantId:'other'},id:'scratch'})).stage(source),/different task/);
  await assert.rejects(client(async()=>{throw new Error('must not call');}).stage({...source,attempt:0}),/completed result excerpt/);
  await assert.rejects(client(async()=>{throw new Error('must not call');}).promote({...source,id:'scratch',promotionId:''}),/Review/);
  await assert.rejects(client(async()=>({project,assistant,taskId:'other',runId:'run',attempt:1,scratchId:'scratch',promotionId:'promotion',noteId:'note',noteVersion:1})).promote({...source,id:'scratch',promotionId:'promotion'}),/different evidence/);
});
