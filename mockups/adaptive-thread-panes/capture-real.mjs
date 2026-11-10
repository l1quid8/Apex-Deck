import { chromium } from '/Users/tylercaldwell/Downloads/apex-deck/node_modules/playwright/index.mjs';
import fs from 'node:fs';
const settings = fs.readFileSync('/tmp/jigga-atp/settings.json','utf8');
const b = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
const p = await b.newPage({ viewport: { width: 1512, height: 945 } });
await p.addInitScript((s)=>{ if(!sessionStorage.getItem('seeded')){ localStorage.setItem('apex-deck.demo.settings.v1', s); sessionStorage.setItem('seeded','1'); } }, settings);
await p.goto('http://localhost:5391/', { waitUntil: 'networkidle' }); await p.waitForTimeout(1200);
await p.getByText(/Try a sample thread/i).first().click(); await p.waitForTimeout(1500);
const ta = p.locator('textarea').first();
await ta.fill('@ada review the last commit'); await ta.press('Enter'); await p.waitForTimeout(6000);
await ta.fill('@ben what would you change first?'); await ta.press('Enter'); await p.waitForTimeout(6000);
await p.locator('button', { hasText: 'New' }).first().click(); await p.waitForTimeout(300); await p.getByText('Group chat').first().click(); await p.waitForTimeout(800);
await p.getByLabel('Show side panel').click(); await p.waitForTimeout(1200); await p.locator('[aria-label="Details"], [title="Details"]').first().click(); await p.waitForTimeout(800);
// click first pane so it is focused
await p.locator('.pane').first().click({ position: { x: 300, y: 10 } }).catch(()=>{}); await p.waitForTimeout(500);
const html = await p.evaluate(async () => {
  let css = '';
  for (const s of document.styleSheets) { try { css += [...s.cssRules].map(r => r.cssText).join('\n') + '\n'; } catch {} }
  const urls = [...new Set([...css.matchAll(/url\(\"?([^)\"]+)\"?\)/g)].map(m => m[1]).filter(u => !u.startsWith('data:') && !u.startsWith('#')))];
  for (const u of urls) { try { const r = await fetch(new URL(u, location.href).href); const bl = await r.blob(); const d = await new Promise(res => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(bl); }); css = css.split(u).join(d); } catch {} }
  const root = document.getElementById('root').cloneNode(true);
  for (const img of root.querySelectorAll('img')) { const live = document.querySelector(`img[src="${img.getAttribute('src')}"]`); if (live && live.complete && live.naturalWidth) { try { const c = document.createElement('canvas'); c.width = live.naturalWidth; c.height = live.naturalHeight; c.getContext('2d').drawImage(live,0,0); img.src = c.toDataURL(); } catch {} } }
  const liveC = document.querySelectorAll('#root canvas'); root.querySelectorAll('canvas').forEach((c,i)=>{ try { const im=document.createElement('img'); im.src=liveC[i].toDataURL(); im.className=c.className; im.setAttribute('style', c.getAttribute('style')||''); im.style.width=liveC[i].clientWidth+'px'; im.style.height=liveC[i].clientHeight+'px'; c.replaceWith(im);} catch{} });
  root.querySelectorAll('textarea').forEach(t => t.textContent = t.value);
  const ha = [...document.documentElement.attributes].map(a => `${a.name}="${a.value.replace(/"/g,'&quot;')}"`).join(' ');
  const ba = [...document.body.attributes].map(a => `${a.name}="${a.value.replace(/"/g,'&quot;')}"`).join(' ');
  css = css.replace(/\/\*# sourceMappingURL=[^*]*\*\//g, '').replace(/\/Users\/[^\s"')]+/g, '');
  return `<!doctype html>\n<html ${ha}>\n<head><meta charset="utf-8"><title>Apex Deck capture</title>\n<style>\n${css}\n</style></head>\n<body ${ba}>\n${root.outerHTML}\n</body></html>`;
});
fs.writeFileSync('/tmp/jigga-atp/base.html', html);
await p.screenshot({ path: '/tmp/jigga-atp/base.live.png' });
await b.close();
