import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {transform} from 'sucrase';
import * as identity from '../src/assistantIdentity.ts';
import * as model from '../src/assistantProjectsModel.ts';
import * as tasks from '../src/assistantTaskModel.ts';
const source=await fs.readFile(new URL('../src/AssistantProjects.tsx',import.meta.url),'utf8');
const compiled=transform(source.replace(/^import .*;\n/gm,'').replace('export function AssistantProjects','function AssistantProjects'),{transforms:['typescript','jsx'],jsxRuntime:'classic'}).code;
const text=node=>node==null||typeof node==='boolean'?'':typeof node==='string'||typeof node==='number'?String(node):Array.isArray(node)?node.map(text).join(' '):text(node.children??[]);
const find=(node,predicate)=>{if(!node||typeof node!=='object')return null;if(Array.isArray(node)){for(const child of node){const match=find(child,predicate);if(match)return match;}return null;}if(predicate(node))return node;return find(node.children??[],predicate);};
const button=(tree,label)=>find(tree,node=>node.type==='button'&&text(node)===label);
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
const project={hostId:'host',workspaceId:'workspace',cwd:'/work/project'};
const owner={hostId:'route-host',workspaceId:'workspace',cwd:'/work/project',conversationId:'monitor'};
const profile={id:'worker',display_name:'Codex',backend:{kind:'agent',tool:'codex'}};
const record={id:'assistant',hostId:'host',revision:3,allowedFolders:['/work'],projects:[{project,tools:'ask'}],messages:[]};
const baseTask={id:'task',workspaceId:'workspace',owner,lineage:{assistant:{hostId:'host',assistantId:'assistant'},project,sourceEventId:'event',delegationId:'delegation'},status:'running',brief:'Inspect login',originalRequest:'Inspect login',workers:['worker'],attempts:[],reviewCriteria:[],result:null,revision:2,mode:'read_only',destination:{threadId:'thread',workers:['worker'],newThread:false},resultData:{}};
function harness(extra={},initialTask=null,routingThreads=[]){
  const calls=[],states=[],refs=[],effects=[];let cursor=0,task=initialTask;
  const React={createElement:(type,props,...children)=>({type,props:props??{},children:children.flat(Infinity)})};
  const hooks={useState(initial){const i=cursor++;if(!(i in states))states[i]=typeof initial==='function'?initial():initial;return [states[i],next=>{states[i]=typeof next==='function'?next(states[i]):next;}];},useRef(initial){const i=cursor++;return refs[i]??={current:initial};},useEffect(fn,deps){const i=cursor++,before=effects[i];if(!before||deps.some((value,index)=>!Object.is(value,before.deps[index])))effects[i]={fn,deps,changed:true,cleanup:before?.cleanup};}};
  const deps={...identity,...model,...tasks};
  const component=new Function('React',...Object.keys(hooks),...Object.keys(deps),`${compiled};return AssistantProjects;`)(React,...Object.values(hooks),...Object.values(deps));
  const backend={demo:false,call:async(cmd,args)=>{calls.push({cmd,args});if(cmd==='assistant_tasks_list')return {project,workspaceId:'workspace',tasks:task?[task]:[],routingThreads,executions:[],revision:1};if(cmd==='assistant_task_action'){task={...task,status:args.action==='pause'?task.status:args.action==='resume'?task.status:args.action==='accept'||args.action==='review'?'done':'cancelled',desiredState:args.action==='pause'?'paused':'running',revision:task.revision+1};return task;}return {taskId:'new',status:'proposed'};}};
  const props={lane:{assistant:record,name:'Ada',offline:false},backend,projects:[{project,name:'Project'}],availableProjects:[{project,name:'Project'}],taskScopes:[],profiles:[profile],...extra};
  const render=()=>{cursor=0;const tree=component(props);for(const effect of effects)if(effect?.changed){effect.changed=false;effect.cleanup?.();effect.cleanup=effect.fn();}return tree;};
  return {render,calls,backend};
}
test('first delegation explicitly creates coordinator, shows live worker picker, refreshes new room then proposes without a model send',async()=>{
  let ensured=0,created=0;
  const h=harness({onEnsureCoordinator:async target=>{assert.deepEqual(target,project);ensured++;return {project,owner};},onCreateWorkerThread:async(target,worker)=>{assert.deepEqual(target,project);assert.deepEqual(worker,profile);created++;return 'new-thread';}});
  let tree=h.render();await tick();tree=h.render();assert.equal(ensured,0);
  await button(tree,'Delegate a task').props.onClick();tree=h.render();await tick();tree=h.render();
  assert.equal(ensured,1);assert.ok(find(tree,node=>node.props.role==='dialog'));
  find(tree,node=>node.type==='select'&&node.props['aria-label']==='Worker').props.onChange({target:{value:'worker'}});
  find(tree,node=>node.type==='textarea'&&node.props['aria-label']==='Task brief').props.onChange({target:{value:'Inspect login'}});
  tree=h.render();find(tree,node=>node.type==='form').props.onSubmit({preventDefault(){}});await tick();tree=h.render();await tick();tree=h.render();
  assert.equal(created,1);const proposal=h.calls.find(call=>call.cmd==='personal_project_delegate_ui');assert.ok(proposal);assert.equal(proposal.args.destination.threadId,'new-thread');assert.equal(proposal.args.brief,'Inspect login');assert.equal(proposal.args.mode,'read_only');assert.ok(h.calls.findIndex(call=>call.cmd==='assistant_tasks_list')<h.calls.indexOf(proposal));assert.ok(!h.calls.some(call=>call.cmd==='personal_send'));assert.match(text(tree),/Proposal saved/);
});
test('task pause and resume use the recorded task owner and current revision',async()=>{
  const h=harness({taskScopes:[{project,owner}]},baseTask);let tree=h.render();await tick();tree=h.render();
  find(tree,node=>node.type==='button'&&node.props.className==='assistant-project-task').props.onClick();tree=h.render();
  button(tree,'Pause task').props.onClick();await tick();tree=h.render();const pause=h.calls.find(call=>call.cmd==='assistant_task_action');assert.equal(pause.args.action,'pause');assert.deepEqual(pause.args.owner,owner);assert.equal(pause.args.revision,2);
  button(tree,'Resume task').props.onClick();await tick();tree=h.render();assert.equal(h.calls.filter(call=>call.cmd==='assistant_task_action')[1].args.action,'resume');
});
test('accepting a result requires opening evidence and acknowledging the current revision and each criterion',async()=>{
  const h=harness({taskScopes:[{project,owner}]},{...baseTask,status:'ready_for_review',result:'Reviewed result',reviewCriteria:['Tests pass']});let tree=h.render();await tick();tree=h.render();find(tree,node=>node.type==='button'&&node.props.className==='assistant-project-task').props.onClick();tree=h.render();
  assert.equal(button(tree,'Mark reviewed').props.disabled,true);
  find(tree,node=>node.type==='details'&&text(node).includes('Inspect result, changes and checks')).props.onToggle({currentTarget:{open:true}});tree=h.render();
  find(tree,node=>node.type==='label'&&/I reviewed:\s+Tests pass/.test(text(node))).children.find(node=>node?.type==='input').props.onChange({target:{checked:true}});
  tree=h.render();assert.equal(find(tree,node=>node.type==='label'&&text(node).includes('I opened and reviewed revision')),null);assert.equal(button(tree,'Mark reviewed').props.disabled,false);
  button(tree,'Mark reviewed').props.onClick();await tick();const action=h.calls.find(call=>call.cmd==='assistant_task_action');assert.equal(action.args.action,'review');assert.equal(action.args.revision,2);
});
for(const [status,label,action] of [['running','Cancel task','cancel'],['failed','Retry task','retry'],['proposed','Approve task','approve']])test(`${label} submits the host-owned task revision`,async()=>{
  const h=harness({taskScopes:[{project,owner}]},{...baseTask,status});let tree=h.render();await tick();tree=h.render();find(tree,node=>node.type==='button'&&node.props.className==='assistant-project-task').props.onClick();tree=h.render();assert.equal(button(tree,label).props.disabled,false);button(tree,label).props.onClick();await tick();const call=h.calls.find(call=>call.cmd==='assistant_task_action');assert.equal(call.args.action,action);assert.equal(call.args.taskId,baseTask.id);assert.equal(call.args.revision,baseTask.revision);assert.deepEqual(call.args.owner,owner);if(action==='approve')assert.deepEqual(call.args.destination,baseTask.destination);
});
for(const changed of [false,true])test(`delegation ${changed?'creates current worker room when saved config changed':'reuses saved worker only with identical complete configuration'}`,async()=>{
  let created=0;const saved=changed?{...profile,access:'read',backend:{kind:'open_ai_compatible',base_url:'http://old.invalid',model:'old'}}:{...profile};
  const h=harness({taskScopes:[{project,owner}],onCreateWorkerThread:async(target,current)=>{created++;assert.deepEqual(current,profile);return 'current-worker-thread';}},null,[{id:'saved-thread',workers:[saved]}]);
  let tree=h.render();await tick();tree=h.render();await button(tree,'Delegate a task').props.onClick();tree=h.render();await tick();tree=h.render();find(tree,node=>node.type==='select'&&node.props['aria-label']==='Worker').props.onChange({target:{value:'worker'}});find(tree,node=>node.type==='textarea'&&node.props['aria-label']==='Task brief').props.onChange({target:{value:'Inspect login'}});tree=h.render();find(tree,node=>node.type==='form').props.onSubmit({preventDefault(){}});await tick();tree=h.render();await tick();
  assert.equal(created,changed?1:0);assert.equal(h.calls.find(call=>call.cmd==='personal_project_delegate_ui').args.destination.threadId,changed?'current-worker-thread':'saved-thread');
});

