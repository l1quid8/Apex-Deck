import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createServer } from 'vite';
import { runElectronScenario } from './helpers/electron-test.mjs';

const electron = createRequire(import.meta.url)('electron');
const fixtureModule = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {WorkspaceTasks} from '/src/WorkspaceTasksScreen.tsx';
import {WorkspaceTaskDetails} from '/src/WorkspaceTaskDetails.tsx';
import {PhoneTasks} from '/src/phone/PhoneTasks.tsx';
import '/src/phone/phone.css';
import {collectWorkspaceTasks} from '/src/workspaceTasks.ts';
import '/src/phone/phone-tasks.css';
const root=createRoot(document.getElementById('root'));
const owner={hostId:'fixture-host',workspaceId:'fixture-project',cwd:'/fixture/project',conversationId:'fixture-monitor'};
let record,project,calls=[],phone=false,generation=0;
const fail=message=>{throw new Error(message)};
const exact=(args,keys)=>{for(const key of Object.keys(args))if(!keys.includes(key))fail('Unexpected payload field '+key);};
const backend={host:{connection:{get:()=>({status:{kind:'connected',hostId:'fixture-host'}})}},supports:()=>true,call:async(command,args)=>{
 calls.push({command,args:structuredClone(args)});
 if(command==='personal_get'){exact(args,['assistantId']);if(args.assistantId!==record.id)fail('Wrong assistant');return structuredClone(record);}
 if(command==='assistant_tasks_list'){exact(args,['owner','includeDiffs']);if(JSON.stringify(args.owner)!==JSON.stringify(owner))fail('Wrong project owner');return {workspaceId:owner.workspaceId,revision:1,tasks:structuredClone(project),executions:[]};}
 if(command==='project_task_lifecycle'){exact(args,['owner','revision','taskId','action']);if(JSON.stringify(args.owner)!==JSON.stringify(owner)||args.action!=='purge')fail('Wrong project purge owner/action');const task=project.find(t=>t.id===args.taskId);if(!task||task.revision!==args.revision)fail('Wrong project revision');project=project.filter(t=>t!==task);refresh();return {};}
 if(command==='personal_schedule_cancel'){exact(args,['assistantId','scheduleId','requestId']);if(args.assistantId!==record.id||args.scheduleId!=='standalone'||!args.requestId)fail('Wrong schedule cancellation');record.schedules[0].status='cancelled';record.revision++;refresh();return {assistant:structuredClone(record)};}
 if(command==='personal_todo'){
  exact(args,['assistantId','expectedRevision','action','text','dueAt','remindAt','todoId']);
  if(args.assistantId!==record.id||args.expectedRevision!==record.revision)fail('Stale todo owner/revision');
  if(args.action==='add'){if(!args.text||!Number.isFinite(args.dueAt)||!Number.isFinite(args.remindAt))fail('Missing scheduled todo fields');record.taskManagerTodos.push({id:'added',text:args.text,status:'open',createdAt:100,updatedAt:100,dueAt:args.dueAt,remindAt:args.remindAt});}
  else {const todo=record.taskManagerTodos.find(t=>t.id===args.todoId);if(!todo)fail('Wrong todo ID');if(args.action==='complete')todo.status='done';else if(args.action==='purge')record.taskManagerTodos=record.taskManagerTodos.filter(t=>t!==todo);else fail('Unsupported todo action');}
  record.revision++;refresh();return {assistant:structuredClone(record)};
 }
 if(command==='personal_task_lifecycle'){
  exact(args,['assistantId','expectedRevision','action','tasks']);if(args.assistantId!==record.id||args.expectedRevision!==record.revision||args.action!=='purge'||!args.tasks.length)fail('Invalid personal purge');
  for(const ref of args.tasks){exact(ref,['source','taskId']);const task=record.tasks.find(t=>t.id===ref.taskId);if(ref.source!=='personal'||!task||task.status!=='done')fail('Unsafe personal purge');}
  record.tasks=record.tasks.filter(t=>!args.tasks.some(ref=>ref.taskId===t.id));record.revision++;refresh();return {assistant:structuredClone(record)};
 }
 fail('Unexpected command '+command);
}};
function sources(){return [{assistant:{hostId:record.hostId,assistantId:record.id},name:'Alfred',hostName:'Fixture Mac',tasks:record.tasks,todos:record.taskManagerTodos,schedules:record.schedules,revision:record.revision,offline:false,observedAt:100,routeHostId:'fixture-route'}];}
function refresh(){const personal=sources();const rows=collectWorkspaceTasks(personal,[{project:{hostId:owner.hostId,workspaceId:owner.workspaceId,cwd:owner.cwd},owner,name:'Fixture Project',hostName:'Fixture Mac',snapshot:{workspaceId:owner.workspaceId,revision:1,tasks:project,executions:[]},authenticatedHostId:owner.hostId,offline:false,observedAt:100}]);root.render(phone?<div key={generation} className='ph-app' style={{height:'100dvh'}}><div className='phone-frame'><PhoneTasks rows={rows} problems={[]} covered={false} personalSources={personal} backendForRow={()=>backend} profiles={[]} panes={[]} onOpenThread={()=>{}}/></div></div>:<main key={generation}><WorkspaceTasks rows={rows} personalSources={personal} backendForRow={()=>backend} renderDetail={row=><WorkspaceTaskDetails row={row} backend={backend} profiles={[]} panes={[]}/>}/></main>);}
window.fixture={reset(isPhone){generation++;phone=isPhone;calls=[];localStorage.clear();record={id:'fixture-assistant',hostId:'fixture-host',revision:1,name:'Alfred',schedules:[{id:'standalone',goal:'Daily fixture schedule',argv:['echo','fixture'],dailyAt:'09:00',nextAt:Date.now()+86400000,status:'active',createdAt:5,runs:0,paramsHash:'fixture-hash'}],tasks:[{id:'active',goal:'Active task',status:'running',updatedAt:10,receipts:[]},{id:'done-a',goal:'Finished alpha',status:'done',updatedAt:20,receipts:[]},{id:'done-b',goal:'Finished beta',status:'done',updatedAt:30,receipts:[]},{id:'dismissed',goal:'Dismissed finished',status:'done',updatedAt:40,deletedAt:50,receipts:[]}],taskManagerTodos:[{id:'open',text:'Call supplier',status:'open',createdAt:1,updatedAt:2},{id:'scheduled',text:'Future reminder',status:'open',createdAt:1,updatedAt:3,dueAt:Date.now()+86400000}]};project=[{id:'project-done',workspaceId:owner.workspaceId,owner,originalRequest:'Finished project',status:'done',revision:4,createdAtMs:1,updatedAtMs:50,resultData:null}];refresh();},removeAdded(){record.taskManagerTodos=record.taskManagerTodos.filter(todo=>todo.id!=='added');record.revision++;refresh();},state:()=>structuredClone({record,project,calls})};
window.fixture.reset(false);
`;

test('real task manager is touch safe and preserves exact deletion scope at narrow desktop and phone widths', {timeout:180000}, async()=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'task-manager-dom-'));
 const shots='/tmp/task-manager-qa';fs.mkdirSync(shots,{recursive:true});
 const fixtureFile=path.join(temp,'fixture.jsx');fs.writeFileSync(fixtureFile,fixtureModule);
 const server=await createServer({cacheDir:path.join(temp,'vite-cache'),server:{port:0,fs:{allow:[process.cwd(),temp]}},logLevel:'error',plugins:[{name:'task-manager-test-page',configureServer(server){server.middlewares.use('/__task-manager.html',async(_req,res)=>{res.setHeader('Content-Type','text/html');res.end(await server.transformIndexHtml('/__task-manager.html',
 `<html><head><style>:root{--text:#ddd;--muted:#aaa;--panel:#181b20;--bg:#181b20;--line:#333;--accent:#67d4bf;--danger:#ed7777;--hover:#30343b}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px system-ui}button,input,select{color:inherit;background:#252a30;border:1px solid #444}main{width:100%}</style></head><body><div id="root"></div><script type="module" src="/@fs${fixtureFile}"></script></body></html>`));});}}]});
 await server.listen();const url=`http://localhost:${server.httpServer.address().port}/__task-manager.html`;
 const main=path.join(temp,'main.cjs');fs.writeFileSync(main,`
 const {app,BrowserWindow}=require('electron');const assert=require('node:assert/strict');const fs=require('node:fs');
 app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,width:332,height:850,useContentSize:true,webPreferences:{sandbox:true,contextIsolation:true}});const run=code=>win.webContents.executeJavaScript(code).catch(error=>{console.error('FAILED JS',code);throw error;});const sleep=ms=>new Promise(r=>setTimeout(r,ms));
 const until=async(code,label)=>{for(let i=0;i<600;i++){if(await run(code))return;await sleep(20);}assert.fail('Timeout '+label+' '+await run('document.body.innerText'));};
 const frame=async()=>{await run('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');};
 const click=async(text)=>{await run('(()=>{const b=[...document.querySelectorAll("button")].find(b=>b.textContent.trim()==='+JSON.stringify(text)+' && b.getClientRects().length);if(!b)throw Error("Missing button "+'+JSON.stringify(text)+');b.click()})()');await frame();};
 const set=async(selector,value)=>{await run('(()=>{const e=document.querySelector('+JSON.stringify(selector.startsWith('[')?'input'+selector:selector)+');const setter=Object.getOwnPropertyDescriptor(e instanceof HTMLSelectElement?HTMLSelectElement.prototype:HTMLInputElement.prototype,"value").set;setter.call(e,'+JSON.stringify(value)+');e.dispatchEvent(new Event(e instanceof HTMLSelectElement?"change":"input",{bubbles:true}));})()');await frame();};
 const overflow=async()=>assert.ok(await run('document.documentElement.scrollWidth<=innerWidth && [...document.querySelectorAll(".workspace-tasks, .workspace-tasks-add-options, [role=alertdialog]")].every(e=>e.getBoundingClientRect().right<=innerWidth+1)'), 'horizontal overflow');
 const dialog=async()=>{await until('!!document.querySelector("[role=alertdialog]")','confirmation');assert.equal(await run('document.activeElement.textContent.trim()'),'Cancel');await run('document.activeElement.dispatchEvent(new KeyboardEvent("keydown",{key:"Tab",shiftKey:true,bubbles:true,cancelable:true}))');assert.equal(await run('document.activeElement.textContent.trim()'),'Delete permanently');await run('document.activeElement.dispatchEvent(new KeyboardEvent("keydown",{key:"Tab",bubbles:true,cancelable:true}))');assert.equal(await run('document.activeElement.textContent.trim()'),'Cancel');await overflow();fs.writeFileSync('/tmp/task-manager-qa'+'/'+win.getContentSize()[0]+'-confirmation.png',(await win.webContents.capturePage()).toPNG());};
 try{await win.loadURL(${JSON.stringify(url)});await until('!!window.fixture && !!document.querySelector(".workspace-tasks")','fixture');
 for(const [width,phone] of [[332,false],[390,true]]){
 win.setContentSize(width,850);await run('fixture.reset('+phone+')');await until('!!document.querySelector("[aria-label=\\\\"Delete Finished alpha\\\\"]")','reset');await frame();
 for(const name of ['Needs you','In progress','Scheduled','Done'])assert.ok(await run('document.body.innerText.includes('+JSON.stringify(name)+')'));
 await overflow();assert.equal(await run('document.querySelector("[aria-label=\\\\"Delete Active task\\\\"]").disabled'),true);
 assert.equal(await run('document.querySelector(".workspace-tasks-group:last-of-type h3 button").getAttribute("aria-expanded")'),'false');
 await click('▸ Done 3');await run('document.querySelector("[aria-label=\\\\"Delete Finished alpha\\\\"]").click()');await dialog();await run('document.activeElement.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))');await frame();assert.equal(await run('!!document.querySelector("[role=alertdialog]")'),false);
 await run('document.querySelector("[aria-label=\\\\"Delete Finished alpha\\\\"]").click()');await dialog();await click('Delete permanently');await until('!document.querySelector("[aria-label=\\\\"Delete Finished alpha\\\\"]")','single purge');
 await run('document.querySelector("[aria-label=\\\\"Select tasks\\\\"]").click()');await frame();await run('document.querySelector("[aria-label=\\\\"Select Finished beta\\\\"]").click();document.querySelector("[aria-label=\\\\"Select Finished project\\\\"]").click()');await frame();await click('Delete 2');await dialog();await click('Delete permanently');await until('fixture.state().project.length===0','multi purge');
 await click('Show dismissed (1)');await frame();assert.ok(await run('document.body.innerText.includes("Dismissed finished")'));
 await run('document.querySelector("[aria-label=\\\\"Search tasks\\\\"]").click()');await set('[aria-label="Search tasks"]','Active');assert.equal(await run('[...document.querySelectorAll("button")].some(b=>b.textContent.startsWith("Clear finished")&&b.getClientRects().length)'),false);await set('[aria-label="Search tasks"]','');
 await click('Clear finished (1)');await dialog();assert.ok(await run('document.querySelector("[role=alertdialog]").innerText.includes("Dismissed finished")'));await click('Delete permanently');await until('!fixture.state().record.tasks.some(t=>t.id==="dismissed")','dismissed purge');
 await set('[aria-label="Add a to-do or hand off a task"]','Schedule QA call');await set('.workspace-tasks-add-options label:first-of-type input','2030-11-02T12:00');await set('.workspace-tasks-add-options label:last-of-type input','2030-11-02T11:45');await overflow();await click('Add');await until('fixture.state().record.taskManagerTodos.some(t=>t.id==="added")','todo add');await until('[...document.querySelectorAll(".workspace-task-row strong")].some(e=>e.textContent==="Schedule QA call")','added row');
 await run('[...document.querySelectorAll(".workspace-task-row")].find(e=>e.querySelector("strong").textContent==="Schedule QA call").click()');await until('!!document.querySelector(".workspace-todo-detail")','todo detail');assert.ok(await run('document.body.innerText.includes("Reminder")&&document.body.innerText.includes("Due")'));if(phone)assert.ok(await run('document.querySelector(".workspace-detail-actions").getBoundingClientRect().bottom>innerHeight-100 && document.querySelector(".workspace-detail-actions").getBoundingClientRect().bottom<=innerHeight'),'phone actions within thumb reach');await click('Mark done');await until('fixture.state().record.taskManagerTodos.find(t=>t.id==="added").status==="done"','todo completion');await until('document.body.innerText.includes("Mark open")','completion rendered');assert.ok(await run('document.body.innerText.includes("Reminder cancelled on completion")'));await overflow();
 fs.writeFileSync(${JSON.stringify(shots)}+'/'+width+'-todo-detail.png',(await win.webContents.capturePage()).toPNG());await click('‹ Tasks');await frame();fs.writeFileSync(${JSON.stringify(shots)}+'/'+width+'-list.png',(await win.webContents.capturePage()).toPNG());
 await run('fixture.removeAdded()');await frame();assert.ok(await run('![...document.querySelectorAll(".workspace-task-row strong")].some(e=>e.textContent==="Schedule QA call")'),'authoritative external deletion retires optimistic todo');
 await run('[...document.querySelectorAll(".workspace-task-row")].find(e=>e.querySelector("strong").textContent==="Daily fixture schedule").click()');await until('document.body.innerText.includes("Cancel schedule")','schedule detail');if(phone)assert.ok(await run('document.querySelector(".workspace-detail-actions").getBoundingClientRect().bottom>innerHeight-100'),'schedule actions within thumb reach');await click('Cancel schedule');await until('fixture.state().record.schedules[0].status==="cancelled"','schedule cancelled');
 const state=await run('fixture.state()');assert.deepEqual(state.record.tasks.map(t=>t.id),['active']);assert.equal(state.project.length,0);assert.ok(state.calls.some(c=>c.command==='personal_todo'&&c.args.action==='add'&&Number.isFinite(c.args.dueAt)&&Number.isFinite(c.args.remindAt)));
 console.log('PASS '+width+'px '+(phone?'iPhone':'desktop panel')+' exact purge, modal focus, todo schedule/complete, cleanup, no overflow');
 }
 app.exit(0);}catch(error){console.error(error);app.exit(1);}});
 `);
 try{const result=await runElectronScenario(electron,main,temp,{timeoutMs:150000,attempts:1});console.log(result.output);assert.equal(result.code,0,result.output);}finally{await server.close();fs.rmSync(temp,{recursive:true,force:true});}
});
