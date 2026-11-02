import test from 'node:test';
import { BUILTIN_SKINS } from '../src/themes.ts';
import { STUDIO_HELPERS, onSkin, withAppearanceApp } from './helpers/appearance-app.mjs';

const FLOW = `${STUDIO_HELPERS}
  const inDeck=()=>run("document.querySelector('.studio-deck-line').innerText.replace(/\\\\s+/g,' ').trim()");
  const preview=()=>run("document.querySelector('.studio-preview-line').innerText.replace(/\\\\s+/g,' ').trim()");
  const setRange=async(id,v)=>{ await run("(()=>{const r=document.querySelector('"+id+"'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(r,'"+v+"'); r.dispatchEvent(new Event('input',{bubbles:true}));})()"); await frame(); };
  const click=async(sel)=>{ await run("document.querySelector("+JSON.stringify(sel)+").click()"); await frame(); };
  const byText=async(text,scope='.studio')=>{ await run("[...document.querySelectorAll("+JSON.stringify(scope+' button')+")].find(b=>b.textContent.trim()==="+JSON.stringify(text)+").click()"); await frame(); await sleep(60); };
  const undo=async()=>{ await run("[...document.querySelectorAll('.toast button')].find(b=>/undo/i.test(b.textContent)).click()"); await frame(); await sleep(60); };
  const toastText=()=>run("[...document.querySelectorAll('.toast')].map(t=>t.textContent).join(' | ')");
  const parent="document.documentElement.dataset";
  const frameRoot="document.querySelector('.studio-preview iframe').contentDocument.documentElement.dataset";
  const typeName=async(v)=>{ await run("(()=>{const r=document.querySelector('#studio-save-name'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(r,"+JSON.stringify(v)+"); r.dispatchEvent(new Event('input',{bubbles:true}));})()"); await frame(); };
`;

