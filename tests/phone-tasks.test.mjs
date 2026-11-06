import test from 'node:test';
import assert from 'node:assert/strict';
import { collectPhoneTasks, phoneTaskBackend, phoneTasksNeedAttention, phoneHandoffTasks } from '../src/phone/taskFeed.ts';
const owner = {hostId:'local',workspaceId:'p',cwd:'/p',conversationId:'c'};
const task = {id:'t',owner,workspaceId:'p',status:'ready_for_review',revision:2,originalRequest:'Review result',updatedAtMs:10};
function fixture(tier='full') {
  let status={kind:'connected',hostId:'real-host'};
  let access={tier,threads:'all'};
  const calls=[];
  const host={machine:{id:'local',name:'Mac'},connection:{get:()=>({status})},access:()=>access,backend:{host:{connection:{get:()=>({status})}},call:async (...args)=>calls.push(args)}};
  const input={hosts:[host],projects:[{workspace:{id:'p',path:'/p',name:'Project',hostId:'local'},allowed:tier==='full'}],registry:{owners:{one:{owner,snapshot:{workspaceId:'p',revision:3,tasks:[task],executions:[]},authenticatedHostId:'real-host',observedAt:20}}},assistants:[{ref:{hostId:'real-host',assistantId:'a'},name:'Alfred',personalTasks:[{id:'t',goal:'Personal task',status:'done',updatedAt:5,receipts:[]}],lastSeen:20,revision:4,offline:false}]};
  return {host,input,calls,revoke:()=>{access={tier:'read_only',threads:[]};},disconnect:()=>{status={kind:'disconnected'};}};
}
test('phone collects all personal/project rows with exact authenticated owner and attention',()=>{
  const f=fixture();const rows=collectPhoneTasks(f.input);
  assert.equal(rows.length,2);assert.equal(new Set(rows.map(r=>r.key)).size,2);
  assert.ok(rows.every(row=>row.routeHostId==='local'&&row.verifiedHostId==='real-host'));
  assert.equal(phoneTasksNeedAttention(rows),true);
  assert.ok(rows.every(row=>phoneTaskBackend(row,()=>f.input.hosts)));
});
test('limited access keeps cached rows informative and exposes no detail/mutation backend',()=>{
  const f=fixture('chat');const rows=collectPhoneTasks(f.input);
  assert.equal(rows.length,2);assert.ok(rows.every(r=>r.offline));
  assert.ok(rows.every(row=>phoneTaskBackend(row,()=>f.input.hosts)===null));
});
test('offline and mismatched host identity never authorize tasks',()=>{
 const f=fixture();const rows=collectPhoneTasks(f.input);f.disconnect();
 assert.ok(collectPhoneTasks(f.input).every(row=>row.offline));
 assert.ok(rows.every(row=>phoneTaskBackend(row,()=>f.input.hosts)===null));
 const other=fixture();other.host.connection.get=()=>({status:{kind:'connected',hostId:'other'}});
 assert.ok(rows.every(row=>phoneTaskBackend(row,()=>other.input.hosts)===null));
});
test('retained detail or deletion callbacks reject access revoked since rendering',async()=>{
 const f=fixture();const row=collectPhoneTasks(f.input)[0];const backend=phoneTaskBackend(row,()=>f.input.hosts);
 f.revoke();await assert.rejects(()=>backend.call('project_task_lifecycle',{}),/Full access/);
 assert.equal(f.calls.length,0);
});
test('polling retains a stable phone task backend without weakening live revocation',async()=>{
 const f=fixture();const hosts=()=>f.input.hosts;
 const row=collectPhoneTasks(f.input)[0];const backend=phoneTaskBackend(row,hosts);
 assert.equal(phoneTaskBackend({...row,observedAt:999},hosts),backend);
 f.revoke();await assert.rejects(()=>backend.call('assistant_task_action',{}),/Full access/);
 assert.equal(f.calls.length,0);
});

test('QR paired hosts without an access welcome do not expose task details',()=>{
 const f=fixture();f.host.machine.transport='iroh';f.host.access=()=>null;
 const rows=collectPhoneTasks(f.input);assert.ok(rows.every(row=>row.offline));
 assert.ok(rows.every(row=>phoneTaskBackend(row,()=>f.input.hosts)===null));
});

test('task access also rejects an unpaired/replaced connection retained by a dialog',async()=>{
 const f=fixture();const backend=phoneTaskBackend(collectPhoneTasks(f.input)[0],()=>f.input.hosts);
 f.input.hosts=[];
 await assert.rejects(()=>backend.call('personal_task_lifecycle',{}),/owning machine/);
 assert.equal(f.calls.length,0);
});

