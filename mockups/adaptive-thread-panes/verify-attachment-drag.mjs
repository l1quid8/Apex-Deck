import { chromium } from '../../node_modules/playwright/index.mjs';
import fs from 'node:fs';
import assert from 'node:assert/strict';
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
let checks=0;const check=(value,message)=>{assert.ok(value,message);checks++;};
try { for(const viewport of [{width:1512,height:945},{width:1100,height:650}]) {
 const page=await browser.newPage({viewport});const errors=[];page.on('pageerror',e=>errors.push(String(e)));
 await page.setContent(fs.readFileSync(new URL('../adaptive-thread-panes.html',import.meta.url),'utf8'));
 const ids=await page.evaluate(()=>{const id=window._testMulti.state().selected;return [id,[...document.querySelectorAll('[data-pane-row]')].map(e=>e.dataset.paneRow).find(x=>x!==id)];});
 await page.locator(`[data-pane-row="${ids[1]}"]`).click({modifiers:['Meta']});
 const rich=page.locator('.mk-rich-input');const token=id=>`⟦thread:${id}⟧`;
 await rich.fill(`${token(ids[0])} alpha beta gamma\n${token(ids[1])} inspect`);
 await rich.press('Meta+a');await rich.press('ArrowRight');
 for(let i=0;i<3;i++)await page.locator('#mk-shared .composer-plus').click();
 check(await page.locator('.mk-to-count').getAttribute('aria-expanded')==='false','review remains collapsed');
 check(await page.locator('.mk-att-stack').isVisible(),'stack visible with collapsed review');
 check(await page.locator('.mk-att-thumb').count()===3,'three overlapping previews');
 check(await page.locator('#mk-shared .composer-box .mk-att-stack').count()===1,'stack lives inside composer');
 check(await page.locator('.mk-to .mk-att-panel, .mk-add-att').count()===0,'no extra attachment row above composer');
 check(await page.locator('.mk-att-stack').evaluate(el=>{const s=el.getBoundingClientRect(),b=el.closest('.composer-box').getBoundingClientRect(),r=document.querySelector('.mk-rich-input').getBoundingClientRect();return s.right<=b.right&&s.left>=b.left&&s.bottom<=b.bottom&&s.top>=r.bottom&&s.left>b.left+b.width/2;}),'compact stack sits at lower right clear of text');
 await page.locator('.mk-att-stack').click();
 check(await page.locator('.mk-att-preview').count()===3,'stack opens file previews');
 check(await page.locator('.mk-att-insert').first().isVisible(),'stack opens placement controls independently');
 await page.locator('.mk-att-stack').click();
 const file='⟦file:att-1⟧';
 await rich.fill(`${token(ids[0])} alpha beta gamma\n${token(ids[1])} inspect ${file}`);
 await page.evaluate(()=>{const chip=document.querySelector('.mk-attachment-tag');const range=document.createRange();range.setStartBefore(chip);range.collapse(true);const sel=getSelection();sel.removeAllRanges();sel.addRange(range);chip.parentElement.focus();});
 await page.keyboard.type('edited ');
 async function target(word) {return page.evaluate(word=>{const root=document.querySelector('.mk-rich-input');for(const n of root.childNodes){if(n.nodeType!==3)continue;const at=n.textContent.indexOf(word);if(at<0)continue;const range=document.createRange();range.setStart(n,at);range.setEnd(n,at+1);const b=range.getBoundingClientRect();return {x:b.left+1,y:b.top+b.height/2};}throw Error('word not found');},word);}
 async function drag(source,point) {const b=await source.boundingBox();await page.mouse.move(b.x+b.width/2,b.y+b.height/2);await page.mouse.down();await page.mouse.move(b.x+b.width/2+8,b.y+b.height/2,{steps:5});await page.mouse.move(point.x,point.y,{steps:20});await page.mouse.move(point.x+0.5,point.y);await page.mouse.up();}
 await drag(page.locator('.mk-attachment-tag'),await target('beta'));
 let draft=await page.locator('#mk-input').inputValue();
 check(draft.includes(`alpha ${file}beta gamma`),'native drag moves chip between words');
 check(draft.split(file).length===2,'moving chip does not duplicate reference');
 check((await page.evaluate(()=>window._testMulti.plan())).plans[0].outgoing.includes('[Image1: file-1.png]'),'drag changes destination to target slice');
 await page.locator('.mk-att-stack').click();
 await drag(page.locator('.mk-att-insert').first(),await target('inspect'));
 draft=await page.locator('#mk-input').inputValue();
 check(draft.split(file).length===3,'drag from tray copies reference');
 check(draft.includes(`${token(ids[1])} ${file}inspect`),'tray drop inserts at exact word boundary');
 const layout=await page.evaluate(()=>{const t=document.querySelector('.mk-att-popover').getBoundingClientRect(),r=document.querySelector('.mk-rich-input').getBoundingClientRect();return t.bottom<=r.top||r.bottom<=t.top;});
 check(layout,'expanded previews never cover text');
 await page.screenshot({path:`/tmp/null-attachment-previews-${viewport.width}.png`});
 await page.locator('.mk-att-stack').click();
 await page.screenshot({path:`/tmp/null-attachment-stack-${viewport.width}.png`});
 check(errors.length===0,errors.join('\n'));await page.close();
 } console.log(`${checks}/${checks} PASS`);
} finally {await browser.close();}
