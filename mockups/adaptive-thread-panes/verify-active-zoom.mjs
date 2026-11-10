// Browser checks (2026-11-08):
//  1. Zoom follows the active pane(s), not the pointer: real Ctrl+wheel with the
//     pointer parked in a far corner, HUD +/− buttons, and an active pane that
//     was scrolled off screen.
//     With several active panes, once they can't all stay on screen the pointer
//     takes over, so zooming carries on down to one full pane.
//  2. Send with a thread line that has no message fails loudly: Send stays
//     clickable, shakes, the empty thread's pane and #tag flash red briefly,
//     nothing is sent and the draft is kept.
//   node mockups/adaptive-thread-panes/verify-active-zoom.mjs
import { chromium } from '/Users/tylercaldwell/Downloads/apex-deck/node_modules/playwright/index.mjs';
import fs from 'node:fs';
const FILE = 'file:///Users/tylercaldwell/Downloads/apex-deck/mockups/adaptive-thread-panes.html';
const SHOTS = '/tmp/jigga-active-zoom'; fs.mkdirSync(SHOTS, { recursive: true });
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
let fails = 0; let n = 0;
const ok = (name, cond, extra = '') => { n++; console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`); if (!cond) fails++; };
const wait = (p, ms) => p.waitForTimeout(ms);

// Is pane `i` fully on screen in the map?
const inView = (page, i) => page.evaluate((i) => {
  const m = document.querySelector('.mk-map').getBoundingClientRect(); const r = mkMap.rectOf(i);
  return !!r && r.x >= -1 && r.y >= -1 && r.x + r.w <= m.width + 1 && r.y + r.h <= m.height + 1;
}, i);
const lvl = (page) => page.evaluate(() => mkMap.world().li);
const corner = (page) => page.$eval('.mk-map', (e) => { const r = e.getBoundingClientRect(); return { x: r.left + 6, y: r.top + 6 }; });
const ctrlWheel = async (page, dy) => { await page.keyboard.down('Control'); await page.mouse.wheel(0, dy); await page.keyboard.up('Control'); await wait(page, 450); };
const setLayout = async (page, lay) => { await page.click('.layout-picker-trigger'); await page.click(`.layout-choice[data-layout="${lay}"]`); await wait(page, 500); await page.keyboard.press('Escape').catch(() => {}); };
// The zoom bar is hidden in this design; the map's own keys (+ − 0) drive the same zoomBy/resetCam.
const mapKey = async (page, key) => { await page.evaluate(() => document.querySelector('.mk-map').focus({ preventScroll: true })); await page.keyboard.press(key); await wait(page, 450); };
const resetZoom = async (page) => mapKey(page, '0');
// Click a live pane's title bar (left of its buttons) to make it the active one.
const clickHead = async (page, id, meta = false) => {
  const h = await page.$eval(`.mk-live .pane[data-id="${id}"] .pane-head`, (e) => { const r = e.getBoundingClientRect(); return { x: r.left + 30, y: r.top + r.height / 2 }; });
  if (meta) await page.keyboard.down('Meta');
  await page.mouse.click(h.x, h.y);
  if (meta) await page.keyboard.up('Meta');
  await wait(page, 250);
};
const liveIds = (page) => page.$$eval('.mk-live .pane:not(.mk-leaving)', (ps) => ps.map((p) => p.dataset.id));

for (const vp of [{ width: 1512, height: 945 }, { width: 1100, height: 650 }]) {
  const tag = `${vp.width}x${vp.height}`;
  const page = await browser.newPage({ viewport: vp });
  const errors = []; page.on('pageerror', (e) => errors.push(String(e))); page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(FILE); await wait(page, 800);
  await setLayout(page, 'grid');

  // 1a. One active pane, pointer in the far corner: zoom in all the way, then out.
  let ids = await liveIds(page);
  const target = ids.at(-1); await clickHead(page, target);
  const sel = (await page.evaluate(() => window._testMulti.state())).selected;
  ok(`${tag}: clicking a title bar makes that pane active`, sel === target, sel);
  const ti = await page.evaluate((id) => mkMap.indexOf(id), target);
  const c = await corner(page); await page.mouse.move(c.x, c.y);
  let allIn = true; let steps = 0;
  for (let k = 0, still = 0; k < 30 && still < 2; k++) {
    const before = await lvl(page); await ctrlWheel(page, -100);
    const after = await lvl(page); still = after === before ? still + 1 : 0; if (after !== before) steps++;
    if (!(await inView(page, ti))) allIn = false;
  }
  const w = await page.evaluate(() => mkMap.world());
  ok(`${tag}: zoom in with the pointer in the corner keeps the active pane on screen every step`, allIn && steps > 0, `${steps} steps, ${w.C}×${w.rv}`);
  ok(`${tag}: fully zoomed in shows the active pane, not the one under the pointer`, w.C === 1 && w.rv === 1 && (await inView(page, ti)) && ti !== 0, `active index ${ti}`);
  await page.screenshot({ path: `${SHOTS}/${vp.width}-single-in.png` });
  allIn = true;
  for (let k = 0, still = 0; k < 30 && still < 2; k++) { const before = await lvl(page); await ctrlWheel(page, 100); still = (await lvl(page)) === before ? still + 1 : 0; if (!(await inView(page, ti))) allIn = false; }
  ok(`${tag}: zoom back out keeps the active pane on screen`, allIn);

  // 1b. The + key follows the active pane too.
  await resetZoom(page); ids = await liveIds(page);
  const mid = ids[Math.floor(ids.length / 2)]; await clickHead(page, mid);
  const mi = await page.evaluate((id) => mkMap.indexOf(id), mid);
  for (let k = 0; k < 12; k++) await mapKey(page, '=');
  ok(`${tag}: the + key zooms toward the active pane`, (await inView(page, mi)) && (await page.evaluate(() => mkMap.world().C)) === 1, `index ${mi}`);

  // 1c. Active pane scrolled off screen: the next zoom brings it back.
  await resetZoom(page); ids = await liveIds(page);
  await clickHead(page, ids[0]);
  const fi = await page.evaluate((id) => mkMap.indexOf(id), ids[0]);
  await page.mouse.move(c.x, c.y);
  for (let k = 0; k < 4; k++) await ctrlWheel(page, -100);
  const rows = await page.evaluate(() => { const w = mkMap.world(); return { rows: w.rows, rv: w.rv }; });
  if (rows.rows > rows.rv) {
    for (let k = 0; k < 12 && (await inView(page, fi)); k++) { await page.mouse.wheel(0, 400); await wait(page, 350); }
    const gone = !(await inView(page, fi));
    await ctrlWheel(page, 100);
    ok(`${tag}: active pane scrolled away comes back on the next zoom`, gone && (await inView(page, fi)), `rows ${rows.rows}, visible ${rows.rv}`);
  } else ok(`${tag}: (skipped off-screen case, every row fits)`, true);

  // 1d. Two active panes (⌘-selected, first and last): both stay visible while they fit.
  await resetZoom(page); ids = await liveIds(page);
  await clickHead(page, ids[0]); await clickHead(page, ids.at(-1), true);
  const multi = (await page.evaluate(() => window._testMulti.state())).multi;
  ok(`${tag}: ⌘-click makes two panes active`, multi.length === 2, multi.join(','));
  const act = (await page.evaluate((m) => m.map((id) => mkMap.indexOf(id)).sort((a, b) => a - b), multi));
  // Park the pointer on the LAST active pane. While both fit, zoom keeps both on
  // screen; once they are locked to the edges, the pointer takes over, down to
  // one pane filling the area: the one under the pointer.
  const lr = await page.evaluate((i) => { const m = document.querySelector('.mk-map').getBoundingClientRect(); const r = mkMap.rectOf(i); return { x: m.left + r.x + r.w / 2, y: m.top + r.y + r.h / 2 }; }, act[1]);
  await page.mouse.move(lr.x, lr.y);
  const underPtr = () => page.evaluate((p) => { const m = document.querySelector('.mk-map').getBoundingClientRect(); const x = p.x - m.left; const y = p.y - m.top; for (let i = 0; i < mkMap.world().n; i++) { const r = mkMap.rectOf(i); if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return i; } return -1; }, lr);
  let fitOk = true; let sawFit = false; let sawPtr = false; let ptrOk = true; let ptrTarget = -1;
  for (let k = 0, still = 0; k < 31 && still < 2; k++) {
    if (k) {
      const pre = await underPtr(); const before = await lvl(page); await ctrlWheel(page, -100); const after = await lvl(page); still = after === before ? still + 1 : 0;
      if (ptrTarget < 0 && (await page.evaluate(() => mkMap.world().zoomBy)) === 'pointer') ptrTarget = pre;
    }
    const wv = await page.evaluate(() => mkMap.world());
    const r0 = Math.floor(act[0] / wv.C); const r1 = Math.floor(act[1] / wv.C);
    const both = (await inView(page, act[0])) && (await inView(page, act[1]));
    if (r1 - r0 < wv.rv) { sawFit = true; if (!both) fitOk = false; }
    else { sawPtr = true; if (wv.zoomBy !== 'pointer') ptrOk = false; }
  }
  const wEnd = await page.evaluate(() => mkMap.world());
  ok(`${tag}: both active panes stay on screen at every level where they fit`, fitOk && sawFit);
  ok(`${tag}: once they no longer fit, zoom follows the pointer`, sawPtr && ptrOk);
  ok(`${tag}: zooming on ends with one full pane, the one under the pointer when it took over`, ptrTarget >= 0 && wEnd.C === 1 && wEnd.rv === 1 && (await inView(page, ptrTarget)), `${wEnd.C}×${wEnd.rv}, pointer pane ${ptrTarget}`);
  await page.screenshot({ path: `${SHOTS}/${vp.width}-multi-in.png` });
  await page.keyboard.press('Escape'); await wait(page, 200);

  // 1e. Focus layout: the active pane is the pinned one, so the map zooms about its centre without errors.
  await resetZoom(page); await setLayout(page, 'left');
  const l0 = await lvl(page); const cm = await page.$eval('.mk-map', (e) => { const r = e.getBoundingClientRect(); return { x: r.left + 6, y: r.top + 6 }; });
  await page.mouse.move(cm.x, cm.y); await ctrlWheel(page, 100);
  ok(`${tag}: Focus layout still zooms the map with nothing active in it`, (await lvl(page)) !== l0 || (await page.evaluate(() => mkMap.world().li)) === 0);
  await setLayout(page, 'grid'); await resetZoom(page);

  // 2. Empty thread line: Send shakes, the empty thread flashes red, nothing is sent.
  // Start clean: Esc above keeps the old multi draft for the next selection by design.
  await page.click('#mk-reset'); await wait(page, 700); await setLayout(page, 'grid');
  ids = await liveIds(page);
  await clickHead(page, ids[0]); await clickHead(page, ids[1], true);
  const draft0 = await page.locator('#mk-input').inputValue();
  ok(`${tag}: selecting two panes puts two #thread lines in the composer`, draft0.trim().split('\n').length === 2, JSON.stringify(draft0));
  // Selecting leaves the caret after the first tag: real typing fills that line only.
  await page.keyboard.type('what is the status');
  const plan = await page.evaluate(() => window._testMulti.plan().plans.map((p) => ({ id: p.id, empty: !!p.noText })));
  const empties = plan.filter((p) => p.empty).map((p) => p.id);
  ok(`${tag}: typing right after selecting fills the first thread's line`, empties.length === 1 && empties[0] === ids[1] && !plan.find((p) => p.id === ids[0]).empty, JSON.stringify(plan));
  const sentBefore = JSON.stringify((await page.evaluate(() => window._testMulti.state())).sent);
  const send = page.locator('.round-send');
  ok(`${tag}: Send stays clickable when only a thread line is empty`, await send.isEnabled());
  await send.click(); await wait(page, 60);
  const flashed = await page.evaluate((empty) => ({
    shake: document.querySelector('.round-send').classList.contains('mk-send-shake'),
    pane: document.querySelector(`.pane[data-id="${empty}"]`)?.classList.contains('mk-empty-flash'),
    chip: [...document.querySelectorAll('#mk-shared .mk-thread-tag')].some((c) => c.dataset.threadId === empty && c.classList.contains('mk-empty-flash')),
    other: document.querySelector('.pane.mk-empty-flash:not([data-id="' + empty + '"])') !== null,
    say: document.getElementById('mk-empty-say')?.textContent || '',
  }), empties[0]);
  await page.screenshot({ path: `${SHOTS}/${vp.width}-empty-flash.png` });
  ok(`${tag}: Send shakes`, flashed.shake);
  ok(`${tag}: only the empty thread's pane and #tag flash red`, flashed.pane && flashed.chip && !flashed.other, JSON.stringify(flashed));
  ok(`${tag}: screen readers hear why it was not sent`, /Not sent/.test(flashed.say), flashed.say);
  const after = await page.evaluate(() => window._testMulti.state());
  ok(`${tag}: nothing was sent and the draft is kept`, JSON.stringify(after.sent) === sentBefore && after.draft.includes('what is the status'));
  ok(`${tag}: no blocking warning text is shown`, !(await page.locator('text=have no slice').count()));
  await wait(page, 1300);
  const cleared = await page.evaluate(() => !document.querySelector('.mk-send-shake, .mk-empty-flash'));
  ok(`${tag}: the shake and red flash end on their own`, cleared);

  ok(`${tag}: no page errors`, errors.length === 0, errors.join(' | '));
  await page.close();
}
await browser.close();
console.log(`${n - fails}/${n} PASS`);
process.exit(fails ? 1 : 0);