test('phone Tasks uses the shared list, complete detail, and owner-qualified thread route',async()=>{
 const {readFile}=await import('node:fs/promises');
 const {transform}=await import('sucrase');
 const React=(await import('react')).default;
 const source=await readFile(new URL('../src/phone/PhoneTasks.tsx',import.meta.url),'utf8');
 const code=transform(source.replace(/^import .*;\n/gm,''),{transforms:['typescript','jsx'],jsxRuntime:'classic'}).code.replace('export function','function');
 const list=(props)=>props;const details=(props)=>props;
 const Component=new Function('React','WorkspaceTasks','WorkspaceTaskDetails',`${code};return PhoneTasks;`)(React,list,details);
 const f=fixture();const rows=collectPhoneTasks(f.input);const calls=[];const resolver=row=>phoneTaskBackend(row,()=>f.input.hosts);
 const tree=Component({rows,problems:[],covered:true,backendForRow:resolver,profiles:[],panes:[],onOpenThread:(row,id)=>calls.push([row,id]),onOpenProject:(row,project)=>calls.push(['project',row,project]),onCreateWorkerThread:async(row,project,profile)=>{calls.push(['create',row,project,profile]);return 'new-worker';}});
 assert.equal(tree.props.inert,true);
 const shared=tree.props.children;assert.equal(shared.type,list);assert.equal(shared.props.rows,rows);assert.equal(shared.props.backendForRow,resolver);
 const detail=shared.props.renderDetail(rows[0]).props.children[1];assert.equal(detail.type,details);
 detail.props.onOpenThread('worker');assert.deepEqual(calls,[[rows[0],'worker']]);
 assert.equal(await detail.props.onCreateWorkerThread({workspaceId:'p'},{id:'worker'}),'new-worker');
 detail.props.onOpenProject({workspaceId:'p'});
 assert.deepEqual(calls.slice(1),[['create',rows[0],{workspaceId:'p'},{id:'worker'}],['project',rows[0],{workspaceId:'p'}]]);
 const app=await readFile(new URL('../src/phone/PhoneApp.tsx',import.meta.url),'utf8');
 assert.match(app,/\[CheckCircle, "Tasks", "tasks"\]/);
 assert.match(app,/item === "tasks" && taskAttention/);
 assert.match(app,/\[Command, "Agents", "agents"\], \[Terminal, "Code", "code"\], \[MessageSquare, "Threads", "threads"\], \[CheckCircle, "Tasks", "tasks"\], \[Folder, "Library", "library"\]/);
});

test('phone shares personal todos and scheduled rows with the same owner and revision',()=>{
 const f=fixture();f.input.assistants[0].taskManagerTodos=[{id:'todo',text:'Call supplier',status:'open',createdAt:1,updatedAt:5,dueAt:Date.now()+86400000}];
 const row=collectPhoneTasks(f.input).find(row=>row.source==='todo');
 assert.equal(row.title,'Call supplier');assert.equal(row.group,'scheduled');
 assert.equal(row.assistantRevision,4);assert.equal(row.routeHostId,'local');assert.equal(row.verifiedHostId,'real-host');
});

test('standalone personal schedules keep owner-qualified routes and Full access gates',()=>{
 const f=fixture();f.input.assistants[0].schedules=[{id:'schedule',goal:'Daily fixture report',argv:['echo','fixture'],dailyAt:'09:00',nextAt:Date.now()+86400000,status:'active',createdAt:5,runs:0,paramsHash:'fixture-hash'}];
 const row=collectPhoneTasks(f.input).find(row=>row.source==='schedule');
 assert.equal(row.group,'scheduled');assert.equal(row.routeHostId,'local');assert.equal(row.verifiedHostId,'real-host');
 assert.ok(phoneTaskBackend(row,()=>f.input.hosts));f.revoke();assert.equal(phoneTaskBackend(row,()=>f.input.hosts),null);
});

test('phone conversation projects only its selected assistant tasks and wires shared controls', async()=>{
 const f=fixture(); const ref={hostId:'real-host',assistantId:'a'};
 f.input.registry.owners.one.snapshot.tasks[0]={...task,lineage:{assistant:ref,project:{hostId:'real-host',workspaceId:'p',cwd:'/p'},sourceEventId:'e',delegationId:'d'}};
 const rows=collectPhoneTasks(f.input);
 assert.deepEqual(phoneHandoffTasks(rows,f.input.registry,ref).map(t=>t.id),['t']);
 assert.deepEqual(phoneHandoffTasks(rows,f.input.registry,{...ref,assistantId:'other'}),[]);
 const app=await (await import('node:fs/promises')).readFile(new URL('../src/phone/PhoneApp.tsx',import.meta.url),'utf8');
 assert.match(app,/delegatedTasks=\{handoffTasks\}/);
 assert.match(app,/onOpenProjectTask=\{openHandoffTask\}/);
 assert.match(app,/WorkspaceTaskDetails row=\{handoffDetail\}/);
 assert.match(app, /<\/Sheet>\}\s*<\/div>\}\s*\{assistantWorkspace/, "task sheet must share the conversation stacking context");
});
