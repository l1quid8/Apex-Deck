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
      window.setSteps=steps=>setOffer(o=>({...o,steps}));
      window.sent=window.sent||[];
      return <main className="rail" style={{display:'block',width:'100%',padding:20}}><article style={{width:'100%'}}><p>Sample response</p><ReplyNextSteps key={JSON.stringify(offer)} offer={offer} onStep={(step,by)=>window.sent.push({step,by})}/></article><textarea defaultValue="Keep this draft"/></main>;
    }`;
}};

const appHooks = { name: 'reply-steps-app-hooks', enforce: 'pre', transform(code,id) {
  if (!id.endsWith('/src/App.tsx')) return;
  return `import {recordQuestion as recordTestQuestion} from './questions'; window.recordTestQuestion=recordTestQuestion;\n`+code;
}};

/** Geometry of the suggestion row: how many lines it uses, whether it
 *  overflows, whether a separator was pushed to the start of a line, the gap
 *  after each separator, and where the chevron sits. */
const MEASURE = `(()=>{
  const box=document.querySelector('.reply-next-steps-links');
  const rects=el=>{const r=document.createRange();r.selectNodeContents(el);return [...r.getClientRects()].filter(x=>x.width>0).map(x=>({left:x.left,right:x.right,top:x.top,bottom:x.bottom}));};
  const buttons=[...document.querySelectorAll('.reply-next-step')];
  const dots=[...document.querySelectorAll('.reply-next-steps-dot')];
  const t=document.querySelector('.reply-next-steps-toggle').getBoundingClientRect();
  const last=rects(buttons.at(-1)).at(-1);
  return {
    lines:[...new Set(buttons.flatMap(rects).map(r=>Math.round(r.top)))].length,
    broken:buttons.filter(b=>new Set(rects(b).map(r=>Math.round(r.top))).size>1).length,
    overflow:box.scrollWidth>box.clientWidth+1,
    dotsLeadRow:dots.filter((d,i)=>Math.abs(d.getBoundingClientRect().top-rects(buttons[i]).at(-1).top)>1).length,
    dotGaps:dots.map((d,i)=>Math.round(d.getBoundingClientRect().left-rects(buttons[i]).at(-1).right)),
    toggleGap:Math.round(t.left-last.right),
    toggleOnLastLine:Math.abs((t.top+t.height/2)-(last.top+last.bottom)/2)<5
  };})()`;

const LONG_STEPS = [
  {label:"Stop learned positions, start Null's fixes",prompt:"Stop learned positions and start Null's fixes instead."},
  {label:'Plan the branch-and-join reasoning test',prompt:'Plan the branch-and-join reasoning test and write the criteria down.'},
  {label:'Commit round-4 README and HANDOFF §18',prompt:'Commit the round-4 README and the HANDOFF §18 section.'}
];

test('long suggestions run together on one line instead of orphaning a row', {timeout:150000}, async () => {
  await withAppearanceApp('reply-next-steps-flow', String.raw`
    await until('!!document.querySelector(".reply-next-steps-toggle")');
    await run(${JSON.stringify(`window.setSteps(${JSON.stringify(LONG_STEPS)})`)});await frame();
    await run('document.querySelector("article").style.width="900px"');await frame();
    const wide=await run(${JSON.stringify(MEASURE)});
    assert.equal(wide.overflow,false,'nothing spills out of the reply');
    assert.equal(wide.lines,1,'three suggestions fit on one flowing line');
    assert.deepEqual(wide.dotGaps,[10,10],'each separator sits 10px after the suggestion it follows');
    assert.equal(wide.toggleGap,4,'the chevron stays 4px after the last suggestion');
    assert.equal(wide.toggleOnLastLine,true);
    await shot('reply-next-steps-flow-wide');
    await run('document.querySelector("article").style.width="420px"');await frame();
    const narrow=await run(${JSON.stringify(MEASURE)});
    assert.ok(narrow.lines>1,'narrow panes still wrap');
    assert.ok(narrow.broken>0,'a long suggestion runs on across the line break instead of being pushed whole to the next row');
    assert.equal(narrow.overflow,false);
    assert.equal(narrow.dotsLeadRow,0,'a wrapped line never starts with a separator');
    assert.equal(narrow.toggleGap,4);
    await shot('reply-next-steps-flow-narrow');
  `,{width:900,height:650,plugins:[fixture]});
});

test('hovering or focusing a suggestion previews the prompt it sends', {timeout:150000}, async () => {
  await withAppearanceApp('reply-next-steps-preview', String.raw`
    await until('!!document.querySelector(".reply-next-steps-toggle")');
    const at=await run('(()=>{const b=document.querySelectorAll(".reply-next-step")[1].getBoundingClientRect();return {x:Math.round(b.left+6),y:Math.round(b.top+b.height/2)}})()');
    win.webContents.sendInputEvent({type:'mouseMove',x:at.x,y:at.y});
    await until('!!document.querySelector(".reply-next-steps-tip")','the hover preview');
    const tip=await run('(()=>{const t=document.querySelector(".reply-next-steps-tip"),b=document.querySelectorAll(".reply-next-step")[1].getBoundingClientRect();return {text:t.textContent,role:t.getAttribute("role"),above:t.getBoundingClientRect().bottom<=b.top+1}})()');
    assert.deepEqual(tip,{text:'Check edge cases.',role:'tooltip',above:true},'the preview names the prompt and sits above the suggestion');
    assert.equal(await run('(()=>{const id=document.querySelectorAll(".reply-next-step")[1].getAttribute("aria-describedby");return id&&document.getElementById(id).textContent})()'),'Check edge cases.','screen readers get the same description');
    win.webContents.sendInputEvent({type:'mouseMove',x:4,y:4});
    await until('!document.querySelector(".reply-next-steps-tip")','leaving hides the preview');
    assert.equal(await run('!!document.querySelector(".reply-next-steps-tip")'),false,'leaving hides the preview');
    await run('document.querySelectorAll(".reply-next-step")[2].focus()');
    // A hidden test window never fires focus itself; send what Chromium would.
    await run('document.querySelectorAll(".reply-next-step")[2].dispatchEvent(new FocusEvent("focusin",{bubbles:true}))');await frame();
    await until('!!document.querySelector(".reply-next-steps-tip")','focus shows the preview');
    assert.equal(await run('document.querySelector(".reply-next-steps-tip").textContent'),'Plan the next step.');
    await run('document.querySelectorAll(".reply-next-step")[2].dispatchEvent(new FocusEvent("focusout",{bubbles:true}))');await frame();
    assert.equal(await run('!!document.querySelector(".reply-next-steps-tip")'),false,'blur hides the preview');
    await shot('reply-next-steps-preview');
  `,{width:900,height:650,plugins:[fixture]});
});

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
    const layout=await run(` + JSON.stringify(MEASURE) + `);
    assert.equal(layout.overflow,false);
    assert.ok(layout.lines>1,'the narrow layout still wraps');
    assert.equal(layout.dotsLeadRow,0,'no separator starts a wrapped line');
    assert.equal(layout.toggleGap,4);
    await shot('reply-next-steps-narrow');
    await run('document.querySelector("article").style.width="100%"');await frame();await shot('reply-next-steps-wide');
    await run(toggle+'.click()');await frame();
    await run('window.replaceOffer()');await frame();
    assert.equal(await run(toggle+'.getAttribute("aria-expanded")'),'true','new suggestions start expanded');
  `,{width:900,height:650,plugins:[fixture]});
});

