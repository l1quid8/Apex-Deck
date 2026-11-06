import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transform } from 'sucrase';
import * as model from '../src/workspaceTasks.ts';
import * as identity from '../src/assistantIdentity.ts';
import * as delegation from '../src/taskManagerDelegation.ts';
const source=await fs.readFile(new URL('../src/WorkspaceTasksScreen.tsx',import.meta.url),'utf8');
const code=transform(source.replace(/^import .*;\n/gm,'').replace(/export (function|const)/g,'$1'),{transforms:['typescript','jsx'],jsxRuntime:'classic'}).code;
const {WorkspaceTasks}=new Function('React','useState','useRef','useEffect','model','identity','delegation',`const {parseTaskQuickAdd,proposeWorkerTask}=delegation; const {collectWorkspaceTasks,filterWorkspaceTasks,canPurgeWorkspaceTask,purgeWorkspaceTasks,guardWorkspaceTaskBackend}=model; const {assistantIdentityKey,projectIdentityKey}=identity; ${code}; return {WorkspaceTasks};`)(React,React.useState,React.useRef,React.useEffect,model,identity,delegation);
const row={key:'row',source:'project',assistant:null,project:{hostId:'host',workspaceId:'project',cwd:'/project'},taskId:'t1',title:'Preserve owner',status:'queued',updatedAt:100,observedAt:200,offline:true,group:'working',assistantName:'Unassigned',projectName:'Project',owner:{hostId:'host',workspaceId:'project',cwd:'/project',conversationId:'m1'},revision:4};
test('global task list labels filters, owner, stale observation and real lifecycle without a composer',()=>{
  const html=renderToStaticMarkup(React.createElement(WorkspaceTasks,{rows:[row],renderDetail:()=>null}));
  for(const label of ['Search tasks','Filter by assistant','Filter by project','Task status']) assert.match(html,new RegExp(`aria-label="${label}"`));
  assert.match(html,/Preserve owner/); assert.match(html,/Project/); assert.match(html,/Unassigned/); assert.match(html,/Offline/); assert.match(html,/Last updated/);
  assert.match(html,/In progress/); assert.doesNotMatch(html,/<textarea|contenteditable|Send message/);
});
test('global empty state distinguishes no tasks from unavailable sources',()=>{
  const html=renderToStaticMarkup(React.createElement(WorkspaceTasks,{rows:[],problems:['Project host unavailable'],renderDetail:()=>null}));
  assert.match(html,/Project host unavailable/); assert.match(html,/No saved tasks/);
});

