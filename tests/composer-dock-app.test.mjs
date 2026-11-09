import test from 'node:test';
import { withAppearanceApp } from './helpers/appearance-app.mjs';

// Only the file-drop bridge is replaced. The target, panes, dock and editor are App's.
const hooks = { name:'dock-drop-probe', enforce:'pre', transform(code,id) {
 if (!id.endsWith('/src/backend.ts')) return;
 return code.replace('onFileDrop: async () => () => {},','onFileDrop: async cb => { (window.drops ??= new Set()).add(cb); return () => window.drops.delete(cb); },')
  .replace('copyAttachment: async (_room, path) => path,','copyAttachment: async (room,path) => { (window.copies ??= []).push([room,path]); return path; },');
}};
for (const [width,height] of [[1512,945],[1100,650]]) test(`App dock: drops, steady layouts, floating dialog, reveal and tab chips at ${width}`,{timeout:120000},async()=>{
 await withAppearanceApp('dock-app',String.raw`
 const ids=Array.from({length:14},(_,i)=>'dock-'+i);
 const panes=ids.map((id,i)=>({id,workspaceId:'dock-w',kind:'chat',title:'Thread '+i,sample:true}));
 const session={version:1,workspaces:[{id:'dock-w',name:'Sample',path:''}],panes,profiles:[],profileRevision:0,activeWorkspace:'dock-w',focusedPane:ids[0],section:'threads',arrangements:{':threads':{mode:'grid',order:ids,zoom:1,focusShare:.58}},rightPanel:{open:false,tabs:[],active:'dashboard'},canvasVersion:1};
 // Stop the running App before seeding, so its save effect cannot replace the fixture.
 await win.loadURL(new URL('/branding/mark.svg',win.webContents.getURL()).href);
 await run('localStorage.clear();localStorage.setItem("apex-deck.demo.session.v1",'+JSON.stringify(JSON.stringify(session))+');localStorage.setItem("apex-deck.demo.settings.v1",JSON.stringify({version:1,botChips:{style:"tab",tool:true,effort:true,usage:true}}))');
 await load();
 await until('document.querySelectorAll(".pane-map-slot").length===14 && !!document.querySelector(".composer textarea")'); await sleep(400);
 const shape=()=>run('(()=>{const m=document.querySelector(".pane-map"),r=m.getBoundingClientRect();return {level:m.dataset.level,h:r.height,lefts:[...m.querySelectorAll(".pane-map-slot")].map(s=>s.style.left)}})()');
 const type=async text=>{await until('!!document.querySelector(".composer textarea")');await run('document.querySelector(".composer textarea").focus()');await win.webContents.insertText(text);await sleep(70);};
 const clear=async()=>{await run('(()=>{const t=document.querySelector(".composer textarea");Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set.call(t,"");t.dispatchEvent(new Event("input",{bubbles:true}))})()');await sleep(100);};
 const drop=async selector=>{await run('(()=>{window.copies=[];const r=document.querySelector('+JSON.stringify(selector)+').getBoundingClientRect();for(const cb of window.drops)cb(["/tmp/dock.png"],r.x+r.width/2,r.y+Math.min(35,r.height/2))})()');await until('window.copies?.length===1 && !!document.querySelector(".composer textarea")');await frame();return run('window.copies.map(c=>c[0])');};
 assert.deepEqual(await drop('[data-pane-id="dock-1"] .transcript'),['dock-1']);
 assert.equal(await run('document.querySelector(".composer-dock-target strong").textContent'),'Thread 1');
 assert.deepEqual(await drop('[data-pane-id="dock-0"] .transcript'),['dock-0']);
 assert.deepEqual(await drop('.composer-dock textarea'),['dock-0']);
 // Off-screen slots extend underneath the dock. They must never claim its drops.
 assert.deepEqual(await drop('.composer-dock textarea'),['dock-0']);
 for (const mode of ['Even grid','Horizontal','Focus left']) {
  await clear();
  await run('document.querySelector(".layout-picker-trigger").click()');
  await run('[...document.querySelectorAll("[role=menuitemradio]")].find(b=>b.querySelector("strong")?.textContent==='+JSON.stringify(mode)+').click()');await sleep(350);
  const base=await shape();
  for(let n=1;n<=9;n++){await type(n===1?'line':'\nline');const s=await shape();assert.equal(s.level,base.level,mode+' line '+n);assert.deepEqual(s.lefts,base.lefts,mode+' horizontal positions');}
  await clear();assert.ok(Math.abs((await shape()).h-base.h)<=1);
 }
 const before=await shape();
 await run('document.querySelector(".composer-dock .chip-add").click()');await sleep(150);
 assert.ok(Math.abs((await shape()).h-before.h)<=1,'Add bot does not take map height');
 const dialog=await run('(()=>{const f=document.querySelector(".composer-dock .quick-add").getBoundingClientRect(),d=document.querySelector(".composer-dock").getBoundingClientRect();return {top:f.top,bottom:f.bottom,dock:d.top,height:innerHeight}})()');
 assert.ok(dialog.top>=0 && dialog.top<dialog.dock && dialog.bottom<=dialog.height);
 await shot('dock-add-${width}');
 await run('document.querySelector(".composer-dock .quick-add-close").click()');
 assert.deepEqual(await run('(()=>{const s=getComputedStyle(document.querySelector(".composer-dock .composer-box"));return [s.borderBottomLeftRadius,s.borderBottomRightRadius]})()'),['0px','0px']);
 await run('document.querySelector(".layout-picker-trigger").click()');await run('[...document.querySelectorAll("[role=menuitemradio]")].find(b=>b.querySelector("strong")?.textContent==="Even grid").click()');await sleep(350);
 await run('document.querySelector(".pane-map").scrollTop=10000');await sleep(200);
 await run('document.querySelector(".composer-dock-target").click()');await sleep(200);
 assert.equal(await run('document.querySelector(".pane-map").scrollTop'),0,'To reveals target');
 const target=await run('document.querySelector(".composer-dock-target strong").textContent');
 await run('document.querySelector(".pane-map").dispatchEvent(new WheelEvent("wheel",{ctrlKey:true,deltaY:-100,bubbles:true,cancelable:true}))');await sleep(300);
 assert.equal(await run('document.querySelector(".composer-dock-target strong").textContent'),target);
 await size(${width-200},${height});
 assert.equal(await run('[...document.querySelectorAll(".composer-bots .chip")].some(c=>c.getBoundingClientRect().right>c.closest(".composer-bots").getBoundingClientRect().right+1)'),false,'chips refit');
 await shot('dock-typed-${width}');
 `,{width,height,plugins:[hooks]});
});
