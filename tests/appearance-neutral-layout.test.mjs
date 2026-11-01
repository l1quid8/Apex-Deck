import test from 'node:test';
import { BUILTIN_SKINS } from '../src/themes.ts';
import { onSkin, withAppearanceApp } from './helpers/appearance-app.mjs';

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
