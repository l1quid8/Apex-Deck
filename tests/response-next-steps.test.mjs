import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { withAppearanceApp } from './helpers/appearance-app.mjs';

test('desktop suggestions belong to the latest offering reply, not the composer', () => {
  const src = fs.readFileSync('src/ChatPane.tsx', 'utf8');
  assert.match(src, /newestReply\.get\(entry\.message\.speaker\.id\) === entry\.message\.seq[\s\S]*?<ReplyNextSteps/);
  assert.match(src, /<QuestionForm view=\{composerForm\}/);
  assert.doesNotMatch(src, /form\.kind === "steps" && !text/);
});

const fixture = { name: 'reply-steps-fixture', enforce: 'pre', transform(code, id) {
  if (!id.endsWith('/src/App.tsx')) return;
  return `import React from 'react';
    import { ReplyNextSteps } from './ReplyNextSteps';
    export function App(){
      const [offer,setOffer]=React.useState({by:'jigga',pending:false,steps:[{label:'Review changes',prompt:'Review the changes.'},{label:'Check edge cases',prompt:'Check edge cases.'},{label:'Plan next step',prompt:'Plan the next step.'}]});
      window.replaceOffer=()=>setOffer({...offer,steps:[{label:'New suggestion',prompt:'New prompt'}]});
      window.sent=window.sent||[];
      return <main className="rail" style={{display:'block',width:'100%',padding:20}}><article style={{width:'100%'}}><p>Sample response</p><ReplyNextSteps key={JSON.stringify(offer)} offer={offer} onStep={(step,by)=>window.sent.push({step,by})}/></article><textarea defaultValue="Keep this draft"/></main>;
    }`;
}};

const appHooks = { name: 'reply-steps-app-hooks', enforce: 'pre', transform(code,id) {
  if (!id.endsWith('/src/App.tsx')) return;
  return `import {recordQuestion as recordTestQuestion} from './questions'; window.recordTestQuestion=recordTestQuestion;\n`+code;
}};

test('App puts suggestions beneath the correct reply and leaves composer typing alone', {timeout:150000}, async () => {
  await withAppearanceApp('reply-next-steps-app',String.raw`
    const session={version:1,workspaces:[{id:'w',name:'Sample',path:''}],panes:[{id:'a',workspaceId:'w',kind:'chat',title:'Thread a',sample:true}],profiles:[],profileRevision:0,activeWorkspace:'w',focusedPane:'a',section:'threads',arrangements:{':threads':{mode:'grid',order:['a'],zoom:0,focusShare:.58}},rightPanel:{open:false,tabs:[],active:'dashboard'},canvasVersion:1};
    await win.loadURL(new URL('/branding/mark.svg',win.webContents.getURL()).href);
    await run('localStorage.clear();localStorage.setItem("apex-deck.demo.session.v1",'+JSON.stringify(JSON.stringify(session))+')');
    await load();await until('!!document.querySelector(".composer-dock textarea") && !document.querySelector(".composer-dock textarea").disabled');
    await run('document.querySelector(".composer-dock textarea").focus()');win.webContents.insertText('@ada hi');await frame();
    win.webContents.sendInputEvent({type:'keyDown',keyCode:'Return'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Return'});
    await until('!!document.querySelector(".bubble.bot.completed")');
    const offer={type:'next_steps',id:'ada',pending:false,steps:[{label:'Review changes',prompt:'Review changes'}]};
    await run('window.recordTestQuestion("a",'+JSON.stringify(offer)+')');
    await until('!!document.querySelector(".bubble.bot.completed .reply-next-step")');
    assert.equal(await run('document.querySelectorAll(".composer .qform").length'),0);
    assert.equal(await run('document.querySelectorAll(".reply-next-steps").length'),1);
    assert.equal(await run('document.querySelector(".reply-next-steps").closest(".bubble").querySelector(".speaker").textContent.trim()'),'Ada');
    await run('document.querySelector(".composer-dock textarea").focus()');
    assert.equal(await run('(()=>{const e=new KeyboardEvent("keydown",{key:"1",bubbles:true,cancelable:true});document.querySelector(".composer-dock textarea").dispatchEvent(e);return e.defaultPrevented})()'),false,'number shortcut no longer captures composer input');
    win.webContents.insertText('1');await frame();
    assert.equal(await run('document.querySelector(".composer-dock textarea").value'),'1','a number types rather than sending a follow-up');
    await shot('reply-next-steps-app');
    await run('window.recordTestQuestion("a",{type:"turn_started",id:"ada"})');await frame();
    assert.equal(await run('document.querySelectorAll(".reply-next-steps").length'),0);
  `,{width:1100,height:650,plugins:[appHooks]});
});

test('reply suggestions collapse, expand, route and wrap without changing the draft', {timeout:150000}, async () => {
  await withAppearanceApp('reply-next-steps', String.raw`
    await until('!!document.querySelector(".reply-next-steps-toggle")');
    const toggle='document.querySelector(".reply-next-steps-toggle")';
    assert.equal(await run(toggle+'.textContent'),'‹');
    await run(toggle+'.focus();'+toggle+'.click()');await frame();
    assert.equal(await run('document.activeElement.className'),'reply-next-steps-toggle','collapse keeps keyboard focus');
    assert.equal(await run(toggle+'.getAttribute("aria-expanded")'),'false');
    assert.equal(await run(toggle+'.textContent'),'›');
    assert.equal(await run('document.querySelectorAll(".reply-next-step").length'),0);
    await run(toggle+'.click()');await frame();
    await run('document.querySelector(".reply-next-step").click()');await frame();
    assert.deepEqual(await run('window.sent'),[{step:{label:'Review changes',prompt:'Review the changes.'},by:'jigga'}]);
    assert.equal(await run('document.querySelector("textarea").value'),'Keep this draft');
    await run('document.querySelector("article").style.width="280px"');await frame();
    const layout=await run('(()=>{const box=document.querySelector(".reply-next-steps"),r=[...box.querySelectorAll(".reply-next-step")].map(b=>b.getBoundingClientRect());const t=box.querySelector(".reply-next-steps-toggle").getBoundingClientRect();return {aligned:r.every(x=>Math.abs(x.left-r[0].left)<1),rows:r[1].top>r[0].top,attached:Math.abs(t.left-r[2].right-4)<1,overflow:box.scrollWidth>box.clientWidth}})()');
    assert.deepEqual(layout,{aligned:true,rows:true,attached:true,overflow:false});
    await shot('reply-next-steps-narrow');
    await run('document.querySelector("article").style.width="100%"');await frame();await shot('reply-next-steps-wide');
    await run(toggle+'.click()');await frame();
    await run('window.replaceOffer()');await frame();
    assert.equal(await run(toggle+'.getAttribute("aria-expanded")'),'true','new suggestions start expanded');
  `,{width:900,height:650,plugins:[fixture]});
});
