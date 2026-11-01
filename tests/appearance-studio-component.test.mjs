import test from 'node:test';
import { BUILTIN_SKINS } from '../src/themes.ts';
import { STUDIO_HELPERS, onSkin, withAppearanceApp } from './helpers/appearance-app.mjs';

const mine = (name, id, change = {}) => ({ format: 'apex-glass-playground', version: 2, name, appearance: { ...BUILTIN_SKINS.find((s) => s.id === id).appearance, ...change } });

test('every theme shows only controls that do something', { timeout: 200000 }, async () => {
  await withAppearanceApp('appearance-studio', `${STUDIO_HELPERS}
    await seed(${JSON.stringify(onSkin('clay', BUILTIN_SKINS))});
    await openAppearance();
    assert.ok((await text()).includes('Cards and composer only. Columns stay flush.'),'Corners keeps its Clay scope note');
    await tab('material');
    assert.deepEqual(await labels(),['Panel edges'],'Clay Material has Panel edges and no glass control');
    assert.ok((await text()).includes('Frost, glow and backgrounds need glass'),'Clay says why');
    await pickTheme('liquid');
    const liquid=await labels();
    for(const l of ['Solid panels','Frost','Opacity','Glow','Backdrop']) assert.ok(liquid.includes(l),l+' in '+liquid);
    await tab('customize');
    assert.ok(!(await text()).includes('Columns stay flush'),'the Clay note leaves with Clay');
  `);
});

test('built-ins offer Save as preset, yours offer Update and Save as new', { timeout: 200000 }, async () => {
  const saved = mine('Mine', 'clay', { radius: 20 });
  await withAppearanceApp('appearance-studio-save', `${STUDIO_HELPERS}
    await seed(${JSON.stringify(onSkin('clay', BUILTIN_SKINS))});
    await openAppearance();
    let b=await buttons();
    assert.ok(b.includes('Save as preset…'),b);
    assert.ok(!b.some(x=>/^Update|^Delete/.test(x)),b);
    await seed(${JSON.stringify({ appearance: { current: saved, saved: [saved], colorMode: 'dark', source: { kind: 'saved', name: 'Mine' } } })});
    await openAppearance();
    await run("(()=>{const r=document.querySelector('#studio-radius'); const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; set.call(r,'26'); r.dispatchEvent(new Event('input',{bubbles:true}));})()");
    await frame();
    b=await buttons();
    assert.ok(b.includes('Update Mine'),b);
    assert.ok(b.includes('Save as new…'),b);
  `);
});

test('Chips & effects and Share follow the draft rules', { timeout: 200000 }, async () => {
  const tide = { format: 'apex-glass-playground', version: 2, name: 'Harbor', appearance: BUILTIN_SKINS.find((s) => s.id === 'tide').appearance };
  await withAppearanceApp('appearance-details', `${STUDIO_HELPERS}
    const start=${JSON.stringify({ ...onSkin('clay', BUILTIN_SKINS), botChips: { tool: true, effort: true, usage: true }, appearanceDraft: undefined })};
    await seed(start);
    await openAppearance();
    await tab('details');
    assert.ok((await text()).includes('Not part of a preset'),'the note is on the tab');
    await run("document.querySelector('#studio-chip-effort').click()"); await frame();
    await run("[...document.querySelectorAll('.chip-style-name')].find(b=>b.textContent.includes('Stamp')).click()"); await frame();
    await run("document.querySelector('#studio-field-on').click()"); await frame();
    await sleep(120);
    let s=await stored();
    assert.equal(s.appearanceDraft.botChips.effort,false,'chip edits go to the draft');
    assert.equal(s.appearanceDraft.botChips.style,'stamp');
    assert.equal(s.appearanceDraft.landingTexture.enabled,false,'field edits go to the draft');
    assert.equal(s.botChips.effort,true,'settings keep the applied chips');
    assert.equal(s.botChips.style,undefined);
    assert.equal(s.landingTexture,undefined);
    const frameDoc="document.querySelector('.studio-preview iframe').contentDocument";
    assert.equal(await run(frameDoc+".querySelector('.chips').dataset.chipStyle"),'stamp','the preview shows the chip style');
    await run("document.querySelector('input[name=studio-scene][value=empty]').click()"); await sleep(100);
    assert.ok(await run("!!"+frameDoc+".querySelector('.empty')"),'the empty-thread scene shows');

    await tab('share');
    const setText=(sel,value)=>run("(()=>{const t=document.querySelector("+JSON.stringify(sel)+");Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(t,"+JSON.stringify(value)+");t.dispatchEvent(new Event('input',{bubbles:true}));})()");
    const beforeDraft=JSON.stringify((await stored()).appearanceDraft), beforeCurrent=JSON.stringify((await stored()).appearance.current);
    await setText('#studio-import-text',${JSON.stringify(JSON.stringify(tide))});
    await run("document.querySelector('#studio-import').click()"); await frame(); await sleep(80);
    s=await stored();
    assert.deepEqual(s.appearance.saved.map(p=>p.name),['Harbor']);
    assert.equal(JSON.stringify(s.appearance.current),beforeCurrent,'Deck is unchanged');
    assert.equal(JSON.stringify(s.appearanceDraft),beforeDraft,'the draft is unchanged');
    assert.match(await run("document.querySelector('.studio-notice').textContent"),/Harbor/);
    await setText('#studio-import-text',${JSON.stringify(JSON.stringify(tide))});
    await run("document.querySelector('#studio-import').click()"); await frame(); await sleep(80);
    s=await stored();
    assert.deepEqual(s.appearance.saved.map(p=>p.name),['Harbor','Harbor 2'],'a taken name keeps both');
    const full=JSON.stringify(s);
    await setText('#studio-import-text','{"format":"apex-glass-playground","version":2,"name":"x","appearance":{"blur":90}}');
    await run("document.querySelector('#studio-import').click()"); await frame(); await sleep(80);
    assert.equal(await run("document.querySelector('.studio-notice[role=alert]')?.textContent.length>0"),true,'a bad file shows its parser error');
    assert.equal(JSON.stringify(await stored()),full,'and changes nothing');
    await run("document.querySelector('[data-ctl]');"); 
    await tab('customize');
    await run("(()=>{const r=document.querySelector('#studio-radius'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(r,'26'); r.dispatchEvent(new Event('input',{bubbles:true}));})()"); await frame();
    await tab('material');
    await run("document.querySelector('input[name=studio-edges][value=strong]').click()"); await frame();
    await tab('share');
    await run("document.querySelector('#studio-export').click()"); await frame();
    const json=await run("document.querySelector('#studio-export-text').value");
    const parsed=JSON.parse(json);
    assert.equal(parsed.appearance.radius,26,'export includes unsaved changes');
    assert.equal(parsed.appearance.edges,'strong','export includes new fields');
    assert.equal(parsed.version,2);
    assert.match(parsed.name,/Clay Warm \\(modified\\)/);
  `);
});
