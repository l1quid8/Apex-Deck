import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import electron from 'electron';
import { createServer } from 'vite';
import { runElectronScenario } from './helpers/electron-test.mjs';

// Two separate promises have to hold at once, and a padding value alone cannot
// prove either of them:
//   1. at rest nothing is hidden underneath the 60px strip (handoff 6.1), and
//   2. once you scroll, a message really is painted in the strip's band — not
//      clipped at a line below it by a band of its own.
// So this measures geometry and reads back captured pixels. The strip must look
// like the chat around it: same colour to the left, where the capsule is not.
test('messages scroll behind the session strip and nothing starts hidden', {timeout:120000}, async()=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'assistant-strip-paint-'));
 const html=`<div id="root"></div><script type="module">
 import React from 'react';import {createRoot} from 'react-dom/client';
 import '/src/styles.css';import '/src/glass-theme.css';import '/src/apex-agent-panel.css';
 import '/src/apex-agent-dock.css';import '/src/apex-agent-message-actions.css';
 import {AssistantWorkspace} from '/src/AssistantWorkspace.tsx';
 const h=React.createElement;
 const lane={name:'Approved Flow QA',hostName:'local',assistant:{id:'qa',name:'Approved Flow QA',projects:[],tasks:[]}};
 // Row 9 is deliberately one very wide, non-wrapping line: it must paint on both
 // sides of the centred capsule, so a probe either side proves the strip is not
 // covering half the column.
 const wide='Row 9. '+Array(6).fill('wide transcript text that keeps painting past the capsule on the right').join(' ');
 const rows=Array.from({length:26},(_,i)=>h('div',{className:'apex-agent-message-row assistant'},
   h('div',{className:'apex-agent-message-meta'},h('span',null,'Approved Flow QA')),
   h('div',{className:'assistant-chat-message assistant'},h('p',i===9?{style:{whiteSpace:'nowrap',maxWidth:'none',width:'max-content'}}:null,
     i===9?wide:'Row '+i+'. A line of transcript long enough that we can tell whether it is painted underneath the session strip or clipped by it.'))));
 const chat=h('section',{className:'apex-agent assistant-conversation thread-chat apex-agent-all'},
   h('div',{className:'apex-agent-tabpanel'},h('div',{className:'assistant-chat-transcript'},rows)),
   h('div',{className:'assistant-thread-composer'},h('div',{className:'composer-box'},h('textarea',{defaultValue:'Ask anything'}))));
 // Real replies are capped at a readable measure, which would leave the right of
 // the capsule empty and make the two-sided check meaningless. This fixture asks
 // for full-width text so both sides genuinely carry transcript.
 const widen=document.createElement('style');
 widen.textContent='.assistant-chat-transcript .assistant-chat-message{max-width:none!important}';
 document.head.append(widen);
 createRoot(document.getElementById('root')).render(h('div',{className:'app assistant-active',style:{width:1200,height:820}},
   h('div',{className:'body'},h('aside',{style:{flex:'0 0 260px'}}),
   h('main',{className:'canvas section-threads'},h(AssistantWorkspace,{lane,section:'chat',onNavigate(){},chat,projects:null,editor:null})))));
 const geom=()=>{const ws=document.querySelector('.assistant-workspace');const panel=document.querySelector('.apex-agent-tabpanel');const strip=document.querySelector('.assistant-workspace-head');const capsule=document.querySelector('.assistant-session');const a=ws.getBoundingClientRect();const b=panel.getBoundingClientRect();const c=strip.getBoundingClientRect();const d=capsule.getBoundingClientRect();return {ws:{left:a.left,top:a.top,right:a.right,bottom:a.bottom},panel:{top:b.top,left:b.left},strip:{top:c.top,bottom:c.bottom},capsule:{left:d.left,right:d.right,top:d.top,bottom:d.bottom},controlLeft:c.left};};
 // Scrolling by row rather than by a fixed number keeps the fixture independent
 // of how tall a message happens to render.
 window.scrollRowUnder=index=>{const ws=document.querySelector('.assistant-workspace').getBoundingClientRect();const panel=document.querySelector('.apex-agent-tabpanel');const row=document.querySelectorAll('.apex-agent-message-row')[index];if(!row)return -1;const r=row.getBoundingClientRect();panel.scrollTop+=(r.top-(ws.top+30));return panel.scrollTop;};
 window.stripPaint=()=>{const g=geom();const panel=document.querySelector('.apex-agent-tabpanel');
  const probeY=g.ws.top+30;const cx=(g.capsule.left+g.capsule.right)/2;
  // Left of the capsule but inside the message column, so "away from the capsule"
  // still means "over the transcript".
  const transcript=document.querySelector('.assistant-chat-transcript').getBoundingClientRect();
  const sideX=transcript.left+40;
  // Keep the probe region clear of the capsule itself, which is drawn on purpose.
  const probeW=Math.max(60,Math.min(240,g.capsule.left-24-sideX));
  // The same check on the right of the capsule: text must reach past it on both
  // sides, not only on the side that happens to be longer.
  const rightX=g.capsule.right+24;
  const rightW=Math.max(0,Math.min(240,transcript.right-24-rightX));
  const stack=document.elementsFromPoint(cx,probeY).map(e=>typeof e.className==='string'&&e.className?e.className:e.tagName);
  const sideStack=document.elementsFromPoint(sideX,probeY).map(e=>typeof e.className==='string'&&e.className?e.className:e.tagName);
  const rowAt=stack.some(name=>name.includes('apex-agent-message-row'))||stack.some(name=>name.includes('assistant-chat-message'));
  const sideRowAt=sideStack.some(name=>name.includes('apex-agent-message-row'))||sideStack.some(name=>name.includes('assistant-chat-message'));
  const first=document.querySelector('.apex-agent-message-row');
  const firstTop=first?first.getBoundingClientRect().top:null;
  const rightStack=rightW>20?document.elementsFromPoint(rightX+20,probeY).map(e=>typeof e.className==='string'&&e.className?e.className:e.tagName):[];
  const rightRowAt=rightStack.some(name=>name.includes('apex-agent-message-row'))||rightStack.some(name=>name.includes('assistant-chat-message'));
  return {...g,panelTop:g.panel.top,padTop:getComputedStyle(panel).paddingTop,scrollTop:panel.scrollTop,probeY,sideX,probeW,rightX,rightW,stack,sideStack,rightStack,rowAt,sideRowAt,rightRowAt,firstTop,
   scrollHeight:panel.scrollHeight,clientHeight:panel.clientHeight,
   chatBackground:getComputedStyle(document.querySelector('.apex-agent-tabpanel')).backgroundColor,
   stripBackground:getComputedStyle(document.querySelector('.assistant-workspace-head')).backgroundColor};};
 </script>`;
 const server=await createServer({cacheDir:path.join(temp,'vite-cache'),server:{port:0},logLevel:'error',plugins:[{name:'strip-paint',configureServer(s){s.middlewares.use('/__strip_paint',async(_q,res)=>{res.setHeader('Content-Type','text/html');res.end(await s.transformIndexHtml('/__strip_paint',html));});}}]});await server.listen();
 const main=path.join(temp,'main.cjs');
 fs.writeFileSync(main,`const {app,BrowserWindow}=require('electron');const assert=require('node:assert/strict');app.whenReady().then(async()=>{
  const win=new BrowserWindow({show:false,width:1300,height:900,webPreferences:{offscreen:true,backgroundThrottling:false}});
  win.webContents.on('console-message',(...args)=>console.error('renderer:',...args.map(x=>typeof x==='object'?x?.message??'':x)));
  const run=c=>win.webContents.executeJavaScript(c);const frame=()=>run('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
  const near=(a,b,t)=>Math.abs(a-b)<=t;
  // Read back the rendered pixels. A single sample can land in the whitespace
  // between glyph lines, so the scroll check counts drawn pixels in a band.
  const shot=async()=>{const img=await win.webContents.capturePage();const size=img.getSize();const bmp=img.getBitmap();
   const vw=await run('window.innerWidth');const vh=await run('window.innerHeight');const sx=size.width/vw,sy=size.height/vh;
   const at=(x,y)=>{const px=Math.round(x*sx),py=Math.round(y*sy);const i=(py*size.width+px)*4;return [bmp[i+2],bmp[i+1],bmp[i]];};
   const countDrawn=(x0,y0,w,h,ref,tol)=>{let n=0;for(let y=y0;y<y0+h;y+=1)for(let x=x0;x<x0+w;x+=1){const p=at(x,y);if(Math.abs(p[0]-ref[0])>tol||Math.abs(p[1]-ref[1])>tol||Math.abs(p[2]-ref[2])>tol)n+=1;}return n;};
   return {at,countDrawn};};
  try{await win.loadURL('http://localhost:${server.httpServer.address().port}/__strip_paint');
   const deadline=Date.now()+30000;while(Date.now()<deadline){if(await run('!!window.stripPaint&&!!document.querySelector(".assistant-session")'))break;await new Promise(r=>setTimeout(r,20));}
   assert.equal(await run('!!window.stripPaint&&!!document.querySelector(".assistant-session")'),true,'the fixture mounts before measuring');
   await frame();await frame();
   const rest=await run('stripPaint()');console.log(JSON.stringify({rest}));
   assert.equal(Math.round(rest.strip.bottom-rest.strip.top),60,'the strip is 60px');
   assert.equal(rest.stripBackground,'rgba(0, 0, 0, 0)','the strip paints no background of its own');
   assert.ok(near(rest.panelTop,rest.ws.top,0.5),'the chat scroller is full-bleed to the top of the workspace, not pushed below the strip: panel '+rest.panelTop+' vs workspace '+rest.ws.top);
   assert.ok(rest.firstTop>=rest.strip.bottom-1,'the first message starts below the strip at rest (nothing hidden underneath): first '+rest.firstTop+' vs strip bottom '+rest.strip.bottom);
   assert.ok(parseFloat(rest.padTop)>=60,'the chat reserves room for the strip: padding-top '+rest.padTop);
   // The area left of the capsule is empty chat, inside the strip band. If a band
   // were painted there it would differ from the chat just below it.
   const shotRest=await shot();
   const restPixels=[shotRest.at(rest.sideX,rest.ws.top+30),shotRest.at(rest.sideX,rest.strip.bottom+8)];
   console.log(JSON.stringify({restPixels}));
   for(const channel of [0,1,2])assert.ok(near(restPixels[0][channel],restPixels[1][channel],6),'no band across the strip at rest: '+JSON.stringify(restPixels[0])+' vs chat '+JSON.stringify(restPixels[1]));
   const drawnAtRest=shotRest.countDrawn(rest.sideX,rest.ws.top+16,rest.probeW,60,restPixels[1],10);
   console.log(JSON.stringify({drawnAtRest}));
   assert.ok(drawnAtRest<=4,'nothing is drawn in the empty strip band at rest: '+drawnAtRest+' pixels');
   const scrolledTo=await run('scrollRowUnder(9)');assert.ok(scrolledTo>0,'the fixture actually scrolled: '+scrolledTo);
   await frame();await frame();
   const scrolled=await run('stripPaint()');console.log(JSON.stringify({scrolled}));
   assert.ok(scrolled.rowAt,'a message is painted in the strip band once scrolled (elementsFromPoint at y=+30 finds a message row). Stack: '+JSON.stringify(scrolled.stack));
   assert.ok(scrolled.sideRowAt,'the same message reaches the strip band even away from the capsule. Stack: '+JSON.stringify(scrolled.sideStack));
   const shotScrolled=await shot();
   const drawnWhenScrolled=shotScrolled.countDrawn(scrolled.sideX,scrolled.ws.top+16,scrolled.probeW,60,restPixels[1],10);
   console.log(JSON.stringify({drawnWhenScrolled}));
   assert.ok(drawnWhenScrolled>20,'text really is painted inside the strip band once a message is scrolled under it: '+drawnWhenScrolled+' pixels (was '+drawnAtRest+' at rest)');
  // Both sides of the frosted capsule, or the strip is only half transparent.
  assert.ok(scrolled.rightW>20,'the column is wide enough to check the right of the capsule: '+scrolled.rightW);
  assert.ok(scrolled.rightRowAt,'a message row is the topmost thing to the right of the capsule');
  const drawnRight=shotScrolled.countDrawn(scrolled.rightX,scrolled.ws.top+16,scrolled.rightW,60,restPixels[1],10);
  console.log(JSON.stringify({drawnWhenScrolled,drawnRight,rightW:scrolled.rightW}));
  assert.ok(drawnRight>20,'text is painted in the strip band to the right of the capsule too: '+drawnRight+' pixels');
   app.exit(0);}catch(e){console.error(e.stack);app.exit(1);}});`);
 try{const result=await runElectronScenario(electron,main,temp,{attempts:1});assert.equal(result.code,0,result.output);}finally{await server.close();fs.rmSync(temp,{recursive:true,force:true});}
});