test('assigned project can be removed before any delegation or task snapshot; host validates final revision',async()=>{
  const saved=[];const h=harness({lane:{assistant:record,name:'Ada',offline:false,configureWorkspace:async input=>saved.push(input)}});
  let tree=h.render();await tick();tree=h.render();button(tree,'Assign projects').props.onClick();tree=h.render();
  const dialog=find(tree,node=>node.props.role==='dialog');const checkbox=find(dialog,node=>node.type==='input'&&node.props.type==='checkbox');
  assert.equal(checkbox.props.checked,true);assert.equal(checkbox.props.disabled,false);checkbox.props.onChange({target:{checked:false}});tree=h.render();
  assert.equal(find(find(tree,node=>node.props.role==='dialog'),node=>node.type==='input'&&node.props.type==='checkbox').props.checked,false);
  find(tree,node=>node.type==='form').props.onSubmit({preventDefault(){}});await tick();
  assert.deepEqual(saved,[{expectedRevision:record.revision,projects:[]}]);assert.ok(!h.calls.some(call=>call.cmd==='assistant_tasks_list'||call.cmd==='personal_project_delegate_ui'));
});

test('fresh discovered folder inside existing grants is assignable before its first coordinator or task',async()=>{
  const qa={hostId:'host',workspaceId:'fresh-qa',cwd:'/Users/tylercaldwell/apex-assistant/fidelity-qa'};
  const saved=[];const h=harness({lane:{assistant:{...record,projects:[],allowedFolders:['/Users/tylercaldwell/apex-assistant']},name:'Fidelity QA',offline:false,configureWorkspace:async input=>saved.push(input)},projects:[],availableProjects:[{project,name:'apex-deck'},{project:qa,name:'fidelity-qa'}]});
  let tree=h.render();await tick();tree=h.render();button(tree,'Assign projects').props.onClick();tree=h.render();
  let dialog=find(tree,node=>node.props.role==='dialog');const outside=find(dialog,node=>node.type==='label'&&text(node).includes('apex-deck'));assert.equal(find(outside,node=>node.type==='input').props.disabled,true);
  const qaLabel=find(dialog,node=>node.type==='label'&&text(node).includes('fidelity-qa'));const checkbox=find(qaLabel,node=>node.type==='input');assert.equal(checkbox.props.disabled,false);checkbox.props.onChange({target:{checked:true}});tree=h.render();
  find(tree,node=>node.type==='form').props.onSubmit({preventDefault(){}});await tick();
  assert.deepEqual(saved,[{expectedRevision:record.revision,projects:[{project:qa,tools:'ask'}]}]);assert.equal(h.calls.length,0);
});

