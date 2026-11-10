import test from 'node:test';
import { withAppearanceApp } from './helpers/appearance-app.mjs';

const probe = {name:'focus-target-probe',enforce:'pre',transform(code,id){
  if(!id.endsWith('/src/App.tsx'))return;
  return code.replace('const multiDraft = useMultiDraft();','const multiDraft = useMultiDraft(); (window as any).multiDraft = multiDraft;');
}};
for(const [width,height] of [[1512,945],[1100,650]]) test(`focused pane keeps multi selection, routing and draft at ${width}`,{timeout:120000},async()=>{
 await withAppearanceApp('focused-target',String.raw`
 const ids=['focus-0','focus-1','focus-2'];
 const session={version:1,workspaces:[{id:'focus-w',name:'Sample',path:''}],panes:ids.map((id,i)=>({id,workspaceId:'focus-w',kind:'chat',title:'Thread '+i,sample:true})),profiles:[],profileRevision:0,activeWorkspace:'focus-w',focusedPane:ids[0],section:'threads',arrangements:{':threads':{mode:'grid',order:ids,zoom:1,focusShare:.58}},rightPanel:{open:false,tabs:[],active:'dashboard'},canvasVersion:1};
 await win.loadURL(new URL('/branding/mark.svg',win.webContents.getURL()).href);
 await run('localStorage.clear();localStorage.setItem("apex-deck.demo.session.v1",'+JSON.stringify(JSON.stringify(session))+')');await load();
 await until('!!document.querySelector(".composer textarea")');await sleep(200);
 const click=async(i,modified=false)=>{await run('document.querySelector("[data-pane-id=focus-'+i+'] .pane-head").dispatchEvent(new MouseEvent("mousedown",{bubbles:true,button:0,metaKey:'+modified+',ctrlKey:'+modified+'}))');await frame();};
 await click(0);await click(1,true);
 await until('!!document.querySelector(".multi-composer")');
 await run('window.multiDraft.setDoc([[{kind:"thread",paneId:"focus-0",hostId:"local"},{kind:"thread",paneId:"focus-1",hostId:"local"},{kind:"text",text:" Review both.\\nKeep exactly."}]]);window.multiDraft.setTldr(true);window.multiDraft.setOverride("focus-1","null")');await frame();
 const snapshot=()=>run('JSON.stringify({...window.multiDraft.current(),overrides:[...window.multiDraft.current().overrides]})');
 const before=await snapshot();
 const maximize=async i=>{await run('document.querySelector("[data-pane-id=focus-'+i+'] .pane-head").dispatchEvent(new MouseEvent("dblclick",{bubbles:true}))');await frame();await sleep(150);};
 await maximize(2);
 assert.equal(await run('!!document.querySelector(".multi-composer")'),false,'maximizing an unselected pane suspends multi targeting');
 assert.equal(await run('document.querySelector(".composer-dock-target strong")?.textContent'),'Thread 2','To follows the maximized pane');
 await until('!!document.querySelector(".composer-dock textarea")');
 await run('document.querySelector(".composer-dock textarea").focus()');await win.webContents.insertText('Focused draft stays separate.');await frame();
 await shot('focused-single-${width}');
 await click(2,true);await click(2);
 assert.equal(await snapshot(),before,'modified and plain clicks cannot alter the suspended draft');
 assert.equal(await run('document.querySelectorAll(".pane.multi-selected").length'),0);
 await maximize(2);await until('!!document.querySelector(".multi-composer")');
 assert.equal(await snapshot(),before,'zoom out restores the exact multi draft, selection, TLDR and routing');
 assert.equal(await run('document.querySelectorAll(".pane.multi-selected").length'),2);
 await shot('focused-multi-restored-${width}');
 await maximize(2);await until('!!document.querySelector(".composer-dock textarea")');
 assert.equal(await run('document.querySelector(".composer-dock textarea").value'),'Focused draft stays separate.');
 // Sending the focused draft uses the single thread's actual demo send path.
 await sleep(650);await run('document.querySelector(".composer-dock textarea").focus()');
 win.webContents.sendInputEvent({type:'keyDown',keyCode:'Enter'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Enter'});
 await until('document.querySelector(".composer-dock textarea").value===""');
 assert.equal(await snapshot(),before,'single-thread send leaves the suspended multi draft intact');
 assert.equal(await run('document.querySelector("[data-pane-id=focus-2] .transcript").textContent.includes("Focused draft stays separate.")'),true);
 assert.equal(await run('document.querySelector("[data-pane-id=focus-0] .transcript").textContent.includes("Focused draft stays separate.")'),false);
 await maximize(2);await until('!!document.querySelector(".multi-composer")');
 // Ordinary map zoom also suspends multi at the one-pane level.
 await run('(()=>{const m=document.querySelector(".pane-map");m.focus();for(let n=0;n<12;n++)m.dispatchEvent(new KeyboardEvent("keydown",{key:"=",bubbles:true,cancelable:true}))})()');await sleep(400);
 assert.equal(await run('!!document.querySelector(".multi-composer")'),false,'one-pane map zoom uses single targeting');
 await run('(()=>{const m=document.querySelector(".pane-map");m.focus();m.dispatchEvent(new KeyboardEvent("keydown",{key:"End",bubbles:true,cancelable:true}))})()');await sleep(400);
 assert.equal(await run('document.querySelector(".composer-dock-target strong")?.textContent'),'Thread 2','scrolling one-pane zoom retargets to the shown thread');
 assert.equal(await snapshot(),before);
 await run('(()=>{const m=document.querySelector(".pane-map");m.focus();m.dispatchEvent(new KeyboardEvent("keydown",{key:"0",bubbles:true,cancelable:true}))})()');
 await until('!!document.querySelector(".multi-composer")');assert.equal(await snapshot(),before);
 for(const mode of ['Focus left','Focus right']){
  await run('document.querySelector(".layout-picker-trigger").click()');
  await run('[...document.querySelectorAll("[role=menuitemradio]")].find(b=>b.querySelector("strong")?.textContent==='+JSON.stringify(mode)+').click()');await sleep(300);
  await run('(()=>{const m=document.querySelector(".pane-map");m.focus();for(let n=0;n<12;n++)m.dispatchEvent(new KeyboardEvent("keydown",{key:"=",bubbles:true,cancelable:true}))})()');await sleep(300);
  assert.equal(await run('!!document.querySelector(".multi-composer")'),true,mode+' retains multi targeting with a side pane visible');
  assert.equal(await snapshot(),before);
 }
 await shot('focused-target-${width}');
 `,{width,height,plugins:[probe]});
});
