import { chromium } from '../../node_modules/playwright/index.mjs';
import fs from 'node:fs';
import assert from 'node:assert/strict';
const browser = await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
let checks=0;
const check=(v,m)=>{assert.ok(v,m);checks++;};
try {
  for(const viewport of [{width:1512,height:945},{width:1100,height:650}]) {
    const page=await browser.newPage({viewport});const errors=[];page.on('pageerror',e=>errors.push(String(e)));
    await page.setContent(fs.readFileSync(new URL('../adaptive-thread-panes.html',import.meta.url),'utf8'));
    await page.evaluate(()=>window._testMulti.toggle('pane-mv5vv0fh-0'));
    const input=page.locator('#mk-input');
    await page.locator('.mk-to-count').click();
    const rich=page.locator('.mk-rich-input');await rich.fill((await input.inputValue())+' #');
    check(await page.locator('.mk-at-picker button').count()===2,'empty # lists only two selected destinations');
    check(await page.locator('.mk-multi-list').count()===0,'opening picker closes To list');
    check(!(await page.locator('.mk-at-picker').innerText()).includes('5vv0fh'),'internal IDs never appear');
    const row=page.locator('.mk-at-picker button').first();
    check(await row.evaluate(e=>getComputedStyle(e).display)==='flex','options use full menu row layout');
    check(await row.evaluate(e=>Math.abs(e.getBoundingClientRect().width-e.parentElement.clientWidth)<20),'options fill menu width');
    await rich.fill('#linux desktp');
    check((await page.locator('.mk-at-picker').textContent()).includes('Other threads · adds to selection'),'search explains selection changes');
    await page.locator('.mk-at-picker button').filter({hasText:'Linux Desktop App'}).click();
    await page.keyboard.type('hello #');
    const disabled=page.locator('.mk-at-picker button:disabled');
    check(await disabled.count()===1,'already tagged destination disabled');
    check((await disabled.innerText()).includes('tagged'),'disabled destination explains why');
    await page.keyboard.type('Multiple thread');
    await page.keyboard.press('ArrowDown');
    check(await page.evaluate(()=>document.activeElement.matches('.mk-at-picker button:not(:disabled)')),'keyboard skips disabled options');
    await page.screenshot({path:`/tmp/null-thread-picker-${viewport.width}.png`});
    assert.deepEqual(errors,[]);checks++;await page.close();
  }
  console.log(`${checks}/${checks} PASS`);
} finally {await browser.close();}
