import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import electron from 'electron';
import { createServer } from 'vite';
import { runElectronScenario } from './helpers/electron-test.mjs';

test('the session strip stays inside a docked canvas and the capsule stays centred', {timeout:120000}, async()=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'assistant-strip-'));
 const appSource=fs.readFileSync(new URL('../src/App.tsx',import.meta.url),'utf8');
 const overlayExpression=appSource.match(/const overlayDetails = ([^;]+);/)[1];
 const html=`<div id="root"></div><script type="module">
 import {detailsOverlay} from '/src/detailsLayout.ts';
 import React from 'react';import {createRoot} from 'react-dom/client';
 import '/src/styles.css';import '/src/glass-theme.css';
 import {AssistantWorkspace} from '/src/AssistantWorkspace.tsx';
 const h=React.createElement;
 const lane={name:'Approved Flow QA',hostName:'local',assistant:{id:'qa',name:'Approved Flow QA',projects:[],tasks:[]}};
 const chat=h('div',{className:'apex-agent-tabpanel'},h('p',{style:{height:2000}},'A long conversation scrolls behind the strip.'));
 createRoot(document.getElementById('root')).render(h('div',{className:'app assistant-active',style:{width:1400,height:800}},h('div',{className:'body'},h('aside',{style:{flex:'0 0 280px'}}),h('main',{className:'canvas section-threads'},h('div',{className:'workspace-canvas-content',style:{display:'none'}}),h(AssistantWorkspace,{lane,section:'chat',onNavigate(){},chat,projects:null,editor:null})),h('aside',{id:'dock',style:{flex:'0 0 320px'}}))));
 window.resizeDock=detailsWidth=>{const mainView={kind:'assistant'},availableWidth=1120,sidePanelFull=false;const overlay=${overlayExpression};const d=document.querySelector('#dock');d.style.flexBasis=detailsWidth+'px';d.style.width=detailsWidth+'px';d.style.position=overlay?'absolute':'static';d.style.right='100px';};
 window.stripState=()=>{const c=document.querySelector('.canvas').getBoundingClientRect();const dock=document.querySelector('#dock').getBoundingClientRect();const visibleRight=Math.min(c.right,dock.left);const visible=[c.left,visibleRight];const boxes={head:document.querySelector('.assistant-workspace-head'),capsule:document.querySelector('.assistant-session'),menu:document.querySelector('.assistant-workspace-menu'),tabs:document.querySelector('.assistant-workspace-tabs'),avatar:document.querySelector('.assistant-session-id .identicon'),panel:document.querySelector('.apex-agent-tabpanel')};const rect=e=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right,width:r.width,height:r.height,top:r.top};};const style=getComputedStyle(boxes.head);return {canvas:visible,tabs:!!boxes.tabs,head:rect(boxes.head),capsule:rect(boxes.capsule),menu:rect(boxes.menu),avatar:rect(boxes.avatar),panelPadTop:getComputedStyle(boxes.panel).paddingTop,headBackground:style.backgroundColor,headBorder:style.borderBottomWidth,headPointer:style.pointerEvents,capsuleCenter:rect(boxes.capsule).left+rect(boxes.capsule).width/2};};
 </script>`;
 const server=await createServer({cacheDir:path.join(temp,'vite-cache'),server:{port:0},logLevel:'error',plugins:[{name:'assistant-strip',configureServer(s){s.middlewares.use('/__assistant_strip',async(_q,res)=>{res.setHeader('Content-Type','text/html');res.end(await s.transformIndexHtml('/__assistant_strip',html));});}}]});await server.listen();
 const main=path.join(temp,'main.cjs');
 fs.writeFileSync(main,`const {app,BrowserWindow}=require('electron');const assert=require('node:assert/strict');app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,width:1500,height:900,webPreferences:{offscreen:true}});win.webContents.on('console-message',(...args)=>console.error('renderer:',...args.map(x=>typeof x==='object'?x?.message??'':x)));const run=c=>win.webContents.executeJavaScript(c);const frame=()=>run('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');try{await win.loadURL('http://localhost:${server.httpServer.address().port}/__assistant_strip');const deadline=Date.now()+30000;while(Date.now()<deadline){if(await run('!!window.resizeDock&&!!document.querySelector(".assistant-session")'))break;await new Promise(r=>setTimeout(r,20));}assert.equal(await run('!!window.resizeDock&&!!document.querySelector(".assistant-session")'),true,'React layout fixture must finish mounting before resize');for(const width of [320,640,320]){await run('resizeDock('+width+')');await frame();await frame();const s=await run('stripState()');console.log(JSON.stringify({width,state:s}));assert.equal(s.tabs,false,'the Work tab strip is gone');assert.equal(Math.round(s.head.height),60,'the strip is 60px in every state');
assert.equal(s.headBackground,'rgba(0, 0, 0, 0)','the header has no background');assert.equal(s.headBorder,'0px','the header has no bottom border');assert.equal(s.headPointer,'none','empty header space lets clicks through to the chat');
assert.equal(Math.round(s.avatar.width),36,'the capsule avatar is 36px');assert.equal(s.panelPadTop,'78px','the chat starts below the strip');for(const [name,box] of [['head',s.head],['capsule',s.capsule],['menu',s.menu]]){assert.ok(box.left>=s.canvas[0]-1&&box.right<=s.canvas[1]+1,name+' stays inside the visible canvas '+JSON.stringify(box));}const centre=box=>(box.left+box.right)/2;assert.ok(Math.abs(centre(s.capsule)-centre({left:s.canvas[0],right:s.canvas[1]}))<=1.5,'capsule centred on the chat column '+JSON.stringify({capsule:centre(s.capsule),canvas:centre({left:s.canvas[0],right:s.canvas[1]})}));}app.exit(0);}catch(e){console.error(e.stack);app.exit(1);}});`);
 try{const result=await runElectronScenario(electron,main,temp,{attempts:1});assert.equal(result.code,0,result.output);}finally{await server.close();fs.rmSync(temp,{recursive:true,force:true});}
});