test('on a touch screen a hold previews the prompt and does not send it; a tap sends', {timeout:150000}, async () => {
  await withAppearanceApp('reply-next-steps-touch', String.raw`
    await until('!!document.querySelector(".reply-next-steps-toggle")');
    const step='document.querySelectorAll(".reply-next-step")[1]';
    const touch=(type)=>run('(()=>{const el='+step+',b=el.getBoundingClientRect();el.dispatchEvent(new PointerEvent("'+type+'",{bubbles:'+(type!=='pointerenter')+',pointerType:"touch",isPrimary:true,pointerId:7,clientX:b.left+6,clientY:b.top+4}));})()');
    await touch('pointerenter');await touch('pointerdown');
    await sleep(150);
    assert.equal(await run('!!document.querySelector(".reply-next-steps-tip")'),false,'a touch does not preview straight away, so a tap stays a tap');
    await until('!!document.querySelector(".reply-next-steps-tip")','a hold previews the prompt');
    assert.equal(await run('document.querySelector(".reply-next-steps-tip").textContent'),'Check edge cases.');
    await touch('pointerup');await run(step+'.click()');await frame();
    assert.deepEqual(await run('window.sent'),[],'lifting the finger after a hold does not send the suggestion');
    assert.equal(await run('!!document.querySelector(".reply-next-steps-tip")'),false,'lifting the finger hides the preview');
    await touch('pointerenter');await touch('pointerdown');await sleep(80);await touch('pointerup');await run(step+'.click()');await frame();
    assert.deepEqual(await run('window.sent'),[{step:{label:'Check edge cases',prompt:'Check edge cases.'},by:'jigga'}],'a quick tap sends');
    assert.equal(await run('!!document.querySelector(".reply-next-steps-tip")'),false,'a tap never leaves a preview behind');
  `,{width:390,height:650,plugins:[fixture]});
});

test('phone suggestions follow the offering reply, and only a question waits above the composer', () => {
  const src = fs.readFileSync('src/phone/PhoneApp.tsx', 'utf8');
  assert.match(src, /props\.steps\.offer\.by === message\.speaker\.id && newestReply\.get\(message\.speaker\.id\) === message\.seq &&\s*<ReplyNextSteps/);
  assert.match(src, /<QuestionForm phone view=\{questionOnly\(formView\(openRoom\?\.asks\)\)\}/);
  assert.doesNotMatch(src, /<QuestionForm phone view=\{formView\(/);
});