test('compact manager exposes selection and dismissed cleanup while Done starts collapsed',()=>{
  const html=renderToStaticMarkup(React.createElement(WorkspaceTasks,{rows:[{...row,key:'done',status:'done',offline:false,group:'done'},{...row,key:'dismissed',dismissed:true,status:'done',group:'done'}],renderDetail:()=>null}));
  assert.match(html,/Select tasks/); assert.match(html,/Show dismissed \(1\)/); assert.match(html,/Clear finished/);
  assert.match(html,/aria-expanded="false"/); assert.match(html,/<time[^>]+dateTime=/);
});
function harness(props, delegationOverrides={}) {
  const states=[];let cursor=0;let effects=[];const timers=new Map();let timerId=0;
  const effect=(run,deps)=>{const index=cursor++;const previous=states[index];if(!previous||deps.some((value,index)=>!Object.is(value,previous[index]))){states[index]=deps;effects.push(run);}};
  const hook=initial=>{const index=cursor++;if(!(index in states))states[index]=typeof initial==='function'?initial():initial;return[states[index],next=>{states[index]=typeof next==='function'?next(states[index]):next;}];};
  const Component=new Function('React','useState','useRef','useEffect','setInterval','clearInterval','model','identity','delegation',`const {parseTaskQuickAdd,proposeWorkerTask}=delegation; const {collectWorkspaceTasks,filterWorkspaceTasks,canPurgeWorkspaceTask,purgeWorkspaceTasks,guardWorkspaceTaskBackend}=model; const {assistantIdentityKey,projectIdentityKey}=identity; ${code}; return WorkspaceTasks;`)(React,hook,initial=>{const index=cursor++;return states[index]??=( {current:initial} );},effect,(run)=>{const id=++timerId;timers.set(id,run);return id;},id=>timers.delete(id),model,identity,{...delegation,...delegationOverrides});
  return {async poll(){for(const run of timers.values())await run();},render(next=props){props=next;cursor=0;effects=[];const tree=Component(props);effects.forEach(run=>run());return tree;}};
}
function elements(node){if(!node||typeof node!=='object')return[];if(Array.isArray(node))return node.flatMap(elements);return[node,...elements(node.props?.children)];}
const settle=()=>new Promise(resolve=>setImmediate(resolve));
test('quick add sends authoritative todo payload without lifecycle-unsupported requestId; handoff accepts event receipt',async()=>{
 const calls=[];const record={id:'asst',hostId:'host',revision:7,tasks:[],taskManagerTodos:[]};
 const backend={supports:()=>true,host:{connection:{get:()=>({status:{kind:'connected',hostId:'host'}})}},call:async(command,args)=>{calls.push({command,args});return command==='personal_get'?record:{eventId:'accepted'};}};
 const view=harness({rows:[],personalSources:[{assistant:{hostId:'host',assistantId:'asst'},name:'Alfred',revision:7,tasks:[],offline:false,observedAt:100,routeHostId:'local'}],backendForRow:()=>backend,renderDetail:()=>null});
 elements(view.render()).find(node=>node.props?.['aria-label']==='Add a to-do or hand off a task').props.onChange({target:{value:'Buy milk'}});
 elements(view.render()).find(node=>node.type==='form').props.onSubmit({preventDefault(){}});await settle();
 assert.deepEqual(calls.find(call=>call.command==='personal_todo').args,{assistantId:'asst',expectedRevision:7,action:'add',text:'Buy milk'});
 elements(view.render()).find(node=>node.props?.['aria-label']==='Add a to-do or hand off a task').props.onChange({target:{value:'@alfred research milk'}});
 elements(view.render()).find(node=>node.type==='form').props.onSubmit({preventDefault(){}});await settle();
 const handoff=calls.find(call=>call.command==='personal_send');assert.equal(handoff.args.text,'research milk');assert.equal(typeof handoff.args.requestId,'string');assert.equal(handoff.args.expectedRevision,undefined);
 assert.ok(!elements(view.render()).some(node=>node.props?.role==='alert'));
});
test('delete confirmation captures exact rows, focuses Cancel and keeps Clear finished hidden during search',()=>{
 const target={...row,key:'complete',status:'done',group:'done',offline:false,verifiedHostId:'host',routeHostId:'local'};
 const view=harness({rows:[target],backendForRow:()=>({supports:()=>true}),renderDetail:()=>null});
 elements(view.render()).find(node=>node.props?.['aria-label']==='Delete Preserve owner').props.onClick();
 const dialog=elements(view.render()).find(node=>node.props?.role==='alertdialog');assert.ok(dialog);
 const cancel=elements(dialog).find(node=>node.type==='button'&&node.props.children==='Cancel');assert.equal(cancel.props.autoFocus,true);let focused=false;cancel.props.ref({focus(){focused=true;}});assert.ok(focused);
 assert.match(renderToStaticMarkup(dialog),/Worker conversations, accepted changes, project notebooks and worktrees are kept/);
 cancel.props.onClick();
 elements(view.render()).find(node=>node.type==='input'&&node.props.type==='search').props.onChange({target:{value:'Preserve'}});
 assert.ok(!elements(view.render()).some(node=>node.type==='button'&&String(node.props.children).startsWith('Clear finished')));
});

