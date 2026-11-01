import test from 'node:test';
import { BUILTIN_SKINS } from '../src/themes.ts';
import { STUDIO_HELPERS, onSkin, withAppearanceApp } from './helpers/appearance-app.mjs';

const SHELL = `[...document.querySelectorAll('.settings-nav, .studio-editor, .studio-status')].map(el => {
  const s = getComputedStyle(el), r = el.getBoundingClientRect();
  return [el.className, r.x, r.y, r.width, r.height, s.backgroundColor, s.borderRadius, s.backdropFilter].join();
}).join('|')`;
const PREVIEW = `document.querySelector('.studio-preview iframe').contentDocument.documentElement`;

test('the page does not wear the theme; the preview does', { timeout: 200000 }, async () => {
  const skins = { classic: 'classic', clay: 'clay', 'clay-black': 'clay', liquid: 'glass' };
  await withAppearanceApp('appearance-neutral', `
    const skins=${JSON.stringify(Object.fromEntries(Object.keys(skins).map((id) => [id, onSkin(id, BUILTIN_SKINS)])))};
    const expected=${JSON.stringify(skins)};
    let classic;
    for(const id of ['classic','clay','clay-black','liquid']){
      await seed(skins[id]);
      await openAppearance();
      await until(${JSON.stringify(PREVIEW)}+".dataset.deckTheme==="+JSON.stringify(expected[id]),'preview on '+id);
      await frame();
      const shell=await run(${JSON.stringify(SHELL)});
      assert.ok(shell.includes('studio-editor'),'the editor is on the page');
      classic ??= shell;
      assert.equal(shell,classic,'the shell is the same on '+id);
      await shot('t4-'+id);
      assert.equal(await run(${JSON.stringify(PREVIEW)}+".dataset.deckPalette||''"), id==='clay-black'?'black':'', 'palette in the preview on '+id);
    }
    // Sending a message moves the iframe and leaves the parent alone.
    const before=await run("JSON.stringify(document.documentElement.dataset)");
    await run("document.querySelector('.studio-preview iframe').contentWindow.postMessage({type:'appearance-preview',values:"+JSON.stringify(skins.clay.appearance.current.appearance)+",botChips:{tool:true,effort:true,usage:true}},location.origin)");
    await frame();
    assert.equal(await run(${JSON.stringify(PREVIEW)}+".dataset.deckTheme"),'clay','the frame follows the message');
    assert.equal(await run("getComputedStyle("+${JSON.stringify(PREVIEW)}+").getPropertyValue('--deck-bg').trim()"),'#262421','tokens follow within a frame');
    assert.equal(await run("JSON.stringify(document.documentElement.dataset)"),before,'the parent keeps its theme');
  `);
});

const yours = (name, change) => ({ format: 'apex-glass-playground', version: 2, name, appearance: { ...BUILTIN_SKINS.find((s) => s.id === 'tide').appearance, ...change } });
const SPOTS = `['accent','reply','density','corners'].map(k=>{const r=document.querySelector('[data-ctl='+k+']').getBoundingClientRect(); return [k,Math.round(r.x),Math.round(r.y),r.bottom<=innerHeight].join();}).join('|')`;

test('shared controls stay put, and editing moves nothing', { timeout: 200000 }, async () => {
  await withAppearanceApp('appearance-spots', `${STUDIO_HELPERS}
    await seed(${JSON.stringify(onSkin('clay', BUILTIN_SKINS))});
    await openAppearance();
    const clay=await run(${JSON.stringify(SPOTS)});
    assert.ok(!clay.includes('false'),'all four are visible without scrolling: '+clay);
    await pickTheme('classic'); assert.equal(await run(${JSON.stringify(SPOTS)}),clay,'Classic');
    await pickTheme('liquid'); assert.equal(await run(${JSON.stringify(SPOTS)}),clay,'Liquid');
    const layout="[...document.querySelectorAll('.studio-editor *')].filter(e=>e.offsetParent&&!e.closest('.studio-ctl-head')).slice(0,60).map(e=>{const r=e.getBoundingClientRect();return [Math.round(r.x),Math.round(r.y),Math.round(r.height)].join()}).join('|')";
    const before=await run(layout);
    await run("(()=>{const r=document.querySelector('#studio-radius'); const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; set.call(r,'27'); r.dispatchEvent(new Event('input',{bubbles:true}));})()");
    await frame();
    assert.equal(await run(layout),before,'a slider moves nothing');
    await run("document.querySelector('input[name=studio-mode][value=light]').click()"); await frame();
    await pickTheme('clay');
    await run("document.querySelector('input[name=studio-preset][value=\\"builtin:clay-black\\"]').focus()");
    assert.equal(await run("document.querySelector('[data-preset=\\"builtin:clay-black\\"] .studio-thumb').dataset.palette"),'black');
    assert.equal(await run("document.querySelector('[data-preset=\\"builtin:clay-black\\"] .studio-thumb').dataset.light"),'true','thumbnails follow the draft Mode');
    await shot('t5-clay');
  `);
});