test('unverified candidates remain visible with exact folder failure and cannot be assigned',async()=>{
  const h=harness({lane:{assistant:record,name:'Ada',offline:false,configureWorkspace:async()=>{}},unavailableProjects:[{id:'unavailable-project',name:'fidelity-qa',path:'/work/fidelity-qa',problem:'Folder permission denied.'}]});let tree=h.render();await tick();tree=h.render();button(tree,'Assign projects').props.onClick();tree=h.render();const dialog=find(tree,node=>node.props.role==='dialog');const label=find(dialog,node=>node.type==='label'&&text(node).includes('fidelity-qa'));assert.equal(find(label,node=>node.type==='input').props.disabled,true);assert.match(text(dialog),/Folder permission denied/);
});

test('failed delegated work stays assigned until explicit cancellation, then the project can be removed',async()=>{
  const saved=[];const h=harness({lane:{assistant:record,name:'Ada',offline:false,configureWorkspace:async input=>saved.push(input)},taskScopes:[{project,owner}]},{...baseTask,status:'failed',result:'Git preparation failed.'});let tree=h.render();await tick();tree=h.render();
  button(tree,'Assign projects').props.onClick();tree=h.render();let dialog=find(tree,node=>node.props.role==='dialog');let checkbox=find(dialog,node=>node.type==='input'&&node.props.type==='checkbox');assert.equal(checkbox.props.disabled,true);assert.match(text(dialog),/Finish or cancel active assignments before removing/);
  find(dialog,node=>node.type==='button'&&node.props['aria-label']==='Close dialog').props.onClick();tree=h.render();find(tree,node=>node.type==='button'&&node.props.className==='assistant-project-task').props.onClick();tree=h.render();assert.equal(button(tree,'Cancel task').props.disabled,false);button(tree,'Cancel task').props.onClick();await tick();tree=h.render();
  assert.equal(h.calls.find(call=>call.cmd==='assistant_task_action').args.action,'cancel');button(tree,'← Projects').props.onClick();tree=h.render();button(tree,'Assign projects').props.onClick();tree=h.render();dialog=find(tree,node=>node.props.role==='dialog');checkbox=find(dialog,node=>node.type==='input'&&node.props.type==='checkbox');assert.equal(checkbox.props.disabled,false);checkbox.props.onChange({target:{checked:false}});tree=h.render();find(tree,node=>node.type==='form').props.onSubmit({preventDefault(){}});await tick();assert.deepEqual(saved,[{expectedRevision:record.revision,projects:[]}]);
});

