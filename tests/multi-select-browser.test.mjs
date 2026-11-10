import test from 'node:test';
import { withAppearanceApp } from './helpers/appearance-app.mjs';

// Expose the production hook only in this fixture, including same-event reads.
const probe = { name: 'multi-draft-probe', enforce: 'pre', transform(code, id) {
  if (!id.endsWith('/src/App.tsx')) return;
  return code.replace('const multiDraft = useMultiDraft();', 'const multiDraft = useMultiDraft(); (window as any).multiDraft = multiDraft;')
    .replace('void backend.snapshotDrop!(path)', 'void (window as any).snapshotDrop(path)')
    .replace('const multiDrop = useRef<', '(window as any).multiFiles = multiFiles; const multiDrop = useRef<')
    .replace('multiDrop.current = (paths, x, y) => {', '(window as any).multiDrop = multiDrop; multiDrop.current = (paths, x, y) => {');
}};

test('App selects thread tags in click order, preserves drafts on exit and takes synchronously', {timeout: 120000}, async () => {
  await withAppearanceApp('multi-select', String.raw`
    const ids=Array.from({length:10},(_,i)=>'multi-'+i);
    const panes=ids.map((id,i)=>({id,workspaceId:'multi-w',kind:'chat',title:'Thread '+i,sample:true}));
    const session={version:1,workspaces:[{id:'multi-w',name:'Sample',path:''}],panes,profiles:[],profileRevision:0,activeWorkspace:'multi-w',focusedPane:ids[0],section:'threads',arrangements:{':threads':{mode:'grid',order:ids,zoom:0,focusShare:.58}},rightPanel:{open:false,tabs:[],active:'dashboard'},canvasVersion:1};
    await win.loadURL(new URL('/branding/mark.svg',win.webContents.getURL()).href);
    await run('localStorage.clear();localStorage.setItem("apex-deck.demo.session.v1",'+JSON.stringify(JSON.stringify(session))+')');
    await load(); await until('document.querySelectorAll(".pane-map-slot").length===10');
    const click=async(i,modified=false,where='.pane-head')=>{await run('document.querySelector("[data-pane-id=multi-'+i+'] '+where+'").dispatchEvent(new MouseEvent("mousedown",{bubbles:true,button:0,metaKey:'+modified+',ctrlKey:'+modified+'}))');await frame();};
    const selected=()=>run('[...document.querySelectorAll(".pane.multi-selected")].map(p=>p.dataset.paneId)');
    const ordered=()=>run('window.multiDraft.selected');
    await click(0); await click(2,true,'.thread-name-text'); await click(3,true); await click(1,true);
    await until('!!document.querySelector(".composer-dock .rich-draft-editor")','multi editor replaces dock composer');
    assert.deepEqual(await selected(),['multi-0','multi-1','multi-2','multi-3']);
    assert.deepEqual(await ordered(),['multi-0','multi-2','multi-3','multi-1']);
    await click(3,true); assert.deepEqual(await ordered(),['multi-0','multi-2','multi-1']);
    const doc=await run('window.multiDraft.current().doc');
    await run('window.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true}))'); await frame();
    assert.deepEqual(await selected(),[]); assert.deepEqual(await run('window.multiDraft.current().doc'),doc);
    await click(5,true); assert.deepEqual(await ordered(),['multi-0','multi-2','multi-1','multi-5']);
    await click(2); assert.equal((await selected()).length,4,'plain selected click keeps selection');
    await click(9,false,'.transcript'); assert.deepEqual(await selected(),[]);
    assert.equal((await run('window.multiDraft.current().doc')).length,4);
    await click(2,true); await click(3,true);
    await run('window.multiDraft.setTldr(true);window.multiDraft.setOverride("multi-0","null")');
    const taken=await run('(()=>{const before=window.multiDraft.current();const picked=before.overrides.get("multi-0");const taken=window.multiDraft.take();const after=window.multiDraft.current();return {before,taken,after,picked,picksLeft:after.overrides.size}})()');
    assert.deepEqual(taken.taken.doc,taken.before.doc); assert.equal(taken.after.on,false);
    assert.deepEqual(taken.after.doc,[]); assert.notEqual(taken.after.draftId,taken.before.draftId);
    assert.equal(taken.picked,'null'); assert.equal(taken.picksLeft,0); assert.equal(taken.after.tldr,true);
    await frame(); assert.deepEqual(await selected(),[]);
    // Text and interactive controls must keep their native modified-click behavior.
    await click(0); await run('(()=>{const t=document.createElement("span");t.id="selection-text";t.textContent="select this";document.querySelector("[data-pane-id=multi-2] .transcript").append(t)})()');
    await click(2,true,'#selection-text'); assert.deepEqual(await selected(),[]);
    await run('document.querySelector("[data-pane-id=multi-2] .pane-head button").dispatchEvent(new MouseEvent("mousedown",{bubbles:true,metaKey:true}))'); await frame();
    assert.deepEqual(await selected(),[]);
    // Same-task mutations and Undo use the ref, without relying on a render.
    const undo=await run('(()=>{const d=window.multiDraft;const doc=[[{kind:"thread",paneId:"multi-0",hostId:"local"},{kind:"text",text:" keep me"}],[{kind:"thread",paneId:"multi-2",hostId:"local"},{kind:"text",text:" two"}]];d.setDoc(doc);d.toggle("multi-0","local");const removed=d.current().doc;d.undoRemove();return {doc,removed,restored:d.current().doc}})()');
    assert.equal(undo.removed.length,1); assert.deepEqual(undo.restored,undo.doc);
    await frame();
    await run('document.querySelector(".layout-picker-trigger").click()'); await frame();
    await run('document.querySelector(".layout-picker-trigger").dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true}))'); await frame();
    assert.equal((await selected()).length,2,'closing layout picker keeps multi selection');
    await run('document.querySelector(".pane-map").dispatchEvent(new KeyboardEvent("keydown",{key:"-",bubbles:true,cancelable:true}))'); await frame();
    assert.equal((await selected()).length,2,'zoom retains selection');
    const edited=await run('(()=>{const d=window.multiDraft;d.setDoc([[{kind:"thread",paneId:"multi-0",hostId:"local"},{kind:"thread",paneId:"multi-2",hostId:"local"},{kind:"text",text:" old"}]]);d.toggle("multi-0","local");const changed=[[{kind:"thread",paneId:"multi-2",hostId:"local"},{kind:"text",text:" edited"}]];d.setDoc(changed);d.undoRemove();return {changed,actual:d.current().doc}})()');
    assert.deepEqual(edited.actual,edited.changed,'stale removal undo cannot overwrite later edits');
    const sameTask=await run('(()=>{window.multiDraft.take();const pane=document.querySelector("[data-pane-id=multi-3] .pane-head");pane.dispatchEvent(new MouseEvent("mousedown",{bubbles:true,metaKey:true,ctrlKey:true}));pane.dispatchEvent(new MouseEvent("mousedown",{bubbles:true}));return window.multiDraft.current().on})()');
    assert.equal(sameTask,true,'plain click reads the selection from the earlier handler in the same task');
    await frame();
    await run('window.multiDraft.take()'); await frame();
    const head=await run('(()=>{const h=document.querySelector("[data-pane-id=multi-1] .pane-head");h.scrollIntoView({block:"nearest"});const r=h.getBoundingClientRect();return {x:Math.round(r.left+10),y:Math.round(r.top+10)}})()');
    const mods=[process.platform==='darwin'?'meta':'control'];
    const beforeOrder=await run('JSON.stringify([...document.querySelectorAll(".pane-map-slot")].map(s=>s.dataset.paneId))');
    win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...head,modifiers:mods});
    win.webContents.sendInputEvent({type:'mouseMove',x:head.x+20,y:head.y+10,modifiers:mods});
    win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,x:head.x+20,y:head.y+10,modifiers:mods});
    await until('window.multiDraft.selected.includes("multi-1")');
    assert.equal(await run('JSON.stringify([...document.querySelectorAll(".pane-map-slot")].map(s=>s.dataset.paneId))'),beforeOrder,'modified title selection never starts reordering');
    await run('document.querySelector("[data-pane-id=multi-1] .pane-head").dispatchEvent(new MouseEvent("dblclick",{bubbles:true,metaKey:true,ctrlKey:true}))'); await frame();
    assert.equal(await run('document.querySelector(".pane-map").hasAttribute("data-many")'),true,'modified double click keeps the multi-pane layout');
    // The native-drop callback snapshots once and owns a reading chip immediately.
    await run('window.snapshotDrop=()=>{window.reads=(window.reads||0)+1;return new Promise(resolve=>window.resolveDrop=resolve)};void 0');
    await run('(()=>{const r=document.querySelector(".multi-composer").getBoundingClientRect();window.multiDrop.current(["/tmp/shot.png"],r.x+20,r.y+20)})()');await frame();
    assert.equal(await run('window.reads'),1);assert.equal(await run('window.multiFiles.size'),1);
    assert.equal(await run('[...window.multiFiles.values()][0].bytes'),null);
    // A Send/clear generation cannot be repopulated by an old disk read.
    await run('window.multiDraft.take();window.resolveDrop({kind:"file",name:"shot.png",bytes:new Uint8Array([1,2,3])})');await frame();
    assert.equal(await run('window.multiFiles.size'),0);assert.deepEqual(await run('window.multiDraft.current().doc'),[]);
  `, {width:1512,height:945,plugins:[probe]});
});
