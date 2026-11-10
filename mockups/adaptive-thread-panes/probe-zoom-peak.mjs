// Probe: at +1B synthetic threads, zoom from Fit toward a point down to 100%, recording what every frame draws.
import { chromium } from '/Users/tylercaldwell/Downloads/apex-deck/node_modules/playwright/index.mjs';
const FILE = 'file:///Users/tylercaldwell/Downloads/apex-deck/mockups/adaptive-thread-panes.html';
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1512, height: 945 } });
const errors = []; page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(FILE); await page.waitForTimeout(700);
await page.click('.mk-scale-btn'); await page.click('.mk-scale-menu button:has-text("+1,000,000,000")'); await page.waitForTimeout(1400);
const m = await page.$eval('.mk-map', (el) => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
for (const [label, fx, fy] of [['centre', 0.5, 0.5], ['top-left', 0.15, 0.12], ['lower-right', 0.8, 0.85]]) {
  await page.click('.mk-mapbar button[data-act="fit"]'); await page.waitForTimeout(1200);
  await page.evaluate(() => { window.__pk = { drawn: 0, zAt: 0, minBudget: 30000, zBudget: 0, frames: 0, hits: 0 }; const loop = () => { const s = mkMap.stats(); if (s) { const d = s.cards + s.chips + s.blocks; const z = mkMap.cam().z; __pk.frames++; if (d > __pk.drawn) { __pk.drawn = d; __pk.zAt = z; } if (s.budget < __pk.minBudget) { __pk.minBudget = s.budget; __pk.zBudget = z; } if (s.budget <= 0) __pk.hits++; } if (!window.__stop) requestAnimationFrame(loop); }; window.__stop = false; loop(); });
  await page.mouse.move(m.x + m.w * fx, m.y + m.h * fy);
  let z = 0; let steps = 0;
  await page.keyboard.down('Control');
  while (steps < 4000) { await page.mouse.wheel(0, -4); await page.waitForTimeout(18); steps++; if (steps % 20 === 0) { z = (await page.evaluate(() => mkMap.cam().z)); if (z >= 0.999) break; } }
  await page.keyboard.up('Control'); await page.waitForTimeout(400);
  const pk = await page.evaluate(() => { window.__stop = true; return window.__pk; });
  console.log(`${label}: ${steps} wheel steps to z=${z.toFixed(3)}; ${pk.frames} frames; peak drawn ${pk.drawn} at z=${pk.zAt.toExponential(2)}; lowest budget left ${pk.minBudget} at z=${pk.zBudget.toExponential(2)}; frames that hit the limit: ${pk.hits}`);
}
console.log('page errors:', errors.length ? errors.join(' | ') : 'none');
await browser.close();