test('acknowledged quick-added project proposal cannot resurrect after external deletion',async()=>{
 const assistant={hostId:'host',assistantId:'asst'};const project={hostId:'host',workspaceId:'project',cwd:'/project'};
 const proposal={...row,key:'proposal',assistant,project,source:'project',title:'New worker proposal',status:'proposed',offline:false,group:'waiting',verifiedHostId:'host',routeHostId:'local'};
 const source={assistant,name:'Alfred',revision:7,tasks:[],offline:false,observedAt:100,routeHostId:'local'};
 const profile={id:'null',display_name:'Null',backend:{kind:'codex'},persona:'',access:'read',effort:null};
 const props={rows:[],personalSources:[source],profiles:[profile],delegationTargets:[{assistant,project,name:'Project'}],backendForRow:()=>({supports:()=>true}),renderDetail:()=>null};
 const view=harness(props,{proposeWorkerTask:async()=>[proposal]});
 elements(view.render()).find(node=>node.props?.['aria-label']==='Add a to-do or hand off a task').props.onChange({target:{value:'@null Inspect'}});
 elements(view.render()).find(node=>node.props?.['aria-label']==='Worker task project').props.onChange({target:{value:identity.projectIdentityKey(project)}});
 elements(view.render()).find(node=>node.type==='form').props.onSubmit({preventDefault(){}});await settle();
 assert.match(renderToStaticMarkup(view.render()),/New worker proposal/);
 view.render({...props,rows:[proposal]});
 assert.doesNotMatch(renderToStaticMarkup(view.render(props)),/New worker proposal/);
});

