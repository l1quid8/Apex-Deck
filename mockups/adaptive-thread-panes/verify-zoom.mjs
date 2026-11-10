// Checks for the zoomable thread map (adaptive-thread-panes.html, 2026-11-08).
import { chromium } from '/Users/tylercaldwell/Downloads/apex-deck/node_modules/playwright/index.mjs';
const FILE = 'file:///Users/tylercaldwell/Downloads/apex-deck/mockups/adaptive-thread-panes.html';
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
const out = []; let fails = 0;
const ok = (name, cond, extra = '') => { out.push(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`); if (!cond) fails++; };
const page = await browser.newPage({ viewport: { width: 1512, height: 945 } });
const errors = []; const reqs = [];
page.on('pageerror', (e) => errors.push(String(e))); page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('request', (r) => { if (!r.url().startsWith('file:') && !r.url().startsWith('data:')) reqs.push(r.url()); });
await page.goto(FILE); await page.waitForTimeout(700);
const shot = (n) => page.screenshot({ path: `/tmp/jigga-zoom/v-${n}.png` });
const cam = () => page.evaluate(() => mkMap.cam());
const where = () => page.evaluate(() => mkMap.where());
const stats = () => page.evaluate(() => mkMap.stats());
const live = () => page.evaluate(() => mkMap.live());
const to = () => page.$eval('#mk-to strong', (e) => e.textContent);
const order = () => page.evaluate(() => [...document.querySelectorAll('#mk-ws .pane-row')].map((r) => r.dataset.paneRow).join());
const mapBox = () => page.$eval('.mk-map', (el) => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
const paneRects = () => page.evaluate(() => [...document.querySelectorAll('#mk-grid .pane')].filter((p) => !p.classList.contains('mk-leaving')).map((p) => { const r = p.getBoundingClientRect(); return `${p.dataset.id}@${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.width)}x${Math.round(r.height)}`; }).sort().join('|'));
const btn = (act) => page.click(`.mk-mapbar button[data-act="${act}"]`);
const settle = (ms = 900) => page.waitForTimeout(ms);
const near = (a, b, tol = 1.5) => Math.abs(a - b) <= tol;

// ---------- 1. Normal scrolling at 100% ----------
const rects0 = await paneRects(); const sel0 = await to(); const order0 = await order();
let c = await cam(); let m = await mapBox();
ok('default view is 100% at the top', c.z === 1 && c.y === 0, JSON.stringify(c));
const heads = await page.$$eval('.mk-live .pane .pane-head', (hs) => hs.map((h) => Math.round(h.getBoundingClientRect().height)));
ok('side panes are live with the real 28px title bar', heads.length >= 3 && heads.every((h) => h === 28), JSON.stringify(heads));
ok('no small map at 100%', await page.$eval('.mk-mini', (e) => e.hidden));
ok('location shows the visible range', /^(Threads )?1–\d+ of 13$/.test(await where()), await where());
await shot('01-default');
// Wheel down over a side pane whose transcript is already at its latest message: the list scrolls.
const firstSide = await page.$eval('.mk-live .pane', (p) => { const r = p.getBoundingClientRect(); return { id: p.dataset.id, x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
await page.mouse.move(firstSide.x, firstSide.y); await page.mouse.wheel(0, 120); await settle(250);
c = await cam(); ok('scroll down over a pane at its latest message scrolls the list 1:1', near(c.y, 120) && c.z === 1, JSON.stringify(c));
// Wheel up over a transcript that can scroll up: the transcript scrolls, the list stays.
await page.waitForTimeout(300);
const before = await page.evaluate((id) => document.querySelector(`.pane[data-id="${id}"] .transcript`).scrollTop, firstSide.id);
const pane1 = await page.$eval(`.pane[data-id="${firstSide.id}"]`, (p) => { const r = p.getBoundingClientRect(); const m = document.querySelector('.mk-map').getBoundingClientRect(); const top = Math.max(r.top, m.top); return { x: r.left + r.width / 2, y: (top + r.bottom) / 2 }; });
await page.mouse.move(pane1.x, pane1.y); await page.mouse.wheel(0, -200); await settle(250);
const after = await page.evaluate((id) => document.querySelector(`.pane[data-id="${id}"] .transcript`).scrollTop, firstSide.id);
c = await cam(); ok('scroll up inside a transcript scrolls that conversation, not the list', after < before && near(c.y, 120), `scrollTop ${before}→${after}, cam.y ${c.y}`);
// Keyboard and End/Home on the map.
await page.waitForTimeout(300);
await page.focus('.mk-map'); await page.keyboard.press('End'); await settle(200);
c = await cam(); const w = await page.evaluate(() => mkMap.world());
ok('End reaches the last row; the last pane clears the bottom', near(c.y, w.H - m.h, 2), `y ${c.y.toFixed(1)} vs ${w.H - m.h}`);
await page.keyboard.press('Home'); await settle(200);
c = await cam(); ok('Home returns to the top', c.y === 0);

// ---------- 2. Keep my place: a reading position, a draft ----------
// Scroll the 2nd side pane's transcript to the middle and note the top line.
const p2 = await page.$$eval('.mk-live .pane', (ps) => ps[1].dataset.id);
await page.evaluate((id) => { const tr = document.querySelector(`.pane[data-id="${id}"] .transcript`); tr.scrollTop = Math.round((tr.scrollHeight - tr.clientHeight) * 0.4); }, p2);
const topLine = () => page.evaluate((id) => { const tr = document.querySelector(`.pane[data-id="${id}"] .transcript`); if (!tr || !tr.clientHeight) return null; const t0 = tr.getBoundingClientRect().top; for (const [i, k] of [...tr.children].entries()) { const r = k.getBoundingClientRect(); if (r.bottom > t0 + 1) return { i, off: Math.round(t0 - r.top) }; } return null; }, p2);
const line0 = await topLine();
await page.click('#mk-input'); await page.keyboard.type('draft that must survive zooming');
const draft0 = await page.$eval('#mk-input', (e) => e.value);

// ---------- 3. Zooming toward the pointer ----------
m = await mapBox();
await page.focus('.mk-map'); for (let i = 0; i < 10; i++) await page.keyboard.press('ArrowDown'); await settle(200);
const pX = m.x + m.w * 0.5; const pY = m.y + 300;
const wp0 = await page.evaluate(({ sx, sy }) => { const c = mkMap.cam(); return { x: c.x + sx / c.z, y: c.y + sy / c.z }; }, { sx: pX - m.x, sy: pY - m.y });
await page.mouse.move(pX, pY);
await page.keyboard.down('Control'); await page.mouse.wheel(0, 30); await page.keyboard.up('Control'); await settle(250);
const wp1 = await page.evaluate(({ sx, sy }) => { const c = mkMap.cam(); return { x: c.x + sx / c.z, y: c.y + sy / c.z }; }, { sx: pX - m.x, sy: pY - m.y });
c = await cam();
ok('Ctrl/⌘ + scroll (pinch) zooms out toward the pointer', c.z < 1 && near(wp0.y, wp1.y, 1), `z ${c.z.toFixed(3)}, world point under pointer y ${wp0.y.toFixed(1)}→${wp1.y.toFixed(1)}`);
ok('Back is available after a zoom', !(await page.$eval('.mk-mapbar button[data-act="back"]', (b) => b.disabled)));
await btn('out'); await settle();
c = await cam();
ok('small map shows when zoomed out with part of the list off screen', c.z < 0.5 && await page.$eval('.mk-mini', (e) => !e.hidden), `z ${c.z.toFixed(3)}`);
ok('zooming never changes the shared composer’s destination', (await to()) === sel0, await to());
ok('draft kept while zooming', (await page.$eval('#mk-input', (e) => e.value)) === draft0);
ok('pane order kept while zooming', (await order()) === order0);

// ---------- 4. Panning (the list is still taller than the view here) ----------
const cz = await cam(); m = await mapBox();
await page.mouse.move(m.x + 14, m.y + m.h * 0.7); await page.mouse.down(); await page.mouse.move(m.x + 14, m.y + m.h * 0.7 - 120, { steps: 6 }); await page.mouse.up(); await settle(200);
c = await cam();
ok('drag the empty background to pan', near(c.y - cz.y, 120 / cz.z, 2), `y ${cz.y.toFixed(1)}→${c.y.toFixed(1)} (z ${cz.z.toFixed(3)})`);
await page.focus('.mk-map'); const ck = await cam(); await page.keyboard.press('ArrowUp'); await settle(150);
c = await cam(); ok('arrow keys pan', near(c.y, ck.y - 60 / ck.z, 1), `y ${ck.y.toFixed(1)}→${c.y.toFixed(1)}`);
const mini = await page.$eval('.mk-mini canvas', (el) => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
const cm0 = await cam(); await page.mouse.click(mini.x + mini.w / 2, mini.y + mini.h - 3); await settle(200); const cm1 = await cam();
ok('clicking the small map moves there', cm1.y > cm0.y, `y ${cm0.y.toFixed(1)}→${cm1.y.toFixed(1)}`);
await shot('02-zoomed-out');
await btn('out'); await settle();
c = await cam(); const st1 = await stats();
ok('− again: the whole list fits and small panes turn into drawn cards', c.z < 0.3 && st1.live === 0 && st1.cards === 13, `z ${c.z.toFixed(3)} ${JSON.stringify(st1)}`);

// ---------- 5. Fit open threads, where am I ----------
await btn('fit'); await settle();
c = await cam(); const fitAll = await page.evaluate(() => { const r = document.querySelector('.mk-map').getBoundingClientRect(); const w = mkMap.world(); const out = []; for (let i = 0; i < w.n; i++) { const s = mkMap.rectOf(i); out.push(s.x >= -1 && s.y >= -1 && s.x + s.w <= r.width + 1 && s.y + s.h <= r.height + 1); } return out.every(Boolean); });
ok('Fit open threads shows every open thread', fitAll, `z ${c.z.toFixed(3)}`);
ok('location says all of them', /All 13 threads/.test(await where()), await where());
await shot('03-fit');

// ---------- 6. A tiny preview becomes a fully working pane by zooming (no focus swap) ----------
const target = 4;
const r4 = await page.evaluate((i) => mkMap.rectOf(i), target); m = await mapBox();
await page.mouse.move(m.x + r4.x + r4.w / 2, m.y + r4.y + r4.h / 2); await settle(150);
const tipTxt = await page.$eval('.mk-tip', (e) => e.hidden ? '' : e.textContent);
await page.mouse.click(m.x + r4.x + r4.w / 2, m.y + r4.y + r4.h / 2); await settle(1000);
c = await cam(); const lv = await live();
const tid = await page.evaluate((i) => { const w = mkMap.world(); return document.querySelectorAll('#mk-ws .pane-row')[0] && null; }, target);
ok('hovering a card names the thread', tipTxt.length > 0, tipTxt);
ok('clicking a card zooms it to a live, readable pane', c.z >= 0.99 && lv.length > 0, `z ${c.z.toFixed(3)}, live ${lv.length}`);
ok('…without changing the composer’s destination', (await to()) === sel0);
const r4b = await page.evaluate((i) => mkMap.rectOf(i), target);
const liveId = await page.evaluate(({ x, y }) => { const el = document.elementFromPoint(x, y); const p = el && el.closest('.pane'); return p ? p.dataset.id : null; }, { x: m.x + r4b.x + 40, y: m.y + r4b.y + 14 });
ok('that pane is a real DOM pane under the pointer', !!liveId, String(liveId));
await shot('04-zoomed-to-card');

// ---------- 7. Real toolbar actions on a pane shown at a reduced zoom ----------
await btn('out'); await settle();
c = await cam();
const tile = await page.evaluate((id) => { const p = document.querySelector(`.pane[data-id="${id}"]`); if (!p) return null; const r = p.getBoundingClientRect(); const b = [...p.querySelectorAll('.pane-head > button, .pane-head .pane-menu-wrap > button')].map((x) => { const q = x.getBoundingClientRect(); return { l: x.getAttribute('aria-label'), x: q.left + q.width / 2, y: q.top + q.height / 2, vis: q.width > 0 && q.right <= r.right + 1 }; }); return { w: r.width, h: r.height, head: p.querySelector('.pane-head').getBoundingClientRect().height, b }; }, liveId);
ok('at 50% the pane is still live with its 28px title bar and all three buttons', tile && tile.head === 28 && tile.b.length === 3 && tile.b.every((x) => x.vis), JSON.stringify(tile && { w: Math.round(tile.w), h: Math.round(tile.h), head: tile.head, b: tile.b.map((x) => x.l + ':' + x.vis) }));
const camBeforeFull = await cam();
await page.mouse.click(tile.b[0].x, tile.b[0].y); await settle(300);
const full = await page.evaluate(() => { const p = document.querySelector('.mk-main > .pane.mk-full'); return p ? p.dataset.id : null; });
ok('□ fills the canvas with that thread', full === liveId, String(full));
ok('…and the map bar hides in full screen', await page.$eval('.mk-mapbar', (e) => e.hidden));
await shot('05-full');
await page.keyboard.press('Escape'); await settle(300);
c = await cam();
ok('Esc returns to the same zoom and place', near(c.z, camBeforeFull.z, 1e-6) && near(c.x, camBeforeFull.x, 0.5) && near(c.y, camBeforeFull.y, 0.5), JSON.stringify(c));
const t2 = await page.evaluate((id) => { const p = document.querySelector(`.pane[data-id="${id}"]`); const b = p.querySelector('.pane-menu-wrap > button').getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; }, liveId);
await page.mouse.click(t2.x, t2.y); await settle(200);
ok('⋯ opens the real pane menu', await page.$('.pane-menu.deck-menu[role="menu"]') !== null);
await page.keyboard.press('Escape'); await settle(150);
// Toolbar click selected that pane (an explicit click inside it): put the destination back for the next checks.
const selAfterToolbar = await to();
ok('clicking inside a pane does select it (explicit choice)', selAfterToolbar !== sel0, selAfterToolbar);

// ---------- 8. Back, and Reset to the original layout ----------
await btn('back'); await settle();
c = await cam(); ok('Back returns to the previous zoom level', near(c.z, 1, 0.02) || c.z > camBeforeFull.z, `z ${c.z.toFixed(3)}`);
await btn('reset'); await settle();
c = await cam(); ok('Reset (100%) goes back to 100% at the top', c.z === 1 && c.y === 0 && c.x === 0, JSON.stringify(c));
// reading place restored after the pane was a card and came back
const line1 = await topLine();
ok('each thread keeps its reading place through zoom out and back', line0 && line1 && line0.i === line1.i && Math.abs(line0.off - line1.off) <= 3, `${JSON.stringify(line0)} → ${JSON.stringify(line1)}`);
// select the original thread again via its pane, then compare the layout with the start
await page.click(`#mk-ws .pane-row[data-pane-row="${await page.evaluate(() => [...document.querySelectorAll('#mk-ws .pane-row')].find((r) => r.textContent.includes('Multiple thread pane management')).dataset.paneRow)}"]`); await settle(700);
ok('the shared composer draft for that thread survived', (await page.$eval('#mk-input', (e) => e.value)) === draft0, await page.$eval('#mk-input', (e) => e.value));
await btn('reset'); await settle();
const rects1 = await paneRects();
ok('after Reset the panes are exactly where they started', rects1 === rects0, rects1 === rects0 ? '' : `\n  before ${rects0}\n  after  ${rects1}`);
await shot('06-reset');

// ---------- 9. Keyboard zoom, Fit, Back ----------
await page.focus('.mk-map'); await page.keyboard.press('-'); await settle();
const kz = (await cam()).z; ok('− key zooms out', kz < 1, kz.toFixed(3));
await page.keyboard.press('Shift+Digit1'); await settle(); const kf = await where();
ok('Shift+1 fits open threads', /All/.test(kf), kf);
await page.keyboard.press('Backspace'); await settle(); ok('Backspace goes back', near((await cam()).z, kz, 1e-6), (await cam()).z.toFixed(3));
await page.keyboard.press('0'); await settle(); ok('0 resets to 100%', (await cam()).z === 1);

// ---------- 10. Grid and Focus right ----------
for (const lay of ['grid', 'right']) {
  await page.click('.layout-picker-trigger'); await page.click(`.layout-choice[data-layout="${lay}"]`); await settle(500);
  const g0 = await paneRects();
  m = await mapBox();
  await page.mouse.move(m.x + m.w * 0.3, m.y + m.h * 0.3);
  await page.keyboard.down('Control'); for (let i = 0; i < 3; i++) await page.mouse.wheel(0, 40); await page.keyboard.up('Control'); await settle(300);
  c = await cam(); ok(`${lay}: pinch zooms the map`, c.z < 1, c.z.toFixed(3));
  await shot(`07-${lay}-zoomed`);
  await btn('reset'); await settle();
  ok(`${lay}: Reset puts every pane back`, (await paneRects()) === g0);
}
await page.click('.layout-picker-trigger'); await page.click('.layout-choice[data-layout="left"]'); await settle(500);
ok('Focus left keeps its own place after visiting other layouts', (await paneRects()) === rects0);

// ---------- 11. Bounded rendering at a billion threads ----------
await page.click('.mk-scale-btn'); await page.click('.mk-scale-menu button:has-text("+1,000,000,000")'); await settle(1400);
let s = await stats(); const wb = await page.evaluate(() => mkMap.world());
const domPanes = async () => page.$$eval('#mk-grid .pane', (ps) => ps.length);
ok('+1B: map nests threads in blocks', wb.kind === 'group' && wb.n === 1000000013, JSON.stringify(wb));
ok('+1B Fit: draws a bounded number of marks', s.cards + s.chips + s.blocks < 30000 && s.live === 0, JSON.stringify(s));
ok('+1B: location and small map say how many are synthetic', /1B synthetic/.test(await page.$eval('.mk-mini-stat', (e) => e.textContent)), await page.$eval('.mk-mini-stat', (e) => e.textContent));
await shot('08-billion-fit');
let maxDrawn = 0; let steps = 0; m = await mapBox();
for (let k = 0; k < 10; k++) {
  const r = await page.evaluate((i) => mkMap.rectOf(i), 30);
  const cx = Math.min(m.w - 4, Math.max(4, r.x + Math.min(r.w, 300) / 2)); const cy = Math.min(m.h - 4, Math.max(4, r.y + Math.min(r.h, 200) / 2));
  await page.mouse.move(m.x + cx, m.y + cy); await settle(80); await page.mouse.click(m.x + cx, m.y + cy); await settle(1000); steps++;
  s = await stats(); maxDrawn = Math.max(maxDrawn, s.cards + s.chips + s.blocks);
  if ((await cam()).z > 0.9) break;
}
const lv2 = await live();
ok('+1B: clicking down through blocks reaches live panes', lv2.some((id) => id.startsWith('syn-')), `${steps} clicks, live ${lv2.length}`);
ok('+1B: never more than 30,000 marks drawn on the way', maxDrawn < 30000, String(maxDrawn));
ok('+1B: real DOM panes stay bounded', (await domPanes()) <= 60, String(await domPanes()));
const synHead = await page.evaluate(() => { const p = [...document.querySelectorAll('.mk-live .pane.mk-syn')][0]; if (!p) return null; const h = p.querySelector('.pane-head'); return { title: p.querySelector('.pane-title').textContent, h: Math.round(h.getBoundingClientRect().height), btns: h.querySelectorAll(':scope > button, .pane-menu-wrap > button').length }; });
ok('+1B: a synthetic pane is labelled and has the real toolbar', synHead && /^Synthetic thread [\d,]+$/.test(synHead.title) && synHead.h === 28 && synHead.btns === 3, JSON.stringify(synHead));
ok('+1B: composer destination unchanged by all that zooming', (await to()) === 'Multiple thread pane management', await to());
await shot('09-billion-live');
await page.click('.mk-scale-btn'); await page.click('.mk-scale-menu button:has-text("None, just yours")'); await settle(600);
ok('turning the scale test off returns to your 13 threads as they were', (await paneRects()) === rects0);

// ---------- 12. Agent background ----------
await page.click('.mk-scale-btn'); await page.click('.mk-scale-menu button:has-text("13 agents")'); await settle(900);
let fld = await page.evaluate(() => mkMap.field());
ok('13 agents: every agent has its own face, no zoom pill', fld.length === 1 && fld[0].K === 13 && !(await page.$('.mk-field-hud')), JSON.stringify(fld));
await shot('10-agents-13');
await page.click('.mk-scale-btn'); await page.click('.mk-scale-menu button:has-text("1,000,000,000 agents")'); await settle(900);
fld = await page.evaluate(() => mkMap.field());
ok('1B agents: clusters, labelled synthetic', fld[0].K < 400 && /synthetic/.test(await page.$eval('.mk-field-hud', (e) => e.textContent)), await page.$eval('.mk-field-hud', (e) => e.textContent));
const cvb = await page.$eval('.mk-main canvas.mk-field', (el) => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
await page.mouse.move(cvb.x + cvb.w * 0.82, cvb.y + cvb.h * 0.5);
await page.keyboard.down('Control'); for (let i = 0; i < 6; i++) await page.mouse.wheel(0, -60); await page.keyboard.up('Control'); await settle(300);
fld = await page.evaluate(() => mkMap.field());
ok('pinch over the agents zooms into them', fld[0].z > 5, fld[0].z.toFixed(1));
ok('map camera untouched by the agent zoom', (await cam()).z === 1);
await shot('11-agents-zoomed');
await page.click('.mk-field-hud button'); await settle(1000);
fld = await page.evaluate(() => mkMap.field());
ok('agent Reset returns to the whole spiral', near(fld[0].z, 1, 1e-6), String(fld[0].z));
await page.click('.mk-scale-btn'); await page.getByRole('menuitemradio', { name: 'None', exact: true }).click(); await settle(600);

// ---------- 13. Composer chips match the real app ----------
const chips = await page.$$eval('#mk-shared .composer-bots .chip-wrap', (els) => els.length);
ok('composer agent chips are plain real chips (one per agent, no stack)', chips === 4 && !(await page.$('#mk-shared .mk-stack, #mk-shared [data-fit="pile"]')), String(chips));

// ---------- 14. Other window sizes and reduced motion ----------
for (const [vw, vh] of [[1280, 800], [1100, 650]]) {
  await page.setViewportSize({ width: vw, height: vh }); await settle(500);
  const bar = await page.$eval('.mk-mapbar', (b) => ({ over: b.scrollWidth > b.clientWidth + 1, w: b.clientWidth }));
  ok(`${vw}×${vh}: map bar fits`, !bar.over, JSON.stringify(bar));
  const sb = await page.$eval('.mk-scale-btn', (b) => ({ shown: getComputedStyle(b).display !== 'none', right: b.getBoundingClientRect().right }));
  const tabs = await page.$eval('.section-button', (b) => b.getBoundingClientRect().left);
  ok(`${vw}×${vh}: Scale test button clear of the tabs (or hidden)`, !sb.shown || sb.right < tabs, `${sb.shown ? Math.round(sb.right) + ' < ' + Math.round(tabs) : 'hidden'}`);
  await shot(`12-${vw}`);
}
await page.setViewportSize({ width: 1512, height: 945 }); await settle(400);
await page.emulateMedia({ reducedMotion: 'reduce' }); await settle(100);
await btn('out'); await page.waitForTimeout(60);
ok('reduced motion: zoom jumps without animating', near((await cam()).z, 0.5, 1e-6), (await cam()).z.toFixed(3));
await btn('reset'); await page.waitForTimeout(60);

ok('no page errors', errors.length === 0, errors.join(' | '));
ok('no network requests', reqs.length === 0, reqs.join(' '));
console.log(out.join('\n'));
console.log(`\n${out.length - fails}/${out.length} passed`);
await browser.close();
