import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { BUILTIN_SKINS } from '../src/themes.ts';
import { STUDIO_HELPERS, onSkin, withAppearanceApp } from './helpers/appearance-app.mjs';

const app = fs.readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');

const LEAVE = `${STUDIO_HELPERS}
  const bar=()=>run("document.querySelector('.appearance-draft-bar')?.innerText.replace(/\\\\s+/g,' ').trim()??null");
  const setRange=async(id,v)=>{ await run("(()=>{const r=document.querySelector('"+id+"'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(r,'"+v+"'); r.dispatchEvent(new Event('input',{bubbles:true}));})()"); await frame(); };
  const press=async(key,shift)=>{ const m=shift?['shift']:[]; win.webContents.sendInputEvent({type:'keyDown',keyCode:key,modifiers:m}); win.webContents.sendInputEvent({type:'keyUp',keyCode:key,modifiers:m}); await sleep(40); };
  const nav=async(name)=>{ await run("[...document.querySelectorAll('.settings-nav .nav-item')].find(b=>b.textContent.includes("+JSON.stringify(name)+")).click()"); await frame(); };
  const close=async()=>{ await run("document.querySelector('[aria-label=\\"Close settings\\"]').click()"); await until("!document.querySelector('.settings')"); await frame(); };
  const draft3=async()=>{
    await openAppearance();
    await run("document.querySelector('input[name=studio-mode][value=light]').click()"); await frame();
    await setRange('#studio-radius',26);
    await tab('details');
    await run("document.querySelector('#studio-chip-effort').click()"); await frame();
    await sleep(80);
  };
  const barButton=(name)=>"[...document.querySelectorAll('.appearance-draft-bar button')].find(b=>b.textContent.trim()==="+JSON.stringify(name)+")";
  const undo=async()=>{ await run("[...document.querySelectorAll('.toast button')].find(b=>/undo/i.test(b.textContent)).click()"); await sleep(120); };
`;
const start = onSkin('clay', BUILTIN_SKINS);

test('leaving keeps the draft, and Resume, Apply and Discard each do their one job', { timeout: 200000 }, async () => {
  await withAppearanceApp('appearance-leave', `${LEAVE}
    await seed(${JSON.stringify(start)});
    await openAppearance();
    const quiet="[...document.querySelectorAll('.studio-editor, .studio-status')].map(e=>{const r=e.getBoundingClientRect();return [r.x,r.y,r.width,r.height].join()}).join('|')";
    const geometry=await run(quiet);
    await close();
    await draft3();
    assert.equal(await bar(),null,'no bar on Appearance');
    await nav('General');
    let words=await bar();
    assert.match(words,/^3 unapplied appearance changes/);
    assert.match(words,/Mode, Theme and preset, Agent chips\\./);
    assert.match(words,/Deck stays on Clay Warm · Dark until you apply\\./);
    assert.match(words,/Includes edits not saved as a preset\\./);
    assert.equal(await run("document.querySelector('.settings-nav .nav-item .appearance-draft-count')?.textContent"),'3','nav badge');
    await close();
    assert.ok(await bar(),'the bar stays when Settings closes');
    assert.equal(await run("document.querySelector('.rail .appearance-draft-count')?.textContent"),'3','Settings badge');
    assert.equal(await run("document.documentElement.dataset.deckLight"),'false','Deck paints applied values');
    await win.webContents.reload();
    await until("!!document.querySelector('.appearance-draft-bar')",'the draft after a restart');
    assert.match(await bar(),/^3 unapplied/);
    await run(${JSON.stringify("document.querySelector('.appearance-draft-bar button').click()")});
    await until("!!document.querySelector('.studio-editor')");
    await until("document.activeElement.classList.contains('studio-pending-btn')",'focus on the status row');
    assert.equal(await bar(),null,'the bar is gone on Appearance');
    assert.equal(await run(quiet),geometry,'the editor sits where it does with no draft');
    assert.equal((await stored()).appearanceDraft.values.radius,26,'the draft is unchanged');
    await close();
    await run(${JSON.stringify("[...document.querySelectorAll('.appearance-draft-bar button')].find(b=>b.textContent.trim()==='Apply').click()")});
    await until("document.documentElement.dataset.deckLight==='true'",'Deck repaints');
    assert.match(await run("[...document.querySelectorAll('.toast')].map(t=>t.textContent).join()"),/No preset was saved\\./);
    assert.equal(await bar(),null);
    await undo();
    assert.equal(await run("document.documentElement.dataset.deckLight"),'false','Undo works');
    assert.match(await bar(),/^3 unapplied/);
    await run(${JSON.stringify("[...document.querySelectorAll('.appearance-draft-bar button')].find(b=>b.textContent.trim()==='Discard').click()")});
    await sleep(100);
    assert.equal(await bar(),null);
    assert.equal((await stored()).appearanceDraft,undefined);
    assert.match(await run("[...document.querySelectorAll('.toast')].map(t=>t.textContent).join()"),/Saved presets are kept/);
    await undo();
    assert.match(await bar(),/^3 unapplied/);
  `, { timeoutMs: 90000 });
});

test('the keyboard reaches the bar and focus always lands somewhere', { timeout: 200000 }, async () => {
  await withAppearanceApp('appearance-leave-keys', `${LEAVE}
    await seed(${JSON.stringify(start)});
    await draft3();
    await close();
    const focused="(()=>{const a=document.activeElement;return a&&a!==document.body&&a.getBoundingClientRect().width>0?(a.textContent||a.tagName).trim().slice(0,20):null})()";
    await run(${JSON.stringify("document.querySelector('.appearance-draft-bar').querySelector('button').focus()")});
    assert.equal(await run(focused),'Resume');
    await press('Tab'); assert.equal(await run(focused),'Apply');
    await press('Tab'); assert.equal(await run(focused),'Discard');
    await press('Space');
    await until("!document.querySelector('.appearance-draft-bar') && "+focused,'visible focus after Discard');
    assert.ok(await run(focused),'after Discard focus is visible');
    await undo();
    await until(focused,'visible focus after Undo');
    assert.ok(await run(focused),'after Undo focus is visible');
    await run(${JSON.stringify("document.querySelectorAll('.appearance-draft-bar button')[1].focus()")});
    await press('Space');
    await until("!document.querySelector('.appearance-draft-bar') && "+focused,'visible focus after Apply');
    assert.ok(await run(focused),'after Apply focus is visible');
  `, { timeoutMs: 90000 });
});

test('the bar fits a phone width', { timeout: 200000 }, async () => {
  await withAppearanceApp('appearance-leave-narrow', `${LEAVE}
    await seed(${JSON.stringify(start)});
    await draft3();
    await close();
    for(const width of [390,320]){
      await size(width,700);
      assert.equal(await run("(()=>{const b=document.querySelector('.appearance-draft-bar');return b.scrollWidth-b.clientWidth})()"),0,'no sideways scroll at '+width);
      const heights=await run("[...document.querySelectorAll('.appearance-draft-bar button')].map(b=>b.getBoundingClientRect().height)");
      assert.ok(heights.every(h=>h>=44),'44px targets at '+width+': '+heights);
    }
  `);
});

test('pop-outs are fed applied values only', () => {
  assert.match(app, /const appearanceSettings = settings\.appearance;/);
  assert.match(app, /const patch: PopoutUpdate = \{ title: tabTitle\(tab\), appearance: appearanceSettings \?\? appearance \}/);
});
