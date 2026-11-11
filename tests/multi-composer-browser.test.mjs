import test from 'node:test';
import { withAppearanceApp } from './helpers/appearance-app.mjs';

const fixture = `import React,{useState} from 'react';import{createRoot}from'react-dom/client';
import{MultiComposer}from'/src/MultiComposer.tsx';import{useMultiDraft}from'/src/useMultiDraft.ts';import{useMultiBatches}from'/src/useMultiBatches.ts';import'/src/styles.css';
const calls=[];window.calls=calls;const apis={get(id){return{paneId:id,hostId:'local',queue:id,canPickAgent:true,submit(p){calls.push([id,'submit',p]);return{queue:id,id:1}},command(c){calls.push([id,'command',c]);return{queue:id,id:1}},watch(ref,fn){fn('waiting');return()=>{}},status(){return'waiting'}}},subscribe(){return()=>{}}};
const agents=[{id:'null',handle:'null',name:'Null'},{id:'muck',handle:'muck',name:'Muck'}];
const threads=new Map(['A','B','C','D','E'].map(id=>[id,{paneId:id,hostId:'local',title:'Thread '+id,project:'Project',open:true,agents,defaultAgentIds:['null']} ]));
const tag=paneId=>({kind:'thread',paneId,hostId:'local'});const text=text=>({kind:'text',text});
function Fixture(){const draft=useMultiDraft();const batches=useMultiBatches(apis);const[flashed,flash]=useState([]);const[routeRequest,setRouteRequest]=useState();window.fixture={draft,batches,threads,header(paneId){setRouteRequest({paneId,anchor:new DOMRect(20,30,80,15),seq:Date.now()})},init(){draft.setDoc([[tag('A'),text(' what is the status')],[tag('B'),text(' @Muck run the dev server')],[tag('C'),text(' create a plan')],[tag('D'),text(' /compact')]]);draft.open()},empty(){draft.setDoc([[tag('A'),text(' hello')],[tag('B')]])},duplicate(){draft.setDoc([[tag('A'),tag('A'),text(' hi')]])}};return <div className='rail'><div>{flashed.join(',')}</div>{draft.on?<MultiComposer routeRequest={routeRequest} draft={draft} batches={batches} apis={apis} threads={threads} files={new Map()} onAttachFiles={()=>{}} onReveal={()=>{}} onFlash={flash}/>:<div>Single composer</div>}</div>};createRoot(document.getElementById('root')).render(<Fixture/>);`;
const plugin={name:'multi-composer-fixture',enforce:'pre',transform(code,id){if(id.endsWith('/src/main.tsx'))return fixture;}};

test('multi composer previews routing, blocks the entire empty/duplicate batch and claims sends synchronously', {timeout:120000}, async()=>{
  await withAppearanceApp('multi-composer',String.raw`
    await until('!!window.fixture');await run('window.fixture.init()');await frame();
    assert.equal(await run('document.querySelector(".multi-summary").textContent'),'To 4 threads · Null ×2, Muck · 1 command');
    // Only the thread chips: a blocked draft says why in the To line, with no thread rows above the box.
    const gap='(()=>{const c=document.querySelector(".multi-composer");return Math.round(c.querySelector(".composer-box").getBoundingClientRect().top-c.querySelector(".multi-summary").getBoundingClientRect().bottom)})()';
    const closed=await run(gap);
    await run('window.fixture.empty()');await frame();
    assert.equal(await run('document.querySelector(".composer-send").disabled'),false);
    // Capture the real feedback transition before slow runner frames can
    // outlast its 1200ms lifetime. The blocked batch must still send nothing.
    const blocked=await run('new Promise(resolve=>{const b=document.querySelector(".composer-send");let timer;const observer=new MutationObserver(()=>{if(b.classList.contains("shake")){clearTimeout(timer);observer.disconnect();resolve({calls:window.calls.length,shake:true})}});observer.observe(b,{attributes:true,attributeFilter:["class"]});timer=setTimeout(()=>{observer.disconnect();resolve({calls:window.calls.length,shake:false})},10000);b.click()})');
    assert.equal(blocked.calls,0);assert.equal(blocked.shake,true);
    await run('window.fixture.duplicate()');await frame();
    assert.equal(await run('document.querySelector(".composer-send").disabled'),true);
    assert.match(await run('document.querySelector(".multi-summary").textContent'),/^To 1 thread · duplicate: Thread A$/,'the To line names the problem');
    assert.equal(await run(gap),closed,'no thread rows above the box when blocked');
    await run('window.fixture.init()');await frame();
    await run('(()=>{const b=document.querySelector(".composer-send");b.click();b.click()})()');await frame();
    const calls=await run('window.calls');assert.equal(calls.length,4);
    assert.deepEqual(calls.map(c=>[c[0],c[1],typeof c[2]==="string"?c[2]:c[2].text]),[['A','submit','what is the status'],['B','submit','@Muck run the dev server'],['C','submit','create a plan'],['D','command','compact']]);
    assert.equal(await run('window.fixture.draft.current().on'),false);assert.deepEqual(await run('window.fixture.draft.current().doc'),[]);
  `,{plugins:[plugin],width:1512,height:945});
});

