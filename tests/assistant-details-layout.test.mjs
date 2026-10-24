import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import electron from 'electron';
import { createServer } from 'vite';
import { runElectronScenario } from './helpers/electron-test.mjs';

// Details renders inside the app's one side panel, so it has about 320px to
// work with. Every row has to fit that width at its narrowest, and no fold may
// push the panel sideways.
test('the assistant Details tab fits the side panel at its narrow widths', {timeout:120000}, async()=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'assistant-details-'));
 const html=`<div id="root"></div><script type="module">
 import React from 'react';import {createRoot} from 'react-dom/client';
 import '/src/styles.css';import '/src/glass-theme.css';
 import {AssistantDetails} from '/src/AssistantDetails.tsx';
 const h=React.createElement;
 const lane={name:'Approved Flow QA',hostName:'local',assistant:{id:'qa',name:'Approved Flow QA',projects:[],tasks:[]}};
 const now=Date.now();
 const tasks=[
  {id:'t1',brief:'Rewrite the release notes for the October build',originalRequest:'Rewrite the release notes',status:'ready_for_review',result:'Drafted a shorter release note and listed the breaking changes.',createdAtMs:now-7200000,updatedAtMs:now-120000},
  {id:'t2',brief:'Check the login flow on the staging machine',originalRequest:'Check login',status:'running',result:null,createdAtMs:now-600000,updatedAtMs:now-60000}
 ];
 const outputs=[{id:'o1',name:'release-notes.md',kind:'doc',folder:'docs',at:5},{id:'o2',name:'report.json',kind:'data',folder:'out',path:'out/report.json',at:0}];
 createRoot(document.getElementById('root')).render(h('div',{className:'right-panel',style:{width:320,height:800,overflow:'auto',display:'flex',flexDirection:'column'},id:'panel'},h(AssistantDetails,{lane,tasks,outputs,onClose(){},onNavigate(){}})));
 window.setPanel=w=>{document.getElementById('panel').style.width=w+'px';};
 window.panelState=()=>{const panel=document.getElementById('panel');const box=panel.getBoundingClientRect();
  const rows=[...panel.querySelectorAll('.assistant-activity-row,.assistant-output-row')].map(e=>{const r=e.getBoundingClientRect();return {right:r.right,width:r.width,height:r.height};});
  const heads=[...panel.querySelectorAll('.assistant-details-fold-head')].map(e=>{const r=e.getBoundingClientRect();return {right:r.right,height:r.height};});
  return {box:{left:box.left,right:box.right,width:box.width},rows,heads,names:[...panel.querySelectorAll('.assistant-activity-name,.assistant-output-name')].map(e=>e.textContent),overflowsX:panel.scrollWidth-panel.clientWidth,rootHeight:document.querySelector('.assistant-details').getBoundingClientRect().height};};
 </script>`;
 const server=await createServer({cacheDir:path.join(temp,'vite-cache'),server:{port:0},logLevel:'error',plugins:[{name:'assistant-details',configureServer(s){s.middlewares.use('/__assistant_details',async(_q,res)=>{res.setHeader('Content-Type','text/html');res.end(await s.transformIndexHtml('/__assistant_details',html));});}}]});await server.listen();
 const main=path.join(temp,'main.cjs');
 fs.writeFileSync(main,`const {app,BrowserWindow}=require('electron');const assert=require('node:assert/strict');app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,width:1500,height:900,webPreferences:{offscreen:true}});win.webContents.on('console-message',(...args)=>console.error('renderer:',...args.map(x=>typeof x==='object'?x?.message??'':x)));const run=c=>win.webContents.executeJavaScript(c);const frame=()=>run('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');try{await win.loadURL('http://localhost:${server.httpServer.address().port}/__assistant_details');const deadline=Date.now()+30000;while(Date.now()<deadline){if(await run('!!window.setPanel&&!!document.querySelector(".assistant-details")'))break;await new Promise(r=>setTimeout(r,20));}assert.equal(await run('!!window.setPanel&&!!document.querySelector(".assistant-details")'),true,'the fixture must mount before measuring');
 for(const width of [320,260,320]){await run('setPanel('+width+')');await frame();await frame();const s=await run('panelState()');console.log(JSON.stringify({width,state:s}));
 assert.equal(s.overflowsX,0,'the panel never scrolls sideways at '+width+'px');
 assert.deepEqual(s.names,['Rewrite the release notes for the October build','Check the login flow on the staging machine','Rewrite the release notes for the October build','release-notes.md','report.json'],'needs you, then activity newest first, then outputs');
 for(const row of s.rows){assert.ok(row.right<=s.box.right+1,'a row spills past the panel at '+width+'px');assert.ok(row.height>=24,'a row is too short to press');}
 for(const head of s.heads){assert.ok(head.right<=s.box.right+1,'a fold head spills past the panel');assert.ok(head.height>=28,'a fold head is too short to press');}
 assert.ok(s.rootHeight>=700,'the tab fills the panel height');}
 app.exit(0);}catch(e){console.error(e.stack);app.exit(1);}});`);
 try{const result=await runElectronScenario(electron,main,temp,{attempts:1});assert.equal(result.code,0,result.output);}finally{await server.close();fs.rmSync(temp,{recursive:true,force:true});}
});
