import test from 'node:test';
import { withAppearanceApp } from './helpers/appearance-app.mjs';

// The multi-thread composer is the original composer with tags in it
// (mockups/adaptive-thread-panes.html): same box, +, TL;DR pill and round Send,
// and a To line that reads like the single thread's.
for (const width of [1100, 1512]) test(`multi-thread composer keeps the original composer's look at ${width}px`, { timeout: 150000 }, async () => {
  await withAppearanceApp('multi-frame', String.raw`
    const panes=['a','b','c'].map(id=>({id,workspaceId:'w',kind:'chat',title:'Thread '+id,sample:true}));
    const session={version:1,workspaces:[{id:'w',name:'Sample',path:''}],panes,profiles:[],profileRevision:0,activeWorkspace:'w',focusedPane:'a',section:'threads',arrangements:{':threads':{mode:'grid',order:['a','b','c'],zoom:0,focusShare:.58}},rightPanel:{open:false,tabs:[],active:'dashboard'},canvasVersion:1};
    await win.loadURL(new URL('/branding/mark.svg',win.webContents.getURL()).href);
    await run('localStorage.clear();localStorage.setItem("apex-deck.demo.session.v1",'+JSON.stringify(JSON.stringify(session))+')');
    await load(); await until('!!document.querySelector(".composer-dock textarea")');
    const look=async root=>{await run('document.activeElement?.blur()');await sleep(300);return run('(()=>{const box='+root+'.querySelector(".composer-box");if(!box)return "no .composer-box";const b=box.getBoundingClientRect();const s=getComputedStyle(box);return {left:Math.round(b.left),width:Math.round(b.width),radius:s.borderRadius,background:s.backgroundColor,border:s.borderTopColor,padding:s.padding}})()');};
    await frame();
    const single=await look('document.querySelector(".composer-dock-slot > .composer")');
    const to=await run('(()=>{const t=document.querySelector(".composer-dock-target");const s=getComputedStyle(t);return {left:Math.round(t.getBoundingClientRect().left),font:s.fontSize,color:s.color}})()');
    for (const id of ['a','b']) {
      await run('document.querySelector("[data-pane-id='+id+'] .pane-head").dispatchEvent(new MouseEvent("mousedown",{bubbles:true,button:0,metaKey:true,ctrlKey:true}))');
      await until('!!document.querySelector(".rich-draft-editor")'); await frame();
    }
    await run('document.querySelector(".rich-draft-editor").focus()');
    win.webContents.insertText('Please check the build'); await frame();

    assert.deepEqual(await look('document.querySelector(".multi-composer")'),single,'the same box as the original composer');
    assert.equal(await run('(()=>{const d=document.querySelector(".composer-dock").getBoundingClientRect(),c=document.querySelector(".multi-composer").getBoundingClientRect();return Math.round(d.bottom-c.bottom)})()'),0,'the composer fills the dock: no band of dock under it');
    const parts=await run('(()=>{const c=document.querySelector(".multi-composer"),box=c.querySelector(".composer-input > .composer-box");return {editorInField:!!box?.querySelector(":scope > .composer-field > .rich-draft-editor"),plus:!!box?.querySelector(".composer-plus"),tldr:!!box?.querySelector(":scope > .tldr-pill"),send:!!box?.querySelector(":scope > button.round-send.composer-send"),checkboxes:c.querySelectorAll("input[type=checkbox]").length,plainButtons:[...c.querySelectorAll("button")].map(b=>b.textContent.trim()).filter(t=>/^(Attach|Add|Keep draft|Send)$/.test(t))}})()');
    assert.deepEqual(parts,{editorInField:true,plus:true,tldr:true,send:true,checkboxes:0,plainButtons:[]},'the original +, TL;DR pill and round Send; no plain buttons');

    const summary=await run('(()=>{const s=document.querySelector(".multi-summary"),st=getComputedStyle(s);return {left:Math.round(s.getBoundingClientRect().left),font:st.fontSize,color:st.color,strong:s.querySelector("strong")?.textContent}})()');
    assert.deepEqual(summary,{...to,strong:'2 threads'},'the To line reads like the single thread To line');
    assert.equal(await run('getComputedStyle(document.querySelector(".rich-draft-chip.thread")).backgroundColor'),'rgb(67, 82, 107)','thread tags are the mockup filled chips');

    // Only the thread chips: no thread rows between the To line and the box, even
    // when a pane header's agent dropdown opens. Its menu drops from the header.
    const gap='(()=>{const c=document.querySelector(".multi-composer");return Math.round(c.querySelector(".composer-box").getBoundingClientRect().top-c.querySelector(".multi-summary").getBoundingClientRect().bottom)})()';
    const closed=await run(gap);
    assert.equal(await run('document.querySelector(".multi-summary").textContent.includes("▾")'),false,'the To line has nothing to open');
    await until('!document.querySelector("[data-pane-id=a] .pane-route")?.disabled','the header agent dropdown');
    await run('document.querySelector("[data-pane-id=a] .pane-route").click()'); await frame();
    const menu=await run('(()=>{const m=document.querySelector(".multi-route-menu"),h=document.querySelector("[data-pane-id=a] .pane-route").getBoundingClientRect();if(!m)return "no menu";const r=m.getBoundingClientRect();return {underHeader:Math.abs(r.top-h.bottom)<2&&Math.abs(r.left-h.left)<2,onTop:m.contains(document.elementFromPoint(r.left+r.width/2,r.top+Math.min(12,r.height/2))),agents:m.querySelectorAll("button").length>0}})()');
    assert.deepEqual(menu,{underHeader:true,onTop:true,agents:true},'the header dropdown opens its agent menu under the header, above the panes');
    assert.equal(await run(gap),closed,'no thread rows above the box');
    await shot('multi-frame-${width}');
    await run('document.body.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true}))'); await frame();
    assert.deepEqual(await run('({menu:!!document.querySelector(".multi-route-menu"),multi:!!document.querySelector(".multi-composer")})'),{menu:false,multi:true},'Esc closes the agent menu and stays in multi-send');
  `, { width, height: 945 });
});