test('multi composer pickers use live caret, protect newer text, and show actual typed routing', {timeout:120000}, async()=>{
  await withAppearanceApp('multi-composer-pickers',String.raw`
    await until('!!window.fixture');await run('window.fixture.init()');await frame();
    await run('document.querySelector(".multi-summary").dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true,cancelable:true}))');await frame();
    assert.equal(await run('window.calls.length'),0,'Enter on a review control cannot send');
    const set=async(doc)=>{await run('window.fixture.draft.setDoc('+JSON.stringify(doc)+')');await frame();};
    const tag={kind:'thread',paneId:'A',hostId:'local'};
    const atEnd=async()=>{await run('(()=>{const e=document.querySelector(".rich-draft-editor"),r=document.createRange();e.focus();r.selectNodeContents(e.lastChild);r.collapse(false);const s=getSelection();s.removeAllRanges();s.addRange(r);e.dispatchEvent(new MouseEvent("mouseup",{bubbles:true}));})()');await frame();};
    await set([[tag,{kind:'text',text:' hello #E'}]]);await atEnd();
    assert.equal(await run('document.querySelector("[role=listbox]").getAttribute("aria-label")'),'Threads');
    await run('[...document.querySelectorAll("[role=option]")].find(b=>b.textContent.startsWith("Thread E")).click()');await frame();
    assert.deepEqual(await run('window.fixture.draft.current().doc'),[[tag,{kind:'text',text:' hello '},{kind:'thread',paneId:'E',hostId:'local'}]]);
    await set([[tag,{kind:'text',text:' hi @m'}]]);await atEnd();
    await run('[...document.querySelectorAll("[role=option]")].find(b=>b.textContent==="Muck").click()');await frame();
    assert.deepEqual(await run('window.fixture.draft.current().doc'),[[tag,{kind:'text',text:' hi @muck ' }]]);
    await set([[tag,{kind:'text',text:' hello #E'}]]);await atEnd();
    const newer=[[tag,{kind:'text',text:' entirely new words'}]];
    await run('(()=>{const old=[...document.querySelectorAll("[role=option]")].find(b=>b.textContent.startsWith("Thread E"));window.fixture.draft.setDoc('+JSON.stringify(newer)+');old.click();})()');await frame();
    assert.deepEqual(await run('window.fixture.draft.current().doc'),newer,'old picker cannot replace newer text');
    await set([[tag,{kind:'text',text:' @null status'}]]);
    const gap='(()=>{const c=document.querySelector(".multi-composer");return Math.round(c.querySelector(".composer-box").getBoundingClientRect().top-c.querySelector(".multi-summary").getBoundingClientRect().bottom)})()';
    const closed=await run(gap);
    await run('window.fixture.draft.setOverride("A","muck");window.fixture.header("A")');await frame();
    assert.equal(await run(gap),closed,'the header dropdown adds no thread rows above the box');
    assert.equal(await run('document.querySelector(".multi-summary").textContent'),'To 1 thread · Null','typed routing shows in the To line');
    assert.equal(await run('getComputedStyle(document.querySelector(".multi-route-menu")).position'),'fixed');
    assert.equal(await run('document.querySelector(".multi-route-menu").style.top'),'45px');
    await run('[...document.querySelectorAll(".multi-route-menu button")].find(b=>b.textContent==="Muck").click()');await frame();
    assert.equal(await run('!!document.querySelector(".multi-route-menu")'),false,'picking closes the agent menu');
    assert.equal(await run('document.querySelector(".multi-summary").textContent'),'To 1 thread · Null','typed routing beats a dropdown override');
    await set([[tag,{kind:'text',text:' contact user@example.com'}]]);
    assert.equal(await run('document.querySelector(".multi-summary").textContent'),'To 1 thread · Muck','email does not override the chosen one-send agent');
    await run('window.fixture.header("A")');await frame();
    await run('document.body.dispatchEvent(new PointerEvent("pointerdown",{bubbles:true}))');await frame();
    assert.equal(await run('!!document.querySelector(".multi-route-menu")'),false,'a click elsewhere closes the agent menu');
    await run('window.fixture.header("A")');await frame();
    await run('window.fixture.draft.exit()');await frame();await run('window.fixture.draft.open()');await frame();
    assert.equal(await run('!!document.querySelector(".multi-route-menu")'),false,'reopening multi-send does not replay an old header click');
    await set([[tag,{kind:'text',text:' @ghost status'}]]);await run('window.fixture.header("A")');await frame();
    await run('[...document.querySelectorAll(".multi-route-menu button")].find(b=>b.textContent==="Null").click()');await frame();
    assert.equal(await run('window.fixture.draft.current().doc[0][1].text'),' @null status','unknown typed mention is visibly replaced');
  `,{plugins:[plugin],width:1512,height:945});
});
