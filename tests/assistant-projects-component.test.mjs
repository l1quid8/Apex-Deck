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
  assert.equal(created,1);const proposal=h.calls.find(call=>call.cmd==='personal_project_delegate_ui');assert.ok(proposal);assert.equal(proposal.args.destination.threadId,'new-thread');assert.equal(proposal.args.brief,'Inspect login');assert.ok(h.calls.findIndex(call=>call.cmd==='assistant_tasks_list')<h.calls.indexOf(proposal));assert.ok(!h.calls.some(call=>call.cmd==='personal_send'));assert.match(text(tree),/Proposal saved/);
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
  find(tree,node=>node.type==='label'&&text(node).includes('I opened and reviewed revision')).children.find(node=>node?.type==='input').props.onChange({target:{checked:true}});tree=h.render();assert.equal(button(tree,'Mark reviewed').props.disabled,false);
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