test('unobserved optimistic project rows retire only after guarded authoritative absence',async()=>{
 const assistant={hostId:'host',assistantId:'asst'};const project={hostId:'host',workspaceId:'project',cwd:'/project'};
 const proposal={...row,key:'proposal',assistant,project,source:'project',title:'Unobserved proposal',status:'proposed',offline:false,group:'waiting',verifiedHostId:'host',routeHostId:'local'};
 const source={assistant,name:'Alfred',revision:7,tasks:[],offline:false,observedAt:100,routeHostId:'local'};
 const profile={id:'null',display_name:'Null',backend:{kind:'codex'},persona:'',access:'read',effort:null};
 let kind='offline';let created=0;
 const backend={supports:()=>true,host:{connection:{get:()=>({status:{kind:'connected',hostId:kind==='offline'?'other':'host'}})}},call:async()=>{if(kind==='error')throw Error('offline');return {workspaceId:'project',project:kind==='forged'?{...project,cwd:'/other'}:project,revision:99,tasks:[],executions:[]};}};
 const props={rows:[],personalSources:[source],profiles:[profile],delegationTargets:[{assistant,project,name:'Project'}],backendForRow:()=>backend,renderDetail:()=>null};
 const view=harness(props,{proposeWorkerTask:async()=>{created++;return[proposal];}});
 elements(view.render()).find(node=>node.props?.['aria-label']==='Add a to-do or hand off a task').props.onChange({target:{value:'@null Inspect'}});
 elements(view.render()).find(node=>node.props?.['aria-label']==='Worker task project').props.onChange({target:{value:identity.projectIdentityKey(project)}});
 elements(view.render()).find(node=>node.type==='form').props.onSubmit({preventDefault(){}});await settle();
 assert.equal(created,1);
 for(kind of ['offline','error','forged']){view.render({...props,backendForRow:()=>backend});await view.poll();assert.match(renderToStaticMarkup(view.render()),/Unobserved proposal/);}
 kind='absent';view.render({...props,backendForRow:()=>backend});await view.poll();
 assert.doesNotMatch(renderToStaticMarkup(view.render()),/Unobserved proposal/);
});
test('unsupported worker host cannot create a destination thread or proposal',async()=>{
 const assistant={hostId:'host',assistantId:'asst'};const project={hostId:'host',workspaceId:'project',cwd:'/project'};let proposals=0;
 const profile={id:'null',display_name:'Null',backend:{kind:'codex'},persona:'',access:'read',effort:null};
 const view=harness({rows:[],personalSources:[{assistant,name:'Alfred',tasks:[],offline:false,observedAt:1}],profiles:[profile],delegationTargets:[{assistant,project,name:'Project'}],backendForRow:()=>({supports:()=>false}),renderDetail:()=>null},{proposeWorkerTask:async()=>{proposals++;return[];}});
 elements(view.render()).find(node=>node.props?.['aria-label']==='Add a to-do or hand off a task').props.onChange({target:{value:'@null Inspect'}});
 elements(view.render()).find(node=>node.props?.['aria-label']==='Worker task project').props.onChange({target:{value:identity.projectIdentityKey(project)}});
 elements(view.render()).find(node=>node.type==='form').props.onSubmit({preventDefault(){}});await settle();
 assert.equal(proposals,0);assert.match(renderToStaticMarkup(view.render()),/Update the owning machine/);
});
test('worker quick add wires project chooser and real proposal helper without sending or starting work',async()=>{
 const assistant={hostId:'host',assistantId:'asst'};const project={hostId:'host',workspaceId:'project',cwd:'/project'};
 const owner={...project,hostId:'local',conversationId:'monitor'};
 const profile={id:'null',display_name:'Null',backend:{kind:'codex'},persona:'',access:'read',effort:null};
 const record={id:'asst',hostId:'host',revision:8,name:'Alfred',profile,projects:[{project,tools:'ask'}],tasks:[]};
 const calls=[];const creations=[];let proposal=null;
 const backend={supports:()=>true,host:{connection:{get:()=>({status:{kind:'connected',hostId:'host'}})}},call:async(command,args)=>{
  calls.push({command,args});
  if(command==='personal_get')return record;
  if(command==='monitor_get')return owner;
  if(command==='assistant_tasks_list')return {workspaceId:'project',project,revision:12,tasks:proposal?[proposal]:[],executions:[]};
  if(command==='personal_project_propose_ui'){
   proposal={id:'worker-proposal',workspaceId:'project',owner,revision:1,status:'proposed',originalRequest:args.brief,brief:args.brief,updatedAtMs:Date.now(),attempts:[],lineage:{assistant,project,delegationId:args.delegationId,sourceEventId:'human-event'}};
   return {taskId:proposal.id};
  }
  throw Error(`Unexpected command: ${command}`);
 }};
 const view=harness({rows:[],personalSources:[{assistant,name:'Alfred',tasks:[],revision:8,offline:false,observedAt:100,routeHostId:'local'}],profiles:[profile],delegationTargets:[{assistant,project,name:'Chosen project'}],backendForRow:()=>backend,onCreateWorkerThread:async(...args)=>{creations.push(args);return 'saved-worker-thread';},renderDetail:()=>null});
 elements(view.render()).find(node=>node.props?.['aria-label']==='Add a to-do or hand off a task').props.onChange({target:{value:'@Null Inspect permissions'}});
 let tree=view.render();const chooser=elements(tree).find(node=>node.props?.['aria-label']==='Worker task project');
 assert.ok(chooser);assert.ok(elements(chooser).some(node=>node.type==='option'&&node.props.children==='Chosen project'));
 const submit=elements(tree).find(node=>node.type==='button'&&node.props.type==='submit');assert.equal(submit.props.disabled,true);
 chooser.props.onChange({target:{value:identity.projectIdentityKey(project)}});
 tree=view.render();assert.equal(elements(tree).find(node=>node.type==='button'&&node.props.type==='submit').props.disabled,false);
 elements(tree).find(node=>node.type==='form').props.onSubmit({preventDefault(){}});await settle();
 assert.deepEqual(creations,[[project,profile,assistant]]);
 const saved=calls.find(call=>call.command==='personal_project_propose_ui');assert.ok(saved);assert.equal(saved.args.brief,'Inspect permissions');assert.equal(saved.args.expectedRevision,8);assert.deepEqual(saved.args.project,project);assert.deepEqual(saved.args.destination,{threadId:'saved-worker-thread',workers:['null'],newThread:false});assert.equal(saved.args.mode,'read_only');
 const html=renderToStaticMarkup(view.render());assert.match(html,/Inspect permissions/);assert.match(html,/Alfred · Chosen project · proposed/);
 assert.ok(calls.every(call=>!['personal_todo','personal_send','assistant_task_action','assistant_task_approve','personal_project_delegate_ui'].includes(call.command)));
});
