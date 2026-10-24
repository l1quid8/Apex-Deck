import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import electron from 'electron';
import { createServer } from 'vite';
import { runElectronScenario } from './helpers/electron-test.mjs';

// The Details sidebar takes a real 320px column out of the chat, and the
// session strip has to keep centring on the chat that is left. Below the
// container's 760px it overlays the chat instead of squeezing it.
test('the assistant Details column sits beside the chat and overlays it when narrow', {timeout:120000}, async()=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'assistant-details-'));
 const html=`<div id="root"></div><script type="module">
 import React from 'react';import {createRoot} from 'react-dom/client';
 import '/src/styles.css';import '/src/glass-theme.css';
 import {AssistantWorkspace} from '/src/AssistantWorkspace.tsx';
 import {AssistantDetails} from '/src/AssistantDetails.tsx';
 const h=React.createElement;
 const lane={name:'Approved Flow QA',hostName:'local',assistant:{id:'qa',name:'Approved Flow QA',projects:[],tasks:[]}};
 const chat=h('div',{className:'apex-agent-tabpanel'},h('p',{style:{height:2000}},'A long conversation scrolls behind the strip.'));
 const patch='diff --git a/src/App.tsx b/src/App.tsx\\n--- a/src/App.tsx\\n+++ b/src/App.tsx\\n@@ -1 +1,2 @@\\n-a\\n+b\\n+c\\n';
 createRoot(document.getElementById('root')).render(h('div',{className:'app assistant-active',style:{width:1400,height:800}},h('div',{className:'body'},h('aside',{style:{flex:'0 0 280px'}}),h('main',{className:'canvas section-threads',id:'canvas'},h('div',{className:'assistant-main',id:'assistant-main'},h(AssistantWorkspace,{lane,section:'chat',onNavigate(){},chat,projects:null,editor:null,detailsOpen:true}),h(AssistantDetails,{lane,outputs:[{id:'o1',name:'brief.md',kind:'doc',folder:'notes',at:5},{id:'o2',name:'data.json',kind:'data',folder:'out',path:'out/data.json',at:0}],onClose(){},onNavigate(){}}))))));
 window.setCanvas=w=>{const c=document.getElementById('canvas');c.style.flex='0 0 '+w+'px';};
 window.detailsState=()=>{const rect=e=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right,width:r.width,height:r.height,top:r.top};};
  const main=document.getElementById('assistant-main');const aside=document.querySelector('.assistant-details');const ws=document.querySelector('.assistant-workspace');const head=document.querySelector('.assistant-workspace-head');const capsule=document.querySelector('.assistant-session');const panel=document.querySelector('.apex-agent-tabpanel');const style=getComputedStyle(aside);
  return {main:rect(main),aside:rect(aside),workspace:rect(ws),head:rect(head),capsule:rect(capsule),position:style.position,asideWidth:style.width,panelPadTop:getComputedStyle(panel).paddingTop,rows:document.querySelectorAll('.assistant-output').length,overflowsX:main.scrollWidth-main.clientWidth};};
 </script>`;
 const server=await createServer({cacheDir:path.join(temp,'vite-cache'),server:{port:0},logLevel:'error',plugins:[{name:'assistant-details',configureServer(s){s.middlewares.use('/__assistant_details',async(_q,res)=>{res.setHeader('Content-Type','text/html');res.end(await s.transformIndexHtml('/__assistant_details',html));});}}]});await server.listen();
 const main=path.join(temp,'main.cjs');
 fs.writeFileSync(main,`const {app,BrowserWindow}=require('electron');const assert=require('node:assert/strict');app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,width:1500,height:900,webPreferences:{offscreen:true}});win.webContents.on('console-message',(...args)=>console.error('renderer:',...args.map(x=>typeof x==='object'?x?.message??'':x)));const run=c=>win.webContents.executeJavaScript(c);const frame=()=>run('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');try{await win.loadURL('http://localhost:${server.httpServer.address().port}/__assistant_details');const deadline=Date.now()+30000;while(Date.now()<deadline){if(await run('!!window.setCanvas&&!!document.querySelector(".assistant-details")'))break;await new Promise(r=>setTimeout(r,20));}assert.equal(await run('!!window.setCanvas&&!!document.querySelector(".assistant-details")'),true,'the fixture must mount before measuring');
 for(const width of [1000,600,1000]){await run('setCanvas('+width+')');await frame();await frame();const s=await run('detailsState()');console.log(JSON.stringify({width,state:s}));
 assert.equal(s.rows,2,'each deliverable is its own row');
 assert.equal(s.panelPadTop,'78px','the chat starts below the strip');
 assert.equal(Math.round(s.head.height),60,'the strip stays 60px beside the sidebar');
 assert.ok(Math.abs((s.aside.left+s.aside.right)/2-((s.workspace.left+s.workspace.right)/2))>50,'the sidebar is a column, not centred on the chat');
 assert.ok(Math.abs((s.capsule.left+s.capsule.right)/2-(s.workspace.left+s.workspace.right)/2)<=1.5,'the capsule centres on the chat, not the window '+JSON.stringify({capsule:s.capsule,workspace:s.workspace}));
 assert.ok(s.aside.right<=s.main.right+1&&s.aside.left>=s.main.left-1,'the sidebar stays inside the canvas '+JSON.stringify({aside:s.aside,main:s.main}));
 assert.equal(s.overflowsX,0,'nothing spills sideways');
 if(width===1000){assert.equal(s.position,'static','wide enough for a column, so it sits beside the chat');assert.equal(Math.round(s.aside.width),320,'the column is 320px');assert.ok(s.aside.left>=s.workspace.right-1,'the chat keeps its own width ');}
 else {assert.equal(s.position,'absolute','narrow, so it covers the chat');assert.ok(s.aside.width<=Math.round(s.main.width*0.86)+1,'it never covers the whole chat');}}
 app.exit(0);}catch(e){console.error(e.stack);app.exit(1);}});`);
 try{const result=await runElectronScenario(electron,main,temp,{attempts:1});assert.equal(result.code,0,result.output);}finally{await server.close();fs.rmSync(temp,{recursive:true,force:true});}
});
