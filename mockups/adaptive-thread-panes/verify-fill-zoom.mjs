// Browser checks for the fill-rule zoom (2026-11-08). Real Ctrl+wheel and
// wheel events in headless Chrome; every number below is measured on the page.
//   node mockups/adaptive-thread-panes/verify-fill-zoom.mjs
import { chromium } from '/Users/tylercaldwell/Downloads/apex-deck/node_modules/playwright/index.mjs';
import fs from 'node:fs';
const FILE = 'file:///Users/tylercaldwell/Downloads/apex-deck/mockups/adaptive-thread-panes.html';
const SHOTS = '/tmp/jigga-fill'; fs.mkdirSync(SHOTS, { recursive: true });
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
let fails = 0; const ok = (name, cond, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`); if (!cond) fails++; };
const wait = (p, ms) => p.waitForTimeout(ms);

// What is on screen in the map, measured from the page.
const measure = (page) => page.evaluate(() => {
  const m = document.querySelector('.mk-map').getBoundingClientRect(); const w = mkMap.world(); const c = mkMap.cam();
  const vis = [];
  for (let i = 0; i < w.n; i++) { const r = mkMap.rectOf(i); if (r.y + r.h > 0.5 && r.y < m.height - 0.5) vis.push(r); }
  const cut = vis.filter((r) => r.y < -0.5 || r.y + r.h > m.height + 0.5 || r.x < -0.5 || r.x + r.w > m.width + 0.5).length;
  const left = Math.min(...vis.map((r) => r.x)); const right = Math.max(...vis.map((r) => r.x + r.w));
  const top = Math.min(...vis.map((r) => r.y)); const bottom = Math.max(...vis.map((r) => r.y + r.h));
  const live = [...document.querySelectorAll('.mk-live .pane')].filter((p) => !p.classList.contains('mk-leaving'));
  const heads = live.map((p) => Math.round(p.querySelector('.pane-head').getBoundingClientRect().height));
  const titles = [...document.querySelectorAll('.mk-live .pane .pane-title, .mk-ax-btn')].map((e) => e.textContent).join('|');
  return { nReal: w.nReal, C: w.C, rv: w.rv, rows: w.rows, li: w.li, d: w.d, n: w.n, y: c.y, z: c.z, mapW: m.width, mapH: m.height, vis: vis.length,
    paneW: Math.round(vis[0]?.w || 0), paneH: Math.round(vis[0]?.h || 0), cut, left, right, top, bottom, live: live.length, heads,
    synthetic: /Synthetic/.test(titles) || [...Array(w.n).keys()].some(() => false) };
});
const near = (a, b, t = 1.5) => Math.abs(a - b) <= t;
const edgeToEdge = (s) => near(s.left, 0) && near(s.right, s.mapW) && near(s.top, 0) && near(s.bottom, s.mapH);

for (const vp of [{ width: 1512, height: 945 }, { width: 1100, height: 650 }]) {
  const page = await browser.newPage({ viewport: vp });
  const errors = []; page.on('pageerror', (e) => errors.push(String(e))); page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  const reqs = []; page.on('request', (r) => { if (!/^(file|data|blob):/.test(r.url())) reqs.push(r.url()); });
  await page.goto(FILE); await wait(page, 800);
  for (const lay of ['left', 'grid', 'right']) {
    const tag = `${vp.width}x${vp.height} ${lay}`;
    await page.click('.layout-picker-trigger'); await page.click(`.layout-choice[data-layout="${lay}"]`); await wait(page, 600);
    await page.keyboard.press('Escape').catch(() => {});
    const levels = await page.evaluate(() => mkMap.levels());
    const box = await page.$eval('.mk-map', (e) => { const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
    const s0 = await measure(page);
    ok(`${tag}: 100% is the default level, edge to edge, nothing cut`, s0.li === s0.d && edgeToEdge(s0) && s0.cut === 0, `${s0.C}×${s0.rv} of ${s0.n}, pane ${s0.paneW}×${s0.paneH}, live ${s0.live}`);
    ok(`${tag}: no synthetic threads with the scale test off`, !s0.synthetic && s0.n === s0.nReal && s0.n <= 14, `n ${s0.n}, real ${s0.nReal}`);
    await page.screenshot({ path: `${SHOTS}/${vp.width}-${lay}-100.png` });
    // Zoom out one wheel notch at a time with real Ctrl+wheel, then all the way in.
    await page.mouse.move(box.x, box.y);
    const seen = [s0];
    for (const dir of [1, -1]) {
      for (let k = 0, still = 0; k < 30 && still < 3; k++) {
        const before = await page.evaluate(() => mkMap.world().li);
        await page.keyboard.down('Control'); await page.mouse.wheel(0, dir * 100); await page.keyboard.up('Control');
        await wait(page, 450);
        const s = await measure(page); seen.push(s);
        still = s.li === before ? still + 1 : 0;
      }
      const s = seen.at(-1);
      if (dir === 1) {
        ok(`${tag}: zoomed all the way out, every thread fits edge to edge`, s.li === 0 && s.vis === s.n && edgeToEdge(s) && s.cut === 0, `${s.C}×${s.rv}, pane ${s.paneW}×${s.paneH}`);
        await page.screenshot({ path: `${SHOTS}/${vp.width}-${lay}-out.png` });
      } else {
        ok(`${tag}: zoomed all the way in, one pane fills the area`, s.li === levels.length - 1 && s.vis === 1 && edgeToEdge(s) && s.live === 1, `pane ${s.paneW}×${s.paneH}`);
        await page.screenshot({ path: `${SHOTS}/${vp.width}-${lay}-in.png` });
      }
    }
    const bad = seen.filter((s) => !edgeToEdge(s) || s.cut);
    ok(`${tag}: every level stepped through is edge to edge with no cut panes`, bad.length === 0, `${seen.length} levels measured: ${[...new Set(seen.map((s) => `${s.C}×${s.rv}`))].join(' → ')}`);
    const sizes = [...new Map(seen.map((s) => [s.li, s])).values()].sort((a, b) => a.li - b.li);
    ok(`${tag}: zooming in always gives fewer, bigger panes`, sizes.every((s, i) => !i || (s.paneW * s.paneH > sizes[i - 1].paneW * sizes[i - 1].paneH && s.vis <= sizes[i - 1].vis)), sizes.map((s) => `${s.vis}@${s.paneW}×${s.paneH}`).join(' '));
    const firstLive = sizes.find((s) => s.live > 0);
    const cols = sizes.map((s) => s.C);
    ok(`${tag}: columns only go down as you zoom in`, cols.every((c, i) => !i || c <= cols[i - 1]), cols.join(' '));
    ok(`${tag}: each wheel notch moves at most one level`, seen.every((s, i) => !i || Math.abs(s.li - seen[i - 1].li) <= 1), seen.map((s) => s.li).join(' '));
    ok(`${tag}: real panes with the 28px bar appear as you zoom in`, !!firstLive && firstLive.heads.every((h) => h === 28), firstLive ? `from ${firstLive.vis} on screen (${firstLive.paneW}×${firstLive.paneH})` : 'never');
    // The glide: sample a pane halfway through a level change.
    await page.evaluate(() => mkMap._setZoom(1)); await wait(page, 500);
    const a = await page.evaluate(() => mkMap.rectOf(0));
    await page.keyboard.down('Control'); await page.mouse.wheel(0, 100); await page.keyboard.up('Control');
    await wait(page, 90); const mid = await page.evaluate(() => mkMap.rectOf(0)); await wait(page, 400); const b = await page.evaluate(() => mkMap.rectOf(0));
    const between = (v, p, q) => v > Math.min(p, q) + 1 && v < Math.max(p, q) - 1;
    ok(`${tag}: panes glide between levels`, between(mid.w, a.w, b.w) || between(mid.h, a.h, b.h), `width ${Math.round(a.w)} → ${Math.round(mid.w)} → ${Math.round(b.w)}`);
    // Scrolling: small trackpad steps move freely, then settle on a whole row.
    await page.evaluate(() => mkMap._setZoom(1)); await wait(page, 500);
    const s1 = await measure(page);
    if (s1.rows > s1.rv) {
      const y0 = s1.y; const stride = s1.paneH + 8;
      for (let k = 0; k < 10; k++) { await page.mouse.wheel(0, 8); await wait(page, 16); }
      const during = await page.evaluate(() => mkMap.cam().y);
      ok(`${tag}: ten 8px trackpad scrolls move the list freely`, near(during - y0, 80, 2), `y ${Math.round(y0)} → ${Math.round(during)} while scrolling`);
      await wait(page, 700); let s2 = await measure(page);
      ok(`${tag}: a short scroll settles back on the nearest whole row`, s2.cut === 0 && near(s2.top, 0) && near(s2.bottom, s2.mapH) && near(s2.y, Math.round((y0 + 80) / stride) * stride, 2), `settled y ${Math.round(s2.y)} (row ${Math.round(s2.y / stride)})`);
      for (let k = 0; k < 20; k++) { await page.mouse.wheel(0, 8); await wait(page, 16); }
      await wait(page, 700); s2 = await measure(page);
      ok(`${tag}: a longer trackpad scroll moves on and lands on a whole row`, s2.cut === 0 && near(s2.top, 0) && s2.y > y0, `y ${Math.round(y0)} → ${Math.round(s2.y)}`);
      await page.mouse.wheel(0, 260); await wait(page, 700); const s3 = await measure(page);
      ok(`${tag}: a bigger scroll also lands on whole rows`, s3.cut === 0 && near(s3.top, 0), `y ${Math.round(s3.y)}`);
    } else ok(`${tag}: everything fits at 100%, nothing to scroll`, true);
    // Back to the original layout.
    await page.click('#mk-reset'); await wait(page, 700);
    const s4 = await measure(page);
    ok(`${tag}: Reset returns to 100% at the top`, s4.li === s4.d && s4.y === 0 && edgeToEdge(s4), `${s4.C}×${s4.rv}`);
  }
  ok(`${vp.width}x${vp.height}: no page errors`, errors.length === 0, errors.slice(0, 3).join(' | '));
  ok(`${vp.width}x${vp.height}: no network requests`, reqs.length === 0, reqs.slice(0, 3).join(' '));
  await page.close();
}
await browser.close();
console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
process.exit(fails ? 1 : 0);
