import { chromium } from '../../node_modules/playwright/index.mjs';
import fs from 'node:fs';
import assert from 'node:assert/strict';
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
let checks=0;
const check=(v,m)=>{assert.ok(v,m);checks++;};
try {
 for(const viewport of [{width:1512,height:945},{width:1100,height:650}]) {
  const page=await browser.newPage({viewport});const errors=[];page.on('pageerror',e=>errors.push(String(e)));
  await page.setContent(fs.readFileSync(new URL('../adaptive-thread-panes.html',import.meta.url),'utf8'));
  const ids=await page.evaluate(()=>{const a=window._testMulti.state().selected;window._testMulti.toggle('pane-mv5vv0fh-0');return [a,'pane-mv5vv0fh-0'];});
  check(await page.locator('.mk-thread-tag').count()===2,'pane selection inserts both chips');
  const token=id=>`⟦thread:${id}⟧`;const [a,b]=ids.map(token);
  const set=async text=>{await page.locator('.mk-rich-input').fill(text);return page.evaluate(()=>window._testMulti.plan());};
  for(const text of [`${a} ${b} status`,`status ${a} ${b}`]) {
   const p=await set(text);check(p.plans.length===2&&p.plans.every(x=>x.outgoing==='status'),'group before or after broadcasts exactly');
  }
  for(const text of [`${a} status ${b} build`,`status ${a} build ${b}`]) {
   const p=await set(text);check(p.plans[0].outgoing==='status'&&p.plans[1].outgoing==='build','directional slices route exactly');
  }
  await set(`please ${a} status ${b} now`);check(await page.locator('.round-send').isDisabled(),'ambiguous line blocked');
  await page.locator('.mk-rich-input').press('Enter');
  check((await page.evaluate(()=>window._testMulti.state())).sent.length===0,'keyboard Send cannot bypass ambiguity block');
  await set(`${a} status\nuntagged`);check(await page.locator('.round-send').isDisabled(),'untagged line blocked');
  let p=await set(`${a} ${b} context\n${a} @null status\n/compact ${b}`);
  check(p.plans.find(x=>x.id===ids[0]).outgoing==='context\n\n@null status','repeated destination combines lines once');
  check(p.plans.find(x=>x.id===ids[1]).outgoing==='/compact','command excludes group context');
  await set(`${a} /compact\n${a} individual instruction`);
  check(await page.locator('.round-send').isDisabled(),'command plus individual prose cannot silently discard prose');
  await set(`${a} ${b} shared`);
  const editor=page.locator('.mk-rich-input');await editor.press('Meta+a');await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Shift+Enter');await page.keyboard.type('#Multiple thread');
  const repeat=page.locator(`.mk-at-picker button[data-thread-id="${ids[0]}"]`);
  check(await repeat.isEnabled(),'same destination can be picked on a fresh line');await repeat.click();await page.keyboard.type('@null status');
  p=await page.evaluate(()=>window._testMulti.plan());
  check(p.plans.find(x=>x.id===ids[0]).outgoing==='shared\n\n@null status','real Shift+Enter and picker preserve line boundaries');
  await set(`${a} ${a} status`);check(await page.locator('.mk-thread-tag.mk-bad').count()===2,'same-line duplicates highlighted');
  await set(`${a} status\n${b} build`);
  await page.evaluate(id=>window._testMulti.toggle(id),ids[1]);
  check(!(await page.locator('#mk-input').inputValue()).includes('build'),'deselect removes owned text');
  await page.getByRole('button',{name:'Undo removal'}).click();
  check((await page.locator('#mk-input').inputValue()).includes('build'),'Undo restores removed payload');
  await page.locator('.mk-rich-input').fill(`${a} status`);
  check(!(await page.evaluate(()=>window._testMulti.state())).multi.includes(ids[1]),'deleting chip deselects pane');
  await page.locator('.mk-rich-input').fill(`${a} ${b} Check the latest build\n${a} @null what is the status\n${b} run the dev server`);
  if(await page.locator('.mk-to-count').getAttribute('aria-expanded')==='false')await page.locator('.mk-to-count').click();
  await page.screenshot({path:`/tmp/null-selection-tags-${viewport.width}.png`});
  check(errors.length===0,errors.join('\n'));await page.close();
 }
 console.log(`${checks}/${checks} PASS`);
}finally{await browser.close();}