test('all 8 Liquid presets are reachable at every width', { timeout: 300000 }, async () => {
  const settings = onSkin('liquid', BUILTIN_SKINS);
  settings.appearance.saved = [yours('BW', { hue: 10 }), yours('Colour', { hue: 130 })];
  await withAppearanceApp('appearance-presets', `${STUDIO_HELPERS}
    await seed(${JSON.stringify(settings)});
    await openAppearance();
    const state="(()=>{const s=document.querySelector('.studio-preset-strip'),b=s.getBoundingClientRect(),a=document.activeElement.closest('label');const r=a&&a.getBoundingClientRect();return {left:s.scrollLeft,count:document.querySelector('.studio-preset-count').textContent,value:document.activeElement.value,clear:r?r.left>=b.left-1&&r.right<=b.right+1:null,overflow:document.documentElement.scrollWidth-innerWidth}})()";
    for(const width of [1164,1040,820,600,480,390,320]){
      await size(width,655);
      await run("document.querySelector('.studio-preset-strip').scrollLeft=0"); await sleep(60);
      const seen=new Set();
      const shown="[...document.querySelectorAll('.studio-preset-strip label')].filter(c=>{const s=document.querySelector('.studio-preset-strip').getBoundingClientRect(),r=c.getBoundingClientRect();return r.left>=s.left-1&&r.right<=s.right+1}).map(c=>c.dataset.preset)";
      for(let i=0;i<12;i++){ for(const p of await run(shown)) seen.add(p); if(await run("document.querySelector('.studio-preset-next').getAttribute('aria-disabled')==='true'")) break; await run("document.querySelector('.studio-preset-next').click()"); await sleep(420); }
      assert.equal(seen.size,8,'Next reaches all 8 at '+width+': '+[...seen]);
      await run("document.activeElement.blur()");
      await run("document.querySelector('input[name=studio-preset][value=\\"builtin:liquid\\"]').click()"); await sleep(60);
      await run("document.querySelector('input[name=studio-preset][value=\\"builtin:liquid\\"]').focus()");
      const walked=new Set();
      for(let i=0;i<8;i++){
        const s=await run(state);
        walked.add(s.value);
        assert.equal(s.clear,true,'focus is not under the fade at '+width+': '+JSON.stringify(s));
        assert.equal(s.overflow,0,'no sideways scroll at '+width);
        assert.match(s.count,/of 8 · 2 yours|8 presets · 2 yours/);
        win.webContents.sendInputEvent({type:'keyDown',keyCode:'Right'}); win.webContents.sendInputEvent({type:'keyUp',keyCode:'Right'});
        await sleep(90);
      }
      assert.equal(walked.size,8,'ArrowRight reaches all 8 at '+width+': '+[...walked]);
      if(width<=820){
        const small=await run("[...document.querySelectorAll('.studio-next,.studio-prev,.studio-nav-arrow,.studio-tabs button,.studio-actions button')].filter(b=>b.offsetParent).map(b=>b.getBoundingClientRect().height).filter(h=>h<40)");
        assert.deepEqual(small,[],'tap targets at '+width);
      }
      await run("document.querySelector('input[name=studio-preset][value=\\"builtin:liquid\\"]').click()"); await sleep(40);
    }
  `, { timeoutMs: 280000, width: 1164, height: 655 });
});
