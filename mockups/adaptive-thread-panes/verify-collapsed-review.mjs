import { chromium } from '../../node_modules/playwright/index.mjs';
import fs from 'node:fs';
import assert from 'node:assert/strict';
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
let checks=0;const check=(v,m)=>{assert.ok(v,m);checks++;};
try { for(const viewport of [{width:1512,height:945},{width:1100,height:650}]) {
  const page=await browser.newPage({viewport});
  await page.setContent(fs.readFileSync(new URL('../adaptive-thread-panes.html',import.meta.url),'utf8'));
  await page.evaluate(()=>window._testMulti.toggle('pane-mv5vv0fh-0'));
  const rich=page.locator('.mk-rich-input');
  await rich.fill('⟦thread:pane-mw7h99uz-0⟧ @null hello\n⟦thread:pane-mv5vv0fh-0⟧ /compact');
  check(await page.locator('.mk-to-count').getAttribute('aria-expanded')==='false','valid slices stay collapsed');
  check((await page.locator('.mk-to-count').innerText()).includes('1 command'),'summary counts commands');
  await page.locator('.mk-to-count').click();
  check(!(await page.locator('.mk-multi-list').innerText()).includes('hello'),'expanded rows omit repeated prose');
  check((await page.locator('.mk-multi-list').innerText()).includes('/compact'),'expanded row identifies command');
  await page.screenshot({path:`/tmp/null-compact-review-${viewport.width}.png`});
  await page.waitForTimeout(600);
  await page.locator('#mk-shared .composer-plus').evaluate(el=>el.scrollIntoView({block:'nearest'}));
  check(await page.locator('#mk-shared .composer-plus').evaluate(el=>{const r=el.getBoundingClientRect(),p=el.parentElement.getBoundingClientRect();return r.height>=24&&r.bottom<=p.bottom+1;}),'attachment button fits scroll region');
  await page.locator('.mk-to-count').click();
  await page.locator('.round-send').click();
  check((await page.evaluate(()=>window._testMulti.state().sent)).length===2,'one click delivers both slices');
  await page.close();
} console.log(`${checks}/${checks} PASS`); } finally { await browser.close(); }