test('separate-copy editing mode is sent only after explicit Task access selection',async()=>{
 const h=harness({taskScopes:[{project,owner}],onCreateWorkerThread:async()=> 'new-thread'});let tree=h.render();await tick();tree=h.render();await button(tree,'Delegate a task').props.onClick();tree=h.render();await tick();tree=h.render();const access=find(tree,node=>node.type==='select'&&node.props['aria-label']==='Task access');assert.equal(access.props.value,'read_only');assert.match(text(tree),/cannot edit project files/);access.props.onChange({target:{value:'isolated'}});find(tree,node=>node.type==='select'&&node.props['aria-label']==='Worker').props.onChange({target:{value:'worker'}});find(tree,node=>node.type==='textarea'&&node.props['aria-label']==='Task brief').props.onChange({target:{value:'Edit in a separate copy'}});tree=h.render();assert.match(text(tree),/compatible worker/);find(tree,node=>node.type==='form').props.onSubmit({preventDefault(){}});await tick();await tick();assert.equal(h.calls.find(call=>call.cmd==='personal_project_delegate_ui').args.mode,'isolated');
});

test('Project tools Off blocks new delegation regardless of read-only default',async()=>{
 const h=harness({lane:{assistant:{...record,projects:[{project,tools:'off'}]},name:'Ada',offline:false},taskScopes:[{project,owner}],onCreateWorkerThread:async()=>{assert.fail('must not create worker');}});let tree=h.render();await tick();tree=h.render();assert.equal(button(tree,'Delegate a task').props.disabled,true);await button(tree,'Delegate a task').props.onClick();tree=h.render();assert.equal(find(tree,node=>node.props.role==='dialog'),null);assert.ok(!h.calls.some(call=>call.cmd==='personal_project_delegate_ui'));
});

