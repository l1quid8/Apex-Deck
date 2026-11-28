import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { withAppearanceApp } from './helpers/appearance-app.mjs';

test('desktop suggestions appear in the composer placeholder', () => {
  const src = fs.readFileSync('src/ChatPane.tsx', 'utf8');
  assert.match(src, /placeholder=\{[^\n]+suggestionHint\(form, text, Boolean\(offer\?\.decision\)\)/);
  assert.match(src, /<QuestionForm view=\{composerForm\}/);
  assert.match(src, /<ReplyNextSteps offer=\{inlineSteps\}/);
});

const fixture = { name: 'reply-steps-fixture', enforce: 'pre', transform(code, id) {
  if (!id.endsWith('/src/App.tsx')) return;
  return `import React from 'react';
    import { ReplyNextSteps } from './ReplyNextSteps';
    export function App(){
      const [offer]=React.useState({by:'jigga',pending:false,steps:[{label:'Review changes',prompt:'Review the changes.'},{label:'Legacy second suggestion',prompt:'Another prompt'}]});
      window.sent=window.sent||[];
      return <main className="rail" style={{display:'block',width:'100%',padding:20}}><article style={{width:'100%'}}><p>Sample response</p><ReplyNextSteps key={JSON.stringify(offer)} offer={offer} onStep={(step,by)=>window.sent.push({step,by})}/></article><textarea defaultValue="Keep this draft"/></main>;
    }`;
}};

test('the inline row shows multiple suggestions with no caption or toggle', {timeout:150000}, async () => {
  await withAppearanceApp('reply-next-steps-single', String.raw`
    await until('!!document.querySelector(".reply-next-step")');
    assert.equal(await run('document.querySelectorAll(".reply-next-step").length'),2);
    assert.equal(await run('document.querySelector(".reply-next-step").innerText'),'Review changes');
    assert.equal(await run('!!document.querySelector(".reply-next-steps-toggle,.reply-next-steps-label")'),false);
    await run('document.querySelector(".reply-next-step").dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true}))');
    assert.deepEqual(await run('window.sent'),[{step:{label:'Review changes',prompt:'Review the changes.'},by:'jigga'}]);
    assert.equal(await run('document.querySelector("textarea").value'),'Keep this draft');
  `,{width:390,height:650,plugins:[fixture]});
});

test('hovering or focusing a suggestion previews the prompt it sends', {timeout:150000}, async () => {
  await withAppearanceApp('reply-next-steps-preview', String.raw`
    await until('!!document.querySelector(".reply-next-step")');
    const at=await run('(()=>{const b=document.querySelector(".reply-next-step").getBoundingClientRect();return {x:Math.round(b.left+6),y:Math.round(b.top+b.height/2)}})()');
    win.webContents.sendInputEvent({type:'mouseMove',x:at.x,y:at.y});
    await until('!!document.querySelector(".reply-next-steps-tip")','the hover preview');
    const tip=await run('(()=>{const t=document.querySelector(".reply-next-steps-tip"),b=document.querySelector(".reply-next-step").getBoundingClientRect();return {text:t.textContent,role:t.getAttribute("role"),above:t.getBoundingClientRect().bottom<=b.top+1}})()');
    assert.deepEqual(tip,{text:'Review the changes.',role:'tooltip',above:true},'the preview names the prompt and sits above the suggestion');
    assert.equal(await run('(()=>{const id=document.querySelector(".reply-next-step").getAttribute("aria-describedby");return id&&document.getElementById(id).textContent})()'),'Review the changes.','screen readers get the same description');
    win.webContents.sendInputEvent({type:'mouseMove',x:4,y:4});
    await until('!document.querySelector(".reply-next-steps-tip")','leaving hides the preview');
    assert.equal(await run('!!document.querySelector(".reply-next-steps-tip")'),false,'leaving hides the preview');
    await run('document.querySelector(".reply-next-step").focus()');
    // A hidden test window never fires focus itself; send what Chromium would.
    await run('document.querySelector(".reply-next-step").dispatchEvent(new FocusEvent("focusin",{bubbles:true}))');await frame();
    await until('!!document.querySelector(".reply-next-steps-tip")','focus shows the preview');
    assert.equal(await run('document.querySelector(".reply-next-steps-tip").textContent'),'Review the changes.');
    await run('document.querySelector(".reply-next-step").dispatchEvent(new FocusEvent("focusout",{bubbles:true}))');await frame();
    assert.equal(await run('!!document.querySelector(".reply-next-steps-tip")'),false,'blur hides the preview');
    await shot('reply-next-steps-preview');
  `,{width:900,height:650,plugins:[fixture]});
});

test('on a touch screen a hold previews the prompt and does not send it; a tap sends', {timeout:150000}, async () => {
  await withAppearanceApp('reply-next-steps-touch', String.raw`
    await until('!!document.querySelector(".reply-next-step")');
    const step='document.querySelector(".reply-next-step")';
    const touch=(type)=>run('(()=>{const el='+step+',b=el.getBoundingClientRect();el.dispatchEvent(new PointerEvent("'+type+'",{bubbles:'+(type!=='pointerenter')+',pointerType:"touch",isPrimary:true,pointerId:7,clientX:b.left+6,clientY:b.top+4}));})()');
    await touch('pointerenter');await touch('pointerdown');
    await sleep(150);
    assert.equal(await run('!!document.querySelector(".reply-next-steps-tip")'),false,'a touch does not preview straight away, so a tap stays a tap');
    await until('!!document.querySelector(".reply-next-steps-tip")','a hold previews the prompt');
    assert.equal(await run('document.querySelector(".reply-next-steps-tip").textContent'),'Review the changes.');
    await touch('pointerup');await run(step+'.click()');await frame();
    assert.deepEqual(await run('window.sent'),[],'lifting the finger after a hold does not send the suggestion');
    assert.equal(await run('!!document.querySelector(".reply-next-steps-tip")'),false,'lifting the finger hides the preview');
    await touch('pointerenter');await touch('pointerdown');await sleep(80);await touch('pointerup');await run(step+'.click()');await frame();
    assert.deepEqual(await run('window.sent'),[{step:{label:'Review changes',prompt:'Review the changes.'},by:'jigga'}],'a quick tap sends');
    assert.equal(await run('!!document.querySelector(".reply-next-steps-tip")'),false,'a tap never leaves a preview behind');
  `,{width:390,height:650,plugins:[fixture]});
});

test('phone suggestions follow the offering reply, and only a question waits above the composer', () => {
  const src = fs.readFileSync('src/phone/PhoneApp.tsx', 'utf8');
  assert.match(src, /props\.steps\.offer\.by === message\.speaker\.id && newestReply\.get\(message\.speaker\.id\) === message\.seq &&\s*<ReplyNextSteps/);
  assert.match(src, /<QuestionForm phone view=\{questionOnly\(formView\(openRoom\?\.asks\)\)\}/);
  assert.doesNotMatch(src, /<QuestionForm phone view=\{formView\(/);
});
