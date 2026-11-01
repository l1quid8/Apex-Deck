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
