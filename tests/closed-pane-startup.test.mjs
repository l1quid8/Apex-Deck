import test from 'node:test';
import { withAppearanceApp } from './helpers/appearance-app.mjs';

const probe = { name: 'closed-pane-load-probe', enforce: 'pre', transform(code, id) {
  if (!id.endsWith('/src/backend.ts')) return;
  return code.replace('roomCreate: async (id, participants, options) => {',
    'roomCreate: async (id, participants, options) => { (window.roomLoads ??= []).push(id);')
    .replace('roomTargets: async (id, text) => targetsFor(id, text),',
      'roomTargets: async (id, text) => { if(window.holdRouting && text === "pending-close-probe") await new Promise(resolve => window.routeWaiters.push(resolve)); return targetsFor(id,text); },');
} };

test('startup loads open threads while retaining closed history for reopening', { timeout: 120000 }, async () => {
  await withAppearanceApp('closed-pane-startup', String.raw`
    const panes = Array.from({length:48}, (_, i) => ({id:'startup-'+i, workspaceId:'startup-w', kind:'chat', title:'Startup '+i, sample:true, ...(i>=4?{closed:true}:{})}));
    const session = {version:1, workspaces:[{id:'startup-w',name:'Sample',path:''}], panes, profiles:[], profileRevision:0, activeWorkspace:'startup-w', focusedPane:'startup-0', section:'threads', arrangements:{':threads':{mode:'grid',order:panes.slice(0,4).map(p=>p.id),zoom:1,focusShare:.58}}, rightPanel:{open:false,tabs:[],active:'dashboard'}, canvasVersion:1};
    await win.loadURL(new URL('/branding/mark.svg',win.webContents.getURL()).href);
    await run('localStorage.clear();localStorage.setItem("apex-deck.demo.session.v1",'+JSON.stringify(JSON.stringify(session))+')');
    await load();
    await until('window.roomLoads?.length>=4 && !!document.querySelector(".composer textarea")');
    await frame();
    assert.deepEqual(await run('[...new Set(window.roomLoads)].sort()'), ['startup-0','startup-1','startup-2','startup-3'], 'closed history must not open rooms or start polling hooks');
    assert.equal(await run('document.querySelectorAll(".pane-map-slot").length'),4);
    const saved=await run('JSON.parse(localStorage.getItem("apex-deck.demo.session.v1"))');
    assert.equal(saved.panes.length,48,'closed history remains saved');
    await run('document.querySelector("[data-pane-row=startup-47]").click()');
    await until('window.roomLoads?.includes("startup-47")');
    assert.equal(await run('document.querySelectorAll(".pane-map-slot").length'),5,'reopened history mounts normally');
    await run('document.querySelector("[data-pane-row=startup-0]").click()');
    await until('!!document.querySelector(".composer textarea")');
    await run('window.holdRouting=true;window.routeWaiters=[];document.querySelector(".composer textarea").focus()');
    await win.webContents.insertText('pending-close-probe');
    win.webContents.sendInputEvent({type:'keyDown',keyCode:'Enter'});
    win.webContents.sendInputEvent({type:'keyUp',keyCode:'Enter'});
    await until('window.routeWaiters.length>=2','both preview and admitted send are waiting for routing');
    await run('[...document.querySelectorAll("button")].find(b=>b.getAttribute("aria-label")==="Close Startup 0").click()');
    await frame();
    assert.equal(await run('!!document.querySelector(".pane-map-slot[data-pane-id=startup-0]")'),true,'a closing thread retains its unconfirmed local send');
    await run('window.holdRouting=false;window.routeWaiters.forEach(resolve=>resolve())');
    await until('JSON.parse(localStorage.getItem("apex-deck.demo.room.startup-0")).transcript.some(m=>m.text==="pending-close-probe")','the admitted send is saved after closing');
    assert.equal(await run('JSON.parse(localStorage.getItem("apex-deck.demo.room.startup-0")).transcript.filter(m=>m.text==="pending-close-probe").length'),1,'closing during routing sends exactly once');
    assert.equal(await run('!!document.querySelector(".pane-map-slot[data-pane-id=startup-0]")'),true,'hydrated panes retain drafts and live calls for the session');
    await run('document.querySelector("[data-pane-row=startup-0]").click()');
    await until('document.querySelector(".composer textarea")?.value===""');
    await run('document.querySelector(".composer textarea").focus()');
    await win.webContents.insertText('draft kept through close');
    await run('[...document.querySelectorAll("button")].find(b=>b.getAttribute("aria-label")==="Close Startup 0").click()');
    await frame();
    await run('document.querySelector("[data-pane-row=startup-0]").click()');
    await until('document.querySelector(".composer textarea")?.value==="draft kept through close"','unsent draft survives close and reopen');
  `, { plugins:[probe] });
});