test('Assign projects explicitly allows one exact folder without losing the assignment draft',async()=>{
 const outside={project:{...project,workspaceId:'outside',cwd:'/outside/exact'},name:'Outside'};const saves=[];
 const h=harness({availableProjects:[{project,name:'Project'},outside],lane:{assistant:record,name:'Ada',offline:false,configureWorkspace:async input=>saves.push(input)}});
 h.backend.supports=cap=>cap==='assistant_project_folder_grant_v1';
 const originalCall=h.backend.call;h.backend.call=async(cmd,args)=>cmd==='personal_workspace_configure'?(h.calls.push({cmd,args}),{assistant:{...record,revision:4,allowedFolders:[...record.allowedFolders,'/outside/exact']}}):originalCall(cmd,args);
 h.render();let tree=h.render();button(tree,'Assign projects').props.onClick();tree=h.render();
 const row=()=>find(h.render(),node=>node.props.className==='assistant-project-assignment'&&text(node).includes('Outside'));
 assert.equal(find(row(),node=>node.type==='input').props.disabled,true);
 button(row(),'Allow this folder…').props.onClick();assert.match(text(h.render()),/\/outside\/exact/);assert.equal(h.calls.filter(c=>c.cmd==='personal_workspace_configure').length,0);
 button(h.render(),'Cancel folder access').props.onClick();assert.equal(h.calls.filter(c=>c.cmd==='personal_workspace_configure').length,0);
 button(row(),'Allow this folder…').props.onClick();await button(h.render(),'Allow this folder').props.onClick();await tick();tree=h.render();
 assert.deepEqual(h.calls.find(c=>c.cmd==='personal_workspace_configure').args,{assistantId:'assistant',expectedRevision:3,folderGrant:outside.project});
 assert.equal(find(row(),node=>node.type==='input').props.disabled,false);assert.equal(find(row(),node=>node.type==='input').props.checked,false);
 find(row(),node=>node.type==='input').props.onChange({target:{checked:true}});tree=h.render();find(tree,node=>node.type==='form').props.onSubmit({preventDefault(){}});await tick();
 assert.equal(saves[0].expectedRevision,4);assert.deepEqual(saves[0].projects,[{project,tools:'ask'},{project:outside.project,tools:'ask'}]);assert.equal(saves[0].folderGrant,undefined);
});

test('compact mode hides the intro, stats and filter for the Work view',async()=>{
  const h=harness({compact:true});let tree=h.render();await tick();tree=h.render();
  assert.equal(find(tree,node=>node.props?.className==='assistant-project-intro'),null);
  assert.equal(find(tree,node=>node.props?.className==='assistant-project-overview'),null);
  assert.equal(find(tree,node=>node.type==='select'&&node.props['aria-label']==='Projects to show'),null);
  assert.ok(button(tree,'Assign projects'),'actions stay');
});
test('project cards show the folder, not the host id',async()=>{
  const h=harness();let tree=h.render();await tick();tree=h.render();
  const card=find(tree,node=>node.props?.className==='assistant-project-card');
  assert.match(text(card),/\/work\/project/);assert.doesNotMatch(text(card),/host\s*·/);
});
test('focusTask selects that task when Work opens it',async()=>{
  const h=harness({taskScopes:[{project,owner}],focusTask:{project,taskId:'task'}},{...baseTask,status:'ready_for_review',result:'Done'});let tree=h.render();await tick();tree=h.render();await tick();tree=h.render();
  assert.match(text(tree),/Inspect result, changes and checks/);
});
