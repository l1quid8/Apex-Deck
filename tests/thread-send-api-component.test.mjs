import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import electron from 'electron';
import {createServer} from 'vite';
import {runElectronScenario} from './helpers/electron-test.mjs';
const cases=JSON.parse(fs.readFileSync(new URL('../shared/media-naming.json',import.meta.url),'utf8')).cases;
test('real ChatPane admits slices, preserves routing and quote leads, retries after move and cancels on close', {timeout:120000},async()=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'thread-send-'));
 const html=`<html><body><div id="test-root"></div><script type="module">
 import React from 'react';import {createRoot} from 'react-dom/client';import {ChatPane} from '/src/ChatPane.tsx';import {getBackend} from '/src/backend.ts';import {modHost} from '/src/mods/host.ts';import {mentionTarget} from '/src/recipients.ts';import '/src/styles.css';
 const root=createRoot(document.getElementById('test-root'));const names=['null','allison','muck'];
 const bots=names.map(id=>({id,display_name:id[0].toUpperCase()+id.slice(1),persona:'',access:'read',effort:null,backend:{kind:'scripted',lines:['[pass]']}}));
 const f=window.f={api:null,posts:[],saves:[],listeners:[],default:'null',mod:undefined,active:[],holdSave:false,host:'local',waiting:false,blocked:false,picked:[],opened:0,refs:[],savedResolve:null,
  state(){return {recovery_seq:1,snapshot:{participants:bots,options:{policy:'mention',max_bot_hops:3},transcript:[{seq:1,speaker:{kind:'bot',id:'allison'},text:'the first cut',at:1}]},active:this.active,approvals:[]};},
  mount(){const backend=makeBackend(this.host);root.render(React.createElement(ChatPane,{pane:{id:'r1',workspaceId:'w1',kind:'chat',title:'Thread'},cwd:'/tmp/project',agents:[],backend,focused:true,onActivity(){},profiles:[],onProfilesChange(){},disabledProviders:[],onSendApi:register,tagThreads:[{paneId:'linux',hostId:'B',title:'Linux Desktop App',project:'Linux Project'},{paneId:'external',hostId:'C',title:'External App',project:'Other Project',outside:true}],multiWaiting:f.waiting,multiBlocked:f.blocked,onOpenMulti(){f.opened++;},onTagThread(...args){f.picked.push(args);f.api.clearDraft();}}));},
  unmount(){root.render(null);},emit(event){this.listeners.forEach(fn=>fn('r1',event));},idle(){names.forEach(id=>this.emit({type:'participant_idle',id}));},
  text(value){const el=document.querySelector('.composer textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,value);el.dispatchEvent(new Event('input',{bubbles:true}));},
  enter(){document.querySelector('.composer textarea').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));},
  submit(p){const ref=this.api.submit({text:p.text,routing:p.routing??p.text,files:p.files??[],to:p.to??null,tldr:p.tldr??false});this.refs.push(ref);return ref;},
 };
 const register=(id,api)=>{f.api=api;};
 modHost.promptSubmit=async(_room,text)=>f.mod===undefined?{text}:f.mod==='DENY'?{text,deny:'Mod refused'}:{text:f.mod};
 const base=await getBackend();
 const connectionState={status:{kind:'connected',hostId:'B'},revision:1,hostId:'B',name:'B',agents:[],discovery:'done'};
 const makeBackend=host=>({...base,host:host==='local'?undefined:{id:host,name:host,connection:{get:()=>connectionState,subscribe:()=>()=>{}}},
 roomCreate:async()=>f.state().snapshot,roomState:async()=>f.state(),roomClose:async()=>{},roomSteps:async()=>null,roomRefreshPlans:async()=>{},listToolServers:async()=>[],
 roomTargets:async(_room,text)=>{const target=mentionTarget(text,bots);return target==='everyone'?names:target.length?target:[f.default];},
 roomPostTo:async(room,text,to,_a,_v,keepDefault)=>{f.posts.push({room,text,to,keepDefault,host});if(!keepDefault&&to.length)f.default=to[0];setTimeout(()=>f.idle(),0);},
 saveAttachment:async(room,name,bytes)=>{f.saves.push({room,name,bytes:[...bytes],host});if(f.holdSave)await new Promise(r=>f.savedResolve=r);return '/tmp/@muck/'+name;},
 onRoomEvent:async fn=>{f.listeners.push(fn);return()=>{f.listeners=f.listeners.filter(x=>x!==fn);};},onPtyData:async()=>()=>{},onPtyExit:async()=>()=>{},postCapabilities:async()=>({keep_default_v1:true}),});
 f.mount();window.ready=true;
 </script></body></html>`;
 const server=await createServer({cacheDir:path.join(temp,'cache'),server:{port:0},logLevel:'error',plugins:[{name:'thread-send-test',configureServer(s){s.middlewares.use('/__send',async(_req,res)=>{res.setHeader('Content-Type','text/html');res.end(await s.transformIndexHtml('/__send',html));});}}]});await server.listen();
 const main=path.join(temp,'main.cjs');fs.writeFileSync(main,`
 const {app,BrowserWindow}=require('electron');const assert=require('node:assert/strict');
 app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,width:1000,height:800,webPreferences:{contextIsolation:true}});win.webContents.on('console-message',(_e,...args)=>console.log(...args));const run=(fn,...args)=>win.webContents.executeJavaScript('('+fn.toString()+')(...'+JSON.stringify(args)+')');const wait=async(fn,label)=>{for(let i=0;i<600;i++){if(await run(fn))return;await new Promise(r=>setTimeout(r,20));}throw Error('Timeout '+label+' '+await run(()=>document.body.innerText.slice(-1000)));};try{
 await win.loadURL(${JSON.stringify(`http://localhost:${server.httpServer.address().port}/__send`)});await wait(()=>window.f?.api?.agents().length===3&&document.querySelector('.composer textarea:not(:disabled)'),'pane ready');
 const initial=await run(()=>{window.f.posts=[];const before=window.f.posts.length;const ref=window.f.submit({text:'hi'});return {ref,before,after:window.f.posts.length,queue:window.f.api.queue};});assert.equal(initial.before,initial.after);assert.equal(initial.ref.queue,initial.queue);await wait(()=>window.f.posts.length===1,'first slice');assert.equal(await run(()=>window.f.posts[0].text),'hi');
 for(const c of ${JSON.stringify(cases)}){await run(c=>{f.idle();f.api.clearDraft();f.posts=[];f.mod=c.mod;f.default=c.name==='named by no one'?'allison':'null';},c);await new Promise(r=>setTimeout(r,80));if(c.picked){await run(c=>f.submit({text:c.typed,to:c.picked,tldr:c.tldr}),c);}else{if(c.quote)await run(()=>document.querySelector('[aria-label="Quote response from Allison"]').click());await run(c=>f.text(c.typed),c);await new Promise(r=>setTimeout(r,30));await run(c=>{const pill=document.querySelector('[aria-label="TL;DR mode"]');if((pill.getAttribute('aria-pressed')==='true')!==c.tldr)pill.click();},c);await run(()=>f.enter());}await wait(()=>f.posts.length===1,c.name);const posted=await run(()=>f.posts[0]);assert.equal(posted.text,c.posted,c.name);if(c.picked){assert.deepEqual(posted.to,c.picked);assert.equal(posted.keepDefault,true);assert.equal(await run(()=>f.default),'null');}}

 // Single # conversion carries text and TL;DR; waiting drafts and quotes block it.
 await run(()=>{f.idle();f.api.clearDraft();f.mod=undefined;f.text('please check this #Lin');});await wait(()=>document.querySelector('[aria-label="Threads"] [role="option"]'),'single thread picker');await run(()=>{const pill=document.querySelector('[aria-label="TL;DR mode"]');if(pill.getAttribute('aria-pressed')!=='true')pill.click();});await run(()=>document.querySelector('[aria-label="Threads"] [role="option"]').click());assert.deepEqual(await run(()=>f.picked.at(-1)),['r1',{paneId:'linux',hostId:'B'},{text:'please check this #Lin',tldr:true},18,22]);await wait(()=>f.api.draft().text==='','source cleared by conversion');
 await run(()=>{f.waiting=true;f.mount();});await run(()=>f.text('kept #Lin'));await wait(()=>document.body.innerText.includes('A multi-thread message is waiting'),'waiting notice');assert.equal(await run(()=>document.querySelector('[aria-label="Threads"] [role="option"]').disabled),true);await run(()=>Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Open it').click());assert.equal(await run(()=>f.opened),1);assert.equal(await run(()=>f.api.draft().text),'kept #Lin');
 await run(()=>{f.waiting=false;f.mount();});await run(()=>document.querySelector('[aria-label="Quote response from Allison"]').click());await run(()=>f.text('quoted #Lin'));await wait(()=>document.body.innerText.includes("Send or remove this thread's pictures and quotes first"),'quote refusal');assert.equal(await run(()=>document.querySelector('[aria-label="Threads"] [role="option"]').disabled),true);assert.equal(await run(()=>f.api.draft().quotes),1);await run(()=>f.api.clearDraft());
 // A queued picked item edits only its typed part, retaining pictures and TL;DR.
 await run(()=>{f.idle();f.api.clearDraft();f.posts=[];f.mod=undefined;f.emit({type:'turn_started',id:'muck'});f.ref=f.submit({text:'hi',to:['muck'],tldr:true,files:[{id:'file',label:'Image1',name:'@muck screenshot.png',bytes:new Uint8Array([1,2]),previewUrl:null}]});});await wait(()=>document.querySelector('.q-text')?.textContent==='hi','queued typed line');
 for(const value of ['', 'hello']){await run(()=>document.querySelector('.q-text').click());await wait(()=>document.querySelector('.q-edit'),'edit');assert.ok(!(await run(()=>document.querySelector('.q-edit').value)).includes('Attached image'));await run(value=>{const el=document.querySelector('.q-edit');el.value=value;el.dispatchEvent(new FocusEvent('focusout',{bubbles:true}));},value);await new Promise(r=>setTimeout(r,50));}
 await run(()=>f.idle());await wait(()=>f.posts.length===1,'edited post');assert.equal(await run(()=>f.posts[0].text.startsWith('@muck hello\\n\\nAttached image: ')),true,JSON.stringify(await run(()=>f.posts[0])));assert.equal(await run(()=>f.posts[0].keepDefault),true);assert.equal(await run(()=>f.saves.at(-1).name.includes('@')),false);
 // Cancel a held save by closing; reopening must have a different queue identity.
 await run(()=>{f.idle();f.posts=[];f.holdSave=true;f.oldApi=f.api;f.ref=f.submit({text:'held',files:[{id:'f',label:'Image',name:'x.png',bytes:new Uint8Array([3]),previewUrl:null}]});});await wait(()=>!!f.savedResolve,'save held');await run(()=>f.unmount());await wait(()=>f.api===null,'unregistered');assert.equal(await run(()=>f.oldApi.status(f.ref)),'closed');await run(()=>{f.holdSave=false;f.savedResolve();f.mount();});await wait(()=>!!f.api,'reopened');await new Promise(r=>setTimeout(r,80));assert.equal(await run(()=>f.posts.length),0);assert.equal(await run(()=>f.api.status(f.ref)),'unknown');assert.equal(await run(()=>f.api.retry(f.ref)),'gone');
 // A suspended slice retries using the backend of the moved thread.
 await run(()=>{f.release=f.api.suspend('Moving');f.moveRef=f.submit({text:'moved',files:[{id:'f2',label:'Image',name:'move.png',bytes:new Uint8Array([4]),previewUrl:null}]});});await wait(()=>f.api.status(f.moveRef)==='failed','move refusal');await run(()=>{f.host='B';f.mount();});await wait(()=>f.api?.hostId==='B','new host');await run(()=>{f.release();f.api.retry(f.moveRef);});await wait(()=>f.posts.length===1,'retry on new host');assert.equal(await run(()=>f.posts[0].host),'B');assert.equal(await run(()=>f.saves.at(-1).host),'B');
 console.log('THREAD_SEND_COMPONENT_OK');win.destroy();app.exit(0);
 }catch(error){console.error(error.stack);app.exit(1);}});
 `);
 try{const result=await runElectronScenario(electron,main,temp,{timeoutMs:60000,attempts:1});assert.equal(result.code,0,result.output);assert.match(result.output,/THREAD_SEND_COMPONENT_OK/);}finally{await server.close();fs.rmSync(temp,{recursive:true,force:true});}
});
