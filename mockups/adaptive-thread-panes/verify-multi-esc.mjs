// Escape precedence with stable # tags and the rich composer.
import {chromium} from '../../node_modules/playwright/index.mjs';
import fs from 'node:fs';
import assert from 'node:assert/strict';
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
let checks=0;const check=(v,m)=>{assert.ok(v,m);checks++;};
try {
 const page=await browser.newPage({viewport:{width:1512,height:945}});
 await page.setContent(fs.readFileSync(new URL('../adaptive-thread-panes.html',import.meta.url),'utf8'));
 await page.evaluate(()=>{const selected=window._testMulti.state().selected;window._testMulti.toggle(selected==='pane-mv5vv0fh-0'?'pane-mw7h99uz-0':'pane-mv5vv0fh-0');});
 const ids=await page.evaluate(()=>window._testMulti.state().multi);
 check(ids.length===2,'two stable selected destinations');
 const text=ids.map(id=>`⟦thread:${id}⟧ status`).join('\n');const rich=page.locator('.mk-rich-input');
 await rich.fill(text+' @');check(await page.locator('.mk-at-picker').isVisible(),'@ opens agent picker');
 await rich.press('Escape');check(await page.locator('.mk-at-picker').count()===0,'Escape closes picker');
 check((await page.evaluate(()=>window._testMulti.state().multi)).length===2,'picker Escape preserves selection');
 await rich.fill(text);await page.locator('.mk-to-count').click();
 await page.locator('.mk-mr-agent-btn').first().click();check(await page.locator('.mk-agent-menu').isVisible(),'agent menu opens');
 await page.keyboard.press('Escape');check(await page.locator('.mk-agent-menu').count()===0,'Escape closes agent menu');
 check((await page.evaluate(()=>window._testMulti.state().multi)).length===2,'menu Escape preserves selection');
 await page.keyboard.press('Escape');check((await page.evaluate(()=>window._testMulti.state().multi)).length===0,'next Escape exits multi selection');
 check((await page.evaluate(()=>window._testMulti.state().draft))===text,'Escape preserves tagged draft');
 console.log(`${checks}/${checks} PASS`);
}finally{await browser.close();}
