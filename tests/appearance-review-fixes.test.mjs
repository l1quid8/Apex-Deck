import test from 'node:test';
import { BUILTIN_SKINS } from '../src/themes.ts';
import { STUDIO_HELPERS, onSkin, withAppearanceApp } from './helpers/appearance-app.mjs';

const HELPERS = `${STUDIO_HELPERS}
  const setInput=(selector,value)=>run("(()=>{const r=document.querySelector("+JSON.stringify(selector)+"); const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; set.call(r,"+JSON.stringify(value)+"); r.dispatchEvent(new Event('input',{bubbles:true}));})()");
  const search=async(value)=>{ await setInput('.settings input[type=search], .settings .settings-search input',value); await frame(); };
  const clickResult=async(label)=>{ await until("[...document.querySelectorAll('.search-result')].some(b=>b.textContent.includes("+JSON.stringify(label)+"))",'the result '+label); await run("[...document.querySelectorAll('.search-result')].find(b=>b.textContent.includes("+JSON.stringify(label)+")).click()"); await frame(); await frame(); };
  const selectedTab=()=>run("document.querySelector('.studio-tabs [aria-selected=true]').dataset.tab");
`;

test('the hex box takes a six-digit color typed one key at a time', { timeout: 200000 }, async () => {
  await withAppearanceApp('appearance-hex', `${HELPERS}
    await seed(${JSON.stringify(onSkin('clay', BUILTIN_SKINS))});
    await openAppearance();
    await run("document.querySelector('input[name=studio-accent][value=exact]').click()");
    await frame();
    await setInput('.studio-hex','');
    await frame();
    for(const key of '#35aabb'){
      const now=await run("document.querySelector('.studio-hex').value");
      if(now.length<7) await setInput('.studio-hex',now+key);
      await frame();
    }
    assert.equal(await run("document.querySelector('.studio-hex').value"),'#35aabb');
    await until("JSON.parse(localStorage.getItem('apex-deck.demo.settings.v1')).appearanceDraft?.values.accentColor==='#35aabb'",'the typed color in the draft');
    await setInput('.studio-hex','#abc');
    await frame();
    await run("document.querySelector('.studio-hex').dispatchEvent(new FocusEvent('focusout',{bubbles:true}))");
    await frame();
    assert.equal(await run("document.querySelector('.studio-hex').value"),'#aabbcc','three digits expand when you leave the box');
  `);
});

test('Resume opens the editor even with text in Settings search', { timeout: 200000 }, async () => {
  const start = onSkin('clay', BUILTIN_SKINS);
  const draft = { version: 1, colorMode: 'light', source: { kind: 'builtin', id: 'clay' }, values: start.appearance.current.appearance, botChips: { tool: true, effort: true, usage: true }, landingTexture: undefined, lastPreset: {}, materialEdits: {} };
  await withAppearanceApp('appearance-resume-search', `${HELPERS}
    await seed(${JSON.stringify({ ...start, appearanceDraft: draft })});
    await openAppearance();
    await run("[...document.querySelectorAll('.settings-nav button')].find(b=>b.textContent.includes('General')).click()");
    await until("!!document.querySelector('.appearance-draft-bar')",'the draft bar');
    await search('scrollback');
    await run("[...document.querySelectorAll('.appearance-draft-bar button')].find(b=>b.textContent==='Resume').click()");
    await until("!!document.querySelector('.studio-editor')",'the editor after Resume');
  `);
});

test('Esc inside the preview reaches Settings', { timeout: 200000 }, async () => {
  await withAppearanceApp('appearance-preview-esc', `${HELPERS}
    await seed(${JSON.stringify(onSkin('clay', BUILTIN_SKINS))});
    await openAppearance();
    await run("(()=>{const f=document.querySelector('.studio-preview iframe'); const w=f.contentWindow; w.document.querySelector('.appearance-preview-page').dispatchEvent(new w.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));})()");
    await until("!document.querySelector('.settings')",'Settings to close');
  `);
});

test('a search result fires once and does not return when the Studio reopens', { timeout: 200000 }, async () => {
  await withAppearanceApp('appearance-stale-search', `${HELPERS}
    await seed(${JSON.stringify(onSkin('tide', BUILTIN_SKINS))});
    await openAppearance();
    await search('frost');
    await clickResult('Frost');
    assert.equal(await selectedTab(),'material');
    await tab('customize');
    await search('frost');
    await search('');
    await until("!!document.querySelector('.studio-editor')",'the Studio again');
    await frame();
    await frame();
    assert.equal(await selectedTab(),'customize','the old result must not fire again');
  `);
});

test('a glow search result opens its closed section', { timeout: 200000 }, async () => {
  await withAppearanceApp('appearance-glow-search', `${HELPERS}
    await seed(${JSON.stringify(onSkin('tide', BUILTIN_SKINS))});
    await openAppearance();
    await search('match accent');
    await clickResult('Match');
    await until("document.querySelector('.studio-more-glow')?.open",'the glow section to open');
    assert.ok(await run("document.activeElement.getBoundingClientRect().width>0"),'focus lands on a visible control');
  `);
});

test('turning Match accent back on keeps the number of glows', { timeout: 200000 }, async () => {
  await withAppearanceApp('appearance-match-accent', `${HELPERS}
    await seed(${JSON.stringify(onSkin('tide', BUILTIN_SKINS))});
    await openAppearance();
    await tab('material');
    await run("document.querySelector('.studio-more-glow').open=true");
    const before=await run("Number(document.querySelector('.studio-stepper output').textContent)");
    await run("document.querySelector('#studio-match-accent').click()");
    await frame();
    await run("document.querySelector('[aria-label=\\"More glows\\"]').click()");
    await frame();
    await run("document.querySelector('[aria-label=\\"More glows\\"]').click()");
    await frame();
    await run("document.querySelector('#studio-match-accent').click()");
    await frame();
    assert.equal(await run("Number(document.querySelector('.studio-stepper output').textContent)"),before+2);
  `);
});