test('Apply, Save and the reverts each do one thing', { timeout: 200000 }, async () => {
  await withAppearanceApp('appearance-apply', `${FLOW}
    await seed(${JSON.stringify(onSkin('clay', BUILTIN_SKINS))});
    await openAppearance();
    // 1. An edit changes the preview row only.
    const paintBefore=await run("document.documentElement.style.cssText+JSON.stringify("+parent+")");
    await setRange('#studio-radius',26);
    assert.equal(await inDeck(),'In Deck Clay Warm · Dark');
    assert.equal(await preview(),'Preview Clay Warm · Dark · Unsaved changes (1) · 1 not applied');
    assert.equal(await run("document.documentElement.style.cssText+JSON.stringify("+parent+")"),paintBefore,'Deck is not repainted');
    // 2. Mode previews, the page stays dark.
    await run("document.querySelector('input[name=studio-mode][value=light]').click()"); await sleep(80);
    assert.equal(await run(parent+".deckLight"),'false','the page keeps the applied Mode');
    await until(frameRoot+".deckLight==='true'",'the preview goes light');
    assert.equal(await preview(),'Preview Clay Warm · Light · Unsaved changes (1) · 2 not applied');
    // 3. The list and one row's Revert.
    await click('.studio-pending-btn');
    assert.deepEqual(await run("[...document.querySelectorAll('.studio-pending-list li span:first-child')].map(e=>e.textContent)"),['Mode','Theme and preset']);
    await click('.studio-pending-list li:first-child button');
    assert.deepEqual(await run("[...document.querySelectorAll('.studio-pending-list li span:first-child')].map(e=>e.textContent)"),['Theme and preset']);
    await run("document.querySelector('input[name=studio-mode][value=light]').click()"); await frame();
    await run("document.dispatchEvent(new MouseEvent('mousedown',{bubbles:true}))"); await frame();
    // 4. Save: a taken name is refused, a new one stores it and leaves Deck.
    await byText('Save as preset…');
    assert.equal(await run("document.activeElement.id"),'studio-save-name','focus goes to the name box');
    await typeName('Clay Warm');
    await click('#studio-save-confirm');
    assert.match(await run("document.querySelector('.studio-save-err').textContent"),/already exists/);
    await typeName('Mine');
    await click('#studio-save-confirm'); await sleep(80);
    assert.equal(await inDeck(),'In Deck Clay Warm · Dark','saving leaves Deck');
    assert.ok(await run("!!document.querySelector('[data-preset=\\"saved:Mine\\"] .studio-yours-tag')"),'the row shows it marked Yours');
    let s=await stored();
    assert.deepEqual(s.appearance.saved.map(p=>p.name),['Mine']);
    assert.equal(s.appearance.current.appearance.radius,10);
    // 5. Apply repaints and Undo restores applied and draft values.
    await setRange('#studio-radius',28);
    await byText('Apply to Deck');
    await until(parent+".deckLight==='true'",'the parent repaints');
    s=await stored();
    assert.equal(s.appearanceDraft,undefined,'the draft key is gone');
    assert.equal(s.appearance.current.appearance.radius,28);
    assert.match(await toastText(),/Deck now uses Mine with edits · Light\\. No preset was saved\\./);
    await undo();
    s=await stored();
    assert.equal(s.appearance.current.appearance.radius,10);
    assert.equal(s.appearanceDraft.values.radius,28);
    assert.equal(await run(parent+".deckLight"),'false');
    // 6. Clear edits leaves Mode; Discard restores all; both Undo.
    await click('.studio-clear-edits'); await sleep(60);
    s=await stored();
    assert.equal(s.appearanceDraft.values.radius,26,'back to the preset');
    assert.equal(s.appearanceDraft.colorMode,'light');
    await undo();
    assert.equal((await stored()).appearanceDraft.values.radius,28);
    await byText('Discard draft');
    s=await stored();
    assert.equal(s.appearanceDraft,undefined);
    assert.deepEqual(s.appearance.saved.map(p=>p.name),['Mine']);
    assert.match(await toastText(),/Saved presets are kept/);
    await undo();
    assert.equal((await stored()).appearanceDraft.values.radius,28);
    await byText('Discard draft');
    // 7. Updating the preset Deck uses leaves it on the earlier version until Apply.
    await run("document.querySelector('input[name=studio-preset][value=\\"saved:Mine\\"]').click()"); await frame();
    await byText('Apply to Deck');
    await setRange('#studio-radius',22);
    await byText('Update Mine');
    assert.match(await inDeck(),/Mine \\(earlier version\\)/);
    await byText('Apply to Deck');
    assert.ok(!/earlier version/.test(await inDeck()));
    // 8. A failed save shows the existing error, and the next change saves.
    await run("window.__real=Storage.prototype.setItem; Storage.prototype.setItem=function(k,v){ if(k==='apex-deck.demo.settings.v1'){ Storage.prototype.setItem=window.__real; throw new Error('disk full'); } return window.__real.call(this,k,v); }; 0");
    await setRange('#studio-radius',24);
    await byText('Apply to Deck');
    await sleep(120);
    assert.match(await run("document.body.innerText"),/Could not save settings/);
    assert.match(await inDeck(),/with edits|Mine/,'the state stays in memory');
    await setRange('#studio-radius',25);
    await sleep(120);
    assert.equal((await stored()).appearanceDraft.values.radius,25,'the next change saves');
  `, { timeoutMs: 70000 });
});

test('System follows the OS without creating a pending change', { timeout: 200000 }, async () => {
  const settings = onSkin('clay', BUILTIN_SKINS);
  settings.appearance.colorMode = 'system';
  await withAppearanceApp('appearance-system', `${FLOW}
    const dbg=win.webContents.debugger; dbg.attach('1.3');
    const scheme=v=>dbg.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:v}]});
    await scheme('dark');
    await seed(${JSON.stringify(settings)});
    await openAppearance();
    await setRange('#studio-radius',26);
    assert.equal(await inDeck(),'In Deck Clay Warm · System (Dark)');
    assert.match(await preview(),/System \\(Dark\\).*1 not applied/);
    await until(frameRoot+".deckLight==='false'");
    await scheme('light'); await sleep(150);
    await until(frameRoot+".deckLight==='true'",'the preview follows');
    assert.equal(await inDeck(),'In Deck Clay Warm · System (Light)');
    assert.match(await preview(),/System \\(Light\\).*1 not applied/);
  `);
});
