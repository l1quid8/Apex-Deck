import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import electron from 'electron';
import { createServer } from 'vite';
import { runElectronScenario } from './helpers/electron-test.mjs';

test('assistant controls and Work rows fit after a docked sidebar narrows the canvas', {timeout:120000}, async()=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'assistant-resize-'));
 const appSource=fs.readFileSync(new URL('../src/App.tsx',import.meta.url),'utf8');
 const overlayExpression=appSource.match(/const overlayDetails = ([^;]+);/)[1];
 const html=`<div id="root"></div><script type="module">
 import {detailsOverlay} from '/src/detailsLayout.ts';
 import React from 'react';import {createRoot} from 'react-dom/client';
 import '/src/styles.css';import '/src/glass-theme.css';
 import {AssistantWorkspace} from '/src/AssistantWorkspace.tsx';import {AssistantWork} from '/src/AssistantWork.tsx';
 const h=React.createElement;
 const lane={name:'Approved Flow QA',hostName:'local',assistant:{id:'qa',name:'Approved Flow QA',projects:[],tasks:[]}};
 const work=h('div',{className:'assistant-work-region'},h(AssistantWork,{items:{needsYou:[{key:'qa',title:'QA Work v8 review navigation',status:'proposed',projectName:'approved-flow',worker:'deepgeek'}],working:[],finished:[],cancelled:[],deleted:[]},projects:null,onOpenTask(){},onNewTask(){}}));
 createRoot(document.getElementById('root')).render(h('div',{className:'app assistant-active',style:{width:1400,height:800}},h('div',{className:'body'},h('aside',{style:{flex:'0 0 280px'}}),h('main',{className:'canvas section-threads'},h('div',{className:'workspace-canvas-content',style:{display:'none'}}),h(AssistantWorkspace,{lane,section:'work',onNavigate(){},chat:null,work,editor:null})),h('aside',{id:'dock',style:{flex:'0 0 320px'}}))));
 window.resizeDock=detailsWidth=>{const mainView={kind:'assistant'},availableWidth=1120,sidePanelFull=false;const overlay=${overlayExpression};const d=document.querySelector('#dock');d.style.flexBasis=detailsWidth+'px';d.style.width=detailsWidth+'px';d.style.position=overlay?'absolute':'static';d.style.right='100px';};
 </script>`;
 const server=await createServer({server:{port:0},logLevel:'error',plugins:[{name:'assistant-resize',configureServer(s){s.middlewares.use('/__assistant_resize',async(_q,res)=>{res.setHeader('Content-Type','text/html');res.end(await s.transformIndexHtml('/__assistant_resize',html));});}}]});await server.listen();
 const main=path.join(temp,'main.cjs');
 fs.writeFileSync(main,`const {app,BrowserWindow}=require('electron');const assert=require('node:assert/strict');app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,width:1500,height:900,webPreferences:{offscreen:true}});const run=c=>win.webContents.executeJavaScript(c);const frame=()=>run('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');try{await win.loadURL('http://localhost:${server.httpServer.address().port}/__assistant_resize');for(let i=0;i<200;i++){if(await run('!!document.querySelector(".assistant-work")'))break;await new Promise(r=>setTimeout(r,20));}for(const width of [320,640,320]){await run('resizeDock('+width+')');await frame();await frame();const state=await run(\`(()=>{const c=document.querySelector('.canvas').getBoundingClientRect();const visibleRight=Math.min(c.right,document.querySelector('#dock').getBoundingClientRect().left);const sels=['.assistant-workspace','.assistant-workspace-tabs','.assistant-work-heading>.primary','.assistant-work-next','.assistant-work-drawer-trigger'];return sels.map(s=>{const e=document.querySelector(s),r=e.getBoundingClientRect();return {s,left:r.left,right:r.right,canvas:[c.left,visibleRight],width:r.width,scroll:e.scrollWidth,client:e.clientWidth}})})()\`);console.log(JSON.stringify({width,state}));for(const r of state)assert.ok(r.left>=r.canvas[0]&&r.right<=r.canvas[1]+1,'visible controls inside canvas '+JSON.stringify(r));}app.exit(0);}catch(e){console.error(e.stack);app.exit(1);}});`);
 try{const result=await runElectronScenario(electron,main,temp,{attempts:1});assert.equal(result.code,0,result.output);}finally{await server.close();fs.rmSync(temp,{recursive:true,force:true});}
});
