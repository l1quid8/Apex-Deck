// Browser checks (2026-11-08, five layouts): Horizontal and Vertical are their
// own layouts, listed above Even grid. No submenu.
//  - The picker lists five choices in this order: Horizontal, Vertical,
//    Even grid, Focus left, Focus right. Exactly one is ticked.
//  - Horizontal's icon is three stacked full-width stripes; Vertical's is three
//    side-by-side full-height stripes.
//  - Horizontal: full-width rows stacked, scrolling down.
//  - Vertical: full-height columns side by side, scrolling sideways.
//  - Zoom sets how many bands are on screen, down to one band filling the area.
//  - Even grid is the ordinary grid again, and every layout can be reached
//    from every other.
//   node mockups/adaptive-thread-panes/verify-grid-direction.mjs
import { chromium } from '/Users/tylercaldwell/Downloads/apex-deck/node_modules/playwright/index.mjs';
import fs from 'node:fs';
const FILE = 'file:///Users/tylercaldwell/Downloads/apex-deck/mockups/adaptive-thread-panes.html';
const SHOTS = '/tmp/jigga-grid-dir'; fs.mkdirSync(SHOTS, { recursive: true });
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
let fails = 0; let n = 0;
const ok = (name, cond, extra = '') => { n++; console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`); if (!cond) fails++; };
const wait = (p, ms) => p.waitForTimeout(ms);
const near = (a, b, t = 1.5) => Math.abs(a - b) <= t;
const rects = (page) => page.evaluate(() => { const w = mkMap.world(); return Array.from({ length: w.n }, (_, i) => mkMap.rectOf(i)); });
const mapBox = (page) => page.$eval('.mk-map', (e) => { const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
const label = (page) => page.$eval('.layout-picker-trigger', (b) => b.getAttribute('aria-label'));
const openPicker = async (page) => { await page.click('.layout-picker-trigger'); await wait(page, 150); };
const pick = async (page, layout) => { await openPicker(page); await page.click(`.layout-choice[data-layout="${layout}"]`); await wait(page, 500); };
const ticked = (page) => page.$$eval('.layout-choice', (bs) => bs.filter((b) => b.getAttribute('aria-checked') === 'true').map((b) => b.dataset.layout));
// Lines each choice's description wraps to (all should be 1, with or without the ✓).
const descLines = (page) => page.$$eval('.layout-choice small', (ss) => ss.map((s) => Math.round(s.getBoundingClientRect().height / parseFloat(getComputedStyle(s).lineHeight))));
const focusMap = (page) => page.evaluate(() => document.querySelector('.mk-map').focus({ preventScroll: true }));
const key = async (page, k, ms = 450) => { await focusMap(page); await page.keyboard.press(k); await wait(page, ms); };
const onScreen = (r, mb) => r.x + r.w > 1 && r.x < mb.w - 1 && r.y + r.h > 1 && r.y < mb.h - 1;

for (const vp of [{ width: 1512, height: 945 }, { width: 1100, height: 650 }]) {
  const tag = `${vp.width}x${vp.height}`;
  const page = await browser.newPage({ viewport: vp });
  const errors = []; page.on('pageerror', (e) => errors.push(String(e))); page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(FILE); await wait(page, 800);

  // ---- five flat choices ----
  await openPicker(page);
  const menu = await page.evaluate(() => {
    const pop = document.querySelector('.layout-picker-popover'); const r = pop.getBoundingClientRect();
    const rows = [...pop.querySelectorAll('.layout-choice')].map((b) => ({ layout: b.dataset.layout, name: b.querySelector('strong').firstChild.textContent.trim(), detail: b.querySelector('small')?.textContent || '', role: b.getAttribute('role'), checked: b.getAttribute('aria-checked'), popup: b.getAttribute('aria-haspopup'), isNew: !!b.querySelector('.mk-new') }));
    return { rows, bottom: r.bottom, top: r.top, winH: innerHeight };
  });
  ok(`${tag}: five layouts in order: Horizontal, Vertical, Even grid, Focus left, Focus right`, menu.rows.map((q) => q.name).join('|') === 'Horizontal|Vertical|Even grid|Focus left|Focus right', menu.rows.map((q) => q.name).join('|'));
  ok(`${tag}: every choice is a menu radio with a one-line description`, menu.rows.every((q) => q.role === 'menuitemradio' && q.detail.length > 8));
  ok(`${tag}: no choice opens a submenu`, menu.rows.every((q) => !q.popup));
  ok(`${tag}: exactly one choice is ticked, and it matches the button label`, menu.rows.filter((q) => q.checked === 'true').length === 1 && (await label(page)) === `Pane layout: ${menu.rows.find((q) => q.checked === 'true').name}`, `${menu.rows.filter((q) => q.checked === 'true').map((q) => q.name)} · ${await label(page)}`);
  ok(`${tag}: Horizontal and Vertical are marked new, like Focus right`, ['horizontal', 'vertical', 'right'].every((l) => menu.rows.find((q) => q.layout === l)?.isNew));
  let dl = await descLines(page);
  ok(`${tag}: every description fits on one line`, dl.every((x) => x === 1), dl.join(','));
  ok(`${tag}: the menu fits inside the window`, menu.top >= 0 && menu.bottom <= menu.winH - 4, `${Math.round(menu.top)}–${Math.round(menu.bottom)} / ${menu.winH}`);
  const pics = await page.evaluate(() => ['horizontal', 'vertical'].map((l) => {
    const p = document.querySelector(`.layout-choice[data-layout="${l}"] .layout-preview`);
    const b = p.getBoundingClientRect(); const cs = getComputedStyle(p); const pad = parseFloat(cs.paddingLeft) + parseFloat(cs.borderLeftWidth);
    return { inW: b.width - 2 * pad, inH: b.height - 2 * pad, s: [...p.children].map((i) => { const r = i.getBoundingClientRect(); return { x: r.left - b.left, y: r.top - b.top, w: r.width, h: r.height }; }) };
  }));
  const [ph, pv] = pics;
  ok(`${tag}: Horizontal icon: 3 full-width stripes stacked top to bottom`, ph.s.length === 3 && ph.s.every((q) => near(q.w, ph.inW)) && ph.s[1].y > ph.s[0].y && ph.s[2].y > ph.s[1].y && ph.s.every((q) => near(q.h, ph.s[0].h, 0.5)) && ph.s[0].w > ph.s[0].h * 2, JSON.stringify(ph.s.map((q) => [Math.round(q.w), Math.round(q.h)])));
  ok(`${tag}: Vertical icon: 3 full-height stripes side by side`, pv.s.length === 3 && pv.s.every((q) => near(q.h, pv.inH)) && pv.s[1].x > pv.s[0].x && pv.s[2].x > pv.s[1].x && pv.s.every((q) => near(q.w, pv.s[0].w, 0.5)) && pv.s[0].h > pv.s[0].w * 1.5, JSON.stringify(pv.s.map((q) => [Math.round(q.w), Math.round(q.h)])));
  await page.hover('.layout-choice[data-layout="grid"]'); await wait(page, 150);
  ok(`${tag}: hovering Even grid opens nothing extra`, await page.locator('.layout-picker-popover').count() === 1 && await page.locator('.mk-grid-sub, .mk-dir-card').count() === 0);
  await page.screenshot({ path: `${SHOTS}/${vp.width}-menu.png` });

  // ---- Even grid is the ordinary grid ----
  await page.click('.layout-choice[data-layout="grid"]'); await wait(page, 500);
  let w = await page.evaluate(() => mkMap.world());
  ok(`${tag}: Even grid gives the ordinary grid`, (await label(page)) === 'Pane layout: Even grid' && !w.band && (vp.width < 1200 || w.C > 1), `${await label(page)} · C=${w.C} band=${w.band}`);
  await openPicker(page);
  ok(`${tag}: Even grid: only Even grid is ticked`, (await ticked(page)).join('|') === 'grid', (await ticked(page)).join('|'));
  await page.keyboard.press('Escape'); await wait(page, 100);
  ok(`${tag}: Esc closes the menu`, await page.locator('.layout-picker-popover').count() === 0);

  // ---- Horizontal: full-width rows, scroll down ----
  await pick(page, 'horizontal');
  let mb = await mapBox(page); w = await page.evaluate(() => mkMap.world()); let r = await rects(page);
  ok(`${tag}: Horizontal picked: label and band`, (await label(page)) === 'Pane layout: Horizontal' && w.band === 'h' && await page.locator('.layout-picker-popover').count() === 0, await label(page));
  await openPicker(page);
  ok(`${tag}: Horizontal: only Horizontal is ticked`, (await ticked(page)).join('|') === 'horizontal', (await ticked(page)).join('|'));
  dl = await descLines(page);
  ok(`${tag}: Horizontal ticked: descriptions still fit on one line`, dl.every((x) => x === 1), dl.join(','));
  await page.keyboard.press('Escape'); await wait(page, 100);
  ok(`${tag}: Horizontal: every pane is a full-width row`, r.every((q) => near(q.x, 0) && near(q.w, mb.w)), `w ${Math.round(r[0].w)} / map ${Math.round(mb.w)}`);
  ok(`${tag}: Horizontal: rows stack in thread order`, r.every((q, i) => i === 0 || q.y > r[i - 1].y));
  let vis = r.filter((q) => onScreen(q, mb));
  ok(`${tag}: Horizontal: the visible rows fill the height exactly`, vis.length === w.rv && near(vis[0].y, 0) && near(vis.at(-1).y + vis.at(-1).h, mb.h), `${vis.length} visible, rv ${w.rv}, bottom ${Math.round(vis.at(-1).y + vis.at(-1).h)}/${Math.round(mb.h)}`);
  ok(`${tag}: Horizontal: more threads than fit, so it scrolls down`, w.H > mb.h + 1 && w.W <= mb.w + 1);
  const liveH = await page.evaluate(() => mkMap.live().length);
  ok(`${tag}: Horizontal: visible rows are real panes`, liveH >= vis.length, `live ${liveH}`);
  await page.screenshot({ path: `${SHOTS}/${vp.width}-horizontal.png` });
  // Scroll down with the wheel over the gap between two rows.
  await page.mouse.move(mb.x + mb.w / 2, mb.y + vis[0].y + vis[0].h + 4);
  await page.mouse.wheel(0, 420); await wait(page, 700);
  let cam = await page.evaluate(() => mkMap.cam()); w = await page.evaluate(() => mkMap.world());
  ok(`${tag}: Horizontal: scrolling moves down, never sideways`, cam.y > 1 && near(cam.x, 0), JSON.stringify(cam));
  ok(`${tag}: Horizontal: scrolling settles on a whole row`, near(cam.y % (w.rowH + 8), 0, 1) || near(cam.y % (w.rowH + 8), w.rowH + 8, 1) || near(cam.y, w.H - mb.h, 1), `y ${cam.y.toFixed(1)}, stride ${(w.rowH + 8).toFixed(1)}`);
  // Zoom: in = fewer rows, down to one; out = more.
  await key(page, 'Digit0');
  const rv0 = (await page.evaluate(() => mkMap.world())).rv;
  await key(page, 'Equal'); w = await page.evaluate(() => mkMap.world());
  ok(`${tag}: Horizontal: zooming in shows fewer, taller rows`, w.band === 'h' && w.rv < rv0, `${rv0} → ${w.rv}`);
  for (let k = 0; k < 12; k++) await key(page, 'Equal', 300);
  await wait(page, 300); w = await page.evaluate(() => mkMap.world()); r = await rects(page); vis = r.filter((q) => onScreen(q, mb));
  ok(`${tag}: Horizontal: zooming all the way in gives one row filling the area`, w.rv === 1 && vis.length === 1 && near(vis[0].h, mb.h) && near(vis[0].w, mb.w), `rv ${w.rv}, ${Math.round(vis[0]?.w)}×${Math.round(vis[0]?.h)}`);
  for (let k = 0; k < 14; k++) await key(page, 'Minus', 300);
  await wait(page, 300); w = await page.evaluate(() => mkMap.world());
  ok(`${tag}: Horizontal: zooming out shows more rows than the default`, w.rv > rv0, `rv ${w.rv} vs default ${rv0}`);
  r = await rects(page);
  ok(`${tag}: Horizontal: rows stay readable (≥ 56px)`, r.every((q) => q.h >= 55.5), `${Math.round(Math.min(...r.map((q) => q.h)))}px`);

  // ---- Vertical: full-height columns, scroll sideways ----
  await pick(page, 'vertical');
  mb = await mapBox(page); w = await page.evaluate(() => mkMap.world()); r = await rects(page);
  ok(`${tag}: Vertical picked: label and band`, (await label(page)) === 'Pane layout: Vertical' && w.band === 'v', await label(page));
  await openPicker(page);
  ok(`${tag}: Vertical: only Vertical is ticked`, (await ticked(page)).join('|') === 'vertical', (await ticked(page)).join('|'));
  dl = await descLines(page);
  ok(`${tag}: Vertical ticked: descriptions still fit on one line`, dl.every((x) => x === 1), dl.join(','));
  await page.keyboard.press('Escape'); await wait(page, 100);
  ok(`${tag}: Vertical starts at its usual zoom, scrolled to the start`, near((await page.evaluate(() => mkMap.cam())).x, 0) && w.li === w.d);
  ok(`${tag}: Vertical: every pane is a full-height column`, r.every((q) => near(q.y, 0) && near(q.h, mb.h)), `h ${Math.round(r[0].h)} / map ${Math.round(mb.h)}`);
  ok(`${tag}: Vertical: columns run left to right in thread order`, r.every((q, i) => i === 0 || q.x > r[i - 1].x));
  vis = r.filter((q) => onScreen(q, mb));
  ok(`${tag}: Vertical: the visible columns fill the width exactly`, vis.length === w.cv && near(vis[0].x, 0) && near(vis.at(-1).x + vis.at(-1).w, mb.w), `${vis.length} visible, cv ${w.cv}`);
  ok(`${tag}: Vertical: columns are at least 280px at the usual zoom`, vis.every((q) => q.w >= 279.5), `${Math.round(vis[0].w)}px`);
  ok(`${tag}: Vertical: more threads than fit, so it scrolls sideways`, w.W > mb.w + 1 && near(w.H, mb.h));
  const liveV = await page.evaluate(() => mkMap.live().length);
  ok(`${tag}: Vertical: visible columns are real panes`, liveV >= vis.length, `live ${liveV}`);
  await page.screenshot({ path: `${SHOTS}/${vp.width}-vertical.png` });
  // Sideways: a horizontal swipe over a pane, and an ordinary wheel over the gap.
  await page.mouse.move(mb.x + vis[0].x + vis[0].w / 2, mb.y + mb.h / 2);
  await page.mouse.wheel(500, 0); await wait(page, 700);
  cam = await page.evaluate(() => mkMap.cam()); w = await page.evaluate(() => mkMap.world());
  const stride = w.colW + 8;
  ok(`${tag}: Vertical: a sideways swipe scrolls sideways, never down`, cam.x > 1 && near(cam.y, 0), JSON.stringify(cam));
  ok(`${tag}: Vertical: scrolling settles on a whole column`, near(cam.x % stride, 0, 1) || near(cam.x % stride, stride, 1) || near(cam.x, w.W - mb.w, 1), `x ${cam.x.toFixed(1)}, stride ${stride.toFixed(1)}`);
  await key(page, 'Home', 500);
  r = await rects(page);
  if (w.cv > 1) {
    // Over the gap between two columns (one column fills the width: no gap).
    await page.mouse.move(mb.x + r[0].x + r[0].w + 4, mb.y + mb.h / 2);
    await page.mouse.wheel(0, 400); await wait(page, 700);
    cam = await page.evaluate(() => mkMap.cam());
    ok(`${tag}: Vertical: an ordinary wheel over the map scrolls sideways`, cam.x > 1 && near(cam.y, 0), JSON.stringify(cam));
    await key(page, 'Home', 500);
  }
  await key(page, 'ArrowRight', 600);
  cam = await page.evaluate(() => mkMap.cam());
  ok(`${tag}: Vertical: → key scrolls one whole column sideways`, near(cam.x, stride, 1) && near(cam.y, 0), `x ${cam.x.toFixed(1)}, stride ${stride.toFixed(1)}`);
  await key(page, 'End', 600);
  cam = await page.evaluate(() => mkMap.cam()); r = await rects(page);
  ok(`${tag}: Vertical: End reaches the last column, flush with the right edge`, near(r.at(-1).x + r.at(-1).w, mb.w), `${Math.round(r.at(-1).x + r.at(-1).w)}/${Math.round(mb.w)}`);
  // Zoom: in = fewer, wider columns, down to one; the active pane stays on screen.
  await key(page, 'Home', 500);
  const cv0 = (await page.evaluate(() => mkMap.world())).cv;
  const act = await page.evaluate(() => { const w = mkMap.world(); const mbw = document.querySelector('.mk-map').getBoundingClientRect().width; for (let i = 0; i < w.n; i++) { const q = mkMap.rectOf(i); if (q.x >= 0 && q.x + q.w <= mbw + 1) { if (i > 0) return i; } } return 0; });
  // Make the second visible column the active pane by clicking its transcript.
  r = await rects(page);
  await page.mouse.click(mb.x + r[act].x + r[act].w / 2, mb.y + r[act].y + 80); await wait(page, 300);
  await key(page, 'Equal'); w = await page.evaluate(() => mkMap.world()); r = await rects(page);
  ok(`${tag}: Vertical: zooming in shows fewer, wider columns`, w.band === 'v' && (cv0 === 1 ? w.cv === 1 : w.cv < cv0), `${cv0} → ${w.cv}`);
  ok(`${tag}: Vertical: zoom keeps the active pane on screen`, r[act].x >= -1 && r[act].x + r[act].w <= mb.w + 1, `pane ${act} at ${Math.round(r[act].x)}–${Math.round(r[act].x + r[act].w)}, zoomBy ${w.zoomBy}`);
  for (let k = 0; k < 12; k++) await key(page, 'Equal', 300);
  await wait(page, 300); w = await page.evaluate(() => mkMap.world()); r = await rects(page); vis = r.filter((q) => onScreen(q, mb));
  ok(`${tag}: Vertical: zooming all the way in gives one column filling the area`, w.cv === 1 && vis.length === 1 && near(vis[0].w, mb.w) && near(vis[0].h, mb.h), `cv ${w.cv}`);
  for (let k = 0; k < 14; k++) await key(page, 'Minus', 300);
  await wait(page, 300); w = await page.evaluate(() => mkMap.world()); r = await rects(page);
  ok(`${tag}: Vertical: zooming out shows more columns than the default`, w.cv > cv0, `cv ${w.cv} vs default ${cv0}`);
  ok(`${tag}: Vertical: columns stay readable (≥ 120px)`, r.every((q) => q.w >= 119.5), `${Math.round(Math.min(...r.map((q) => q.w)))}px`);
  ok(`${tag}: no panes overlap`, r.every((a, i) => r.every((b, j) => i >= j || a.x + a.w <= b.x + 0.5 || b.x + b.w <= a.x + 0.5 || a.y + a.h <= b.y + 0.5 || b.y + b.h <= a.y + 0.5)));
  await key(page, 'Digit0', 500);

  // ---- every layout reachable from every other, by keyboard ----
  const ALL = [['horizontal', 'Horizontal', 'h'], ['vertical', 'Vertical', 'v'], ['grid', 'Even grid', null], ['left', 'Focus left', null], ['right', 'Focus right', null]];
  let bad = [];
  for (const [from] of ALL) for (const [to, name, band] of ALL) {
    if (from === to) continue;
    await pick(page, from);
    await openPicker(page);
    await page.focus(`.layout-choice[data-layout="${to}"]`); await page.keyboard.press('Enter'); await wait(page, 450);
    w = await page.evaluate(() => mkMap.world());
    if ((await label(page)) !== `Pane layout: ${name}` || (w.band || null) !== band || await page.locator('.layout-picker-popover').count() !== 0) bad.push(`${from}→${to}: ${await label(page)} band=${w.band}`);
  }
  ok(`${tag}: all 20 layout switches land on the chosen layout (Enter on a focused choice)`, bad.length === 0, bad.slice(0, 4).join(' | '));
  await pick(page, 'vertical');
  await key(page, 'ArrowRight', 600);
  await pick(page, 'horizontal');
  ok(`${tag}: switching bands starts the new one scrolled to the start`, near((await page.evaluate(() => mkMap.cam())).x, 0) && near((await page.evaluate(() => mkMap.cam())).y, 0));
  await pick(page, 'left');
  w = await page.evaluate(() => mkMap.world());
  ok(`${tag}: Focus left has no bands`, (await label(page)) === 'Pane layout: Focus left' && !w.band);

  ok(`${tag}: no page errors`, errors.length === 0, errors.join(' | '));
  await page.close();
}
await browser.close();
console.log(`${n - fails}/${n} PASS`);
process.exit(fails ? 1 : 0);