// Dev always has a problem banner up, because the debug UI cannot write to the
// protected store. That banner used to take the strip out of its overlay
// (`.assistant-workspace-problem~.assistant-workspace-head{position:relative}`),
// so the strip joined the flow, the scroller started about a hundred pixels down
// and messages were clipped at that line: the solid band the Human kept seeing.
// A banner is an alert, not a layout change. It must not move the strip, and the
// chat must still scroll behind both of them.
test('a problem banner does not turn the floating strip into a solid band', {timeout:120000}, async()=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'assistant-strip-banner-'));
 const html=`<div id="root"></div><script type="module">
 import React from 'react';import {createRoot} from 'react-dom/client';
 import '/src/styles.css';import '/src/glass-theme.css';import '/src/apex-agent-panel.css';
 import '/src/apex-agent-dock.css';import '/src/apex-agent-message-actions.css';
 import {AssistantWorkspace} from '/src/AssistantWorkspace.tsx';
 const h=React.createElement;
 // The wording dev shows when a write is refused.
 const lane={name:'Approved Flow QA',hostName:'local',problem:'Only the pinned installed UI may record a submission or decision; local socket and CLI access do not establish human origin.',assistant:{id:'qa',name:'Approved Flow QA',projects:[],tasks:[]}};
 const wide='Row 9. '+Array(6).fill('wide transcript text that keeps painting past the capsule on the right').join(' ');
 const rows=Array.from({length:26},(_,i)=>h('div',{className:'apex-agent-message-row assistant'},
   h('div',{className:'apex-agent-message-meta'},h('span',null,'Approved Flow QA')),
   h('div',{className:'assistant-chat-message assistant'},h('p',i===9?{style:{whiteSpace:'nowrap',maxWidth:'none',width:'max-content'}}:null,
     i===9?wide:'Row '+i+'. A line of transcript long enough that we can tell whether it is painted underneath the session strip or clipped by it.'))));
 const chat=h('section',{className:'apex-agent assistant-conversation thread-chat apex-agent-all'},
   h('div',{className:'apex-agent-error',role:'alert'},'Host does not own this protected provenance scope.'),
   h('div',{className:'apex-agent-tabpanel'},h('div',{className:'assistant-chat-transcript'},rows)),
   h('div',{className:'assistant-thread-composer'},h('div',{className:'composer-box'},h('textarea',{defaultValue:'Ask anything'}))));
 const widen=document.createElement('style');
 widen.textContent='.assistant-chat-transcript .assistant-chat-message{max-width:none!important}';
 document.head.append(widen);
 createRoot(document.getElementById('root')).render(h('div',{className:'app assistant-active',style:{width:1200,height:820}},
   h('div',{className:'body'},h('aside',{style:{flex:'0 0 260px'}}),
   h('main',{className:'canvas section-threads'},h(AssistantWorkspace,{lane,section:'chat',onNavigate(){},chat,projects:null,editor:null})))));
 window.scrollRowUnder=index=>{const ws=document.querySelector('.assistant-workspace').getBoundingClientRect();const panel=document.querySelector('.apex-agent-tabpanel');const row=document.querySelectorAll('.apex-agent-message-row')[index];if(!row)return -1;const r=row.getBoundingClientRect();panel.scrollTop+=(r.top-(ws.top+30));return panel.scrollTop;};
 window.bannerGeom=()=>{const ws=document.querySelector('.assistant-workspace');const panel=document.querySelector('.apex-agent-tabpanel');const strip=document.querySelector('.assistant-workspace-head');const capsule=document.querySelector('.assistant-session');const banner=document.querySelector('.assistant-workspace-problem');const err=document.querySelector('.apex-agent-error');const composer=document.querySelector('.assistant-thread-composer');const first=document.querySelector('.apex-agent-message-row');
  if(!banner||!strip||!capsule||!panel||!first||!err||!composer)return null;
  const a=ws.getBoundingClientRect(),p=panel.getBoundingClientRect(),s=strip.getBoundingClientRect(),c=capsule.getBoundingClientRect(),b=banner.getBoundingClientRect(),f=first.getBoundingClientRect();
  const transcript=document.querySelector('.assistant-chat-transcript').getBoundingClientRect();
  return {ws:{top:a.top,left:a.left},panelTop:p.top,padTop:getComputedStyle(panel).paddingTop,
   strip:{top:s.top,bottom:s.bottom,position:getComputedStyle(strip).position,background:getComputedStyle(strip).backgroundColor},
   capsule:{left:c.left,right:c.right},
   banner:{top:b.top,bottom:b.bottom,position:getComputedStyle(banner).position},
   error:{top:err.getBoundingClientRect().top,bottom:err.getBoundingClientRect().bottom,position:getComputedStyle(err).position},
   panelBottom:p.bottom,
   composer:{top:composer.getBoundingClientRect().top,position:getComputedStyle(composer).position,borderTop:getComputedStyle(composer).borderTopWidth},
   firstTop:f.top,transcript:{left:transcript.left,right:transcript.right},
   leftX:transcript.left+40,rightX:c.right+24,
   leftW:Math.max(60,Math.min(240,c.left-24-(transcript.left+40))),
   rightW:Math.max(0,Math.min(240,transcript.right-24-(c.right+24)))};};
 </script>`;
 const server=await createServer({cacheDir:path.join(temp,'vite-cache'),server:{port:0},logLevel:'error',plugins:[{name:'strip-banner',configureServer(s){s.middlewares.use('/__strip_banner',async(_q,res)=>{res.setHeader('Content-Type','text/html');res.end(await s.transformIndexHtml('/__strip_banner',html));});}}]});await server.listen();
 const main=path.join(temp,'main.cjs');
 fs.writeFileSync(main,`const {app,BrowserWindow}=require('electron');const assert=require('node:assert/strict');app.whenReady().then(async()=>{
  const win=new BrowserWindow({show:false,width:1300,height:900,webPreferences:{offscreen:true,backgroundThrottling:false}});
  win.webContents.on('console-message',(...args)=>console.error('renderer:',...args.map(x=>typeof x==='object'?x?.message??'':x)));
  const run=c=>win.webContents.executeJavaScript(c);const frame=()=>run('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
  const shot=async()=>{const img=await win.webContents.capturePage();const size=img.getSize();const bmp=img.getBitmap();
   const vw=await run('window.innerWidth');const vh=await run('window.innerHeight');const sx=size.width/vw,sy=size.height/vh;
   const at=(x,y)=>{const px=Math.round(x*sx),py=Math.round(y*sy);const i=(py*size.width+px)*4;return [bmp[i+2],bmp[i+1],bmp[i]];};
   const countDrawn=(x0,y0,w,h,ref,tol)=>{let n=0;for(let y=y0;y<y0+h;y+=1)for(let x=x0;x<x0+w;x+=1){const p=at(x,y);if(Math.abs(p[0]-ref[0])>tol||Math.abs(p[1]-ref[1])>tol||Math.abs(p[2]-ref[2])>tol)n+=1;}return n;};
   return {at,countDrawn};};
  try{await win.loadURL('http://localhost:${server.httpServer.address().port}/__strip_banner');
   const deadline=Date.now()+30000;while(Date.now()<deadline){if(await run('!!window.bannerGeom&&!!document.querySelector(".assistant-workspace-problem")'))break;await new Promise(r=>setTimeout(r,20));}
   assert.equal(await run('!!window.bannerGeom&&!!document.querySelector(".assistant-workspace-problem")'),true,'the banner fixture mounts');
   await frame();await frame();
   const rest=await run('bannerGeom()');console.log(JSON.stringify({rest}));
   assert.equal(rest.strip.position,'absolute','a banner must not take the strip out of its overlay: position '+rest.strip.position);
   assert.ok(Math.abs(rest.panelTop-rest.ws.top)<=0.5,'the chat scroller stays full-bleed with a banner up, so nothing is clipped at a line below the strip: panel '+rest.panelTop+' vs workspace '+rest.ws.top);
   assert.equal(rest.banner.position,'absolute','the banner floats instead of joining the flow: position '+rest.banner.position);
   assert.ok(rest.firstTop>=rest.banner.bottom-1,'the first message clears the banner at rest: first '+rest.firstTop+' vs banner bottom '+rest.banner.bottom);
   assert.ok(rest.firstTop>=rest.strip.bottom-1,'the first message still clears the strip: first '+rest.firstTop+' vs strip bottom '+rest.strip.bottom);
   assert.equal(rest.error.position,'absolute','the chat error bar floats instead of pushing the transcript down: position '+rest.error.position);
   assert.ok(rest.firstTop>=rest.error.bottom-1,'the first message clears the chat error bar too: first '+rest.firstTop+' vs error bottom '+rest.error.bottom);
   assert.ok(rest.banner.bottom<=rest.error.top+1,'the two alerts stack instead of overlapping: banner bottom '+rest.banner.bottom+' vs error top '+rest.error.top);
   assert.equal(rest.composer.position,'absolute','the composer floats over the chat: position '+rest.composer.position);
   assert.equal(rest.composer.borderTop,'0px','the composer has no ruled line above it: border '+rest.composer.borderTop);
   assert.ok(rest.panelBottom>=rest.composer.top+1,'the transcript runs behind the composer instead of stopping above it: panel bottom '+rest.panelBottom+' vs composer top '+rest.composer.top);
   const scrolledTo=await run('scrollRowUnder(9)');assert.ok(scrolledTo>0,'the fixture scrolls: '+scrolledTo);
   await frame();await frame();
   const after=await run('bannerGeom()');
   const shotScrolled=await shot();
   const chatBg=shotScrolled.at(after.leftX,after.ws.top+300);
   const drawnLeft=shotScrolled.countDrawn(after.leftX,after.ws.top+16,after.leftW,60,chatBg,10);
   const drawnRight=shotScrolled.countDrawn(after.rightX,after.ws.top+16,after.rightW,60,chatBg,10);
   console.log(JSON.stringify({drawnLeft,drawnRight,leftW:after.leftW,rightW:after.rightW}));
   assert.ok(after.rightW>20,'there is room to check the right of the capsule: '+after.rightW);
   assert.ok(drawnLeft>20,'text is painted in the strip band left of the capsule with a banner up: '+drawnLeft+' pixels');
   assert.ok(drawnRight>20,'text is painted in the strip band right of the capsule with a banner up: '+drawnRight+' pixels');
   app.exit(0);}catch(e){console.error(e.stack);app.exit(1);}});`);
 try{const result=await runElectronScenario(electron,main,temp,{attempts:1});assert.equal(result.code,0,result.output);}finally{await server.close();fs.rmSync(temp,{recursive:true,force:true});}
});
