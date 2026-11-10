// Verifies ⌘-click multi-select with real mouse, keyboard and Ctrl+wheel (pinch) input:
// outline on every selected thread at every zoom step (live panes AND drawn pictures),
// "→ agent" on each selected title bar, the one-line To summary, routing safeguards
// (Null's spec: no substitution), and that Esc / × never delete what you typed.
// Runs Grid, Focus left and Focus right at 1512×945 and 1100×650.
// Run: node mockups/adaptive-thread-panes/verify-multi-select.mjs
import { chromium } from '../../node_modules/playwright/index.mjs';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const here = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(here, '..', 'adaptive-thread-panes.html'), 'utf8');
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
const results = [];
const ok = (name, cond, extra = '') => { results.push({ name, pass: !!cond }); console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ' ' + extra : ''}`); };
const wait = (p, ms) => p.waitForTimeout(ms);

const idNoMuck = 'pane-mw7h99uz-0';   // Multiple thread pane management: no Muck
const idHasMuck = 'pane-mv5vv0fh-0';  // t3 code: Muck + Null
const idHasMuck2 = 'pane-mvyq6vew-0'; // Delegate Refactor: Muck

async function run(vw, vh) {
  const tag = `[${vw}×${vh}]`;
  const page = await browser.newPage({ viewport: { width: vw, height: vh } });
  const errs = []; page.on('pageerror', (e) => errs.push(String(e)));
  await page.setContent(html, { waitUntil: 'load' }); await wait(page, 800);
  const input = '#mk-shared textarea';
  const val = () => page.$eval(input, (t) => t.value.replace(/⟦thread:[^⟧]*⟧/g,'').trim());
  const sendOff = () => page.$eval('#mk-shared .round-send', (b) => b.disabled);
  const multi = () => page.$$eval('.pane.mk-multi-selected', (x) => x.map((p) => p.dataset.id));
  const typeIn = async (text) => { const tags=await page.evaluate(()=>window._testMulti.state().multi.map(id=>'⟦thread:'+id+'⟧').join(' ')); const editor=page.locator('.mk-rich-input'); await (await editor.isVisible()?editor:page.locator(input)).fill(tags+' '+text); await wait(page,150); };
  // Real ⌘-click on a pane's title (brings it on screen first, the way a person would scroll to it).
  const cmdClick = async (id) => {
    const el = await page.$(`.pane[data-id="${id}"] .pane-title`);
    const b = el && await el.boundingBox();
    const inView = b && b.y >= 0 && b.y + b.height <= vh;
    // Off screen: ⌘-click its sidebar row instead, which also toggles it.
    const target = inView ? b : await (await page.$(`[data-pane-row="${id}"]`)).boundingBox();
    await page.keyboard.down('Meta'); await page.mouse.click(target.x + Math.min(40, target.width / 2), target.y + target.height / 2); await page.keyboard.up('Meta'); await wait(page, 200);
  };
  const plainClick = async (id) => { const b = await (await page.$(`.pane[data-id="${id}"] .pane-title`)).boundingBox(); await page.mouse.click(b.x + 4, b.y + b.height / 2); await wait(page, 200); };
  const resetSel = async () => { await page.keyboard.press('Escape'); await page.keyboard.press('Escape'); await wait(page, 150); };
  // The thread being written to when nothing is multi-selected.
  const focused = () => page.$eval('.pane.focused', (p) => p.dataset.id).catch(() => null);

  // ---- 1. Selecting
  ok(`${tag} starts with no outline`, (await multi()).length === 0);
  const first = await focused();
  const other = [idHasMuck, idHasMuck2, idNoMuck].find((x) => x !== first);
  await cmdClick(other);
  const selectedIds=await page.evaluate(()=>window._testMulti.state().multi);
  ok(`${tag} ⌘-click selects two panes`, selectedIds.length===2&&selectedIds.includes(first)&&selectedIds.includes(other), JSON.stringify(selectedIds));

  // ---- 2. Recipients visible before Send
  const routes = await page.$$eval('.pane.mk-multi-selected .pane-head .mk-route', (x) => x.map((e) => ({ t: e.textContent, w: e.getBoundingClientRect().width })));
  ok(`${tag} every selected title bar shows "→ agent"`, routes.length === (await multi()).length && routes.length>0 && routes.every((r) => /^→ \S/.test(r.t) && r.w > 10), JSON.stringify(routes));
  ok(`${tag} unselected panes show no route tag`, (await page.$$('.pane:not(.mk-multi-selected) .mk-route')).length === 0);
  const line = await page.$eval('.mk-to-count', (e) => e.textContent);
  ok(`${tag} To line is one line with one ▾`, (line.match(/[▾▴]/g) || []).length === 1 && /2 threads/.test(line), JSON.stringify(line));
  // 2026-11-08: empty thread lines no longer grey Send out; the click fails loudly instead (shake + red flash, nothing sent).
  const sent0 = JSON.stringify((await page.evaluate(() => window._testMulti.state())).sent);
  const offEmpty = await sendOff();
  if (!offEmpty) { await page.click('#mk-shared .round-send'); await wait(page, 60); }
  const shook = await page.$eval('#mk-shared .round-send', (b) => b.classList.contains('mk-send-shake'));
  const sent1 = JSON.stringify((await page.evaluate(() => window._testMulti.state())).sent);
  ok(`${tag} selection inserts chips; Send with empty lines shakes and sends nothing`, (await page.$$('.mk-thread-tag')).length===2 && !offEmpty && shook && sent0 === sent1 && (await page.$$('.mk-thread-tag')).length===2);
  await page.click('.mk-to-count'); await wait(page, 150);
  const rows = await page.$$eval('.mk-multi-row', (r) => r.map((x) => x.querySelector('.mk-mr-agent').textContent));
  ok(`${tag} expanded list: one row per thread with last @`, rows.length === 2 && rows.every((t) => /→ .+\(last @\)/.test(t)), JSON.stringify(rows));
  await page.click('.mk-to-count'); await wait(page, 150);

  // ---- 3. Routing safeguards
  await typeIn('email t@example.com the notes');
  ok(`${tag} an email address doesn't block Send`, (await sendOff()) === false);
  await cmdClick(idNoMuck === first || idNoMuck === other ? idHasMuck2 : idNoMuck);
  await typeIn('@muck review this');
  await page.click('.mk-to-count'); await wait(page, 150);
  const badRows = await page.$$eval('.mk-multi-row.mk-bad', (r) => r.map((x) => x.textContent));
  // Reveal the flagged thread from the list, then its own title bar must say so too.
  await page.click('.mk-multi-row.mk-bad .mk-mr-title'); await wait(page, 900);
  const badTag = await page.$eval(`.pane[data-id="${idNoMuck}"] .mk-route`, (e) => e.textContent).catch(() => 'missing');
  ok(`${tag} @muck flags the thread without Muck, in the list and on its title bar`, badRows.length === 1 && /isn't in this thread/.test(badRows[0]) && badTag === 'no @muck', JSON.stringify({ badRows, badTag }));
  await page.click('.mk-to-count'); await wait(page, 150);
  ok(`${tag} Send blocked while a thread lacks @muck`, (await sendOff()) === true);
  ok(`${tag} warning says why`, /isn't in/.test(await page.$eval('.mk-multi-hint', (e) => e.textContent).catch(() => '')));
  await page.click('.mk-to-count'); await wait(page, 150);
  const xs = await page.$$('.mk-multi-row.mk-bad .mk-mr-x');
  for (const x of xs) { await x.click(); await wait(page, 150); }
  const left = (await multi()).length;
  if (left >= 2) ok(`${tag} removing the flagged thread unblocks Send`, (await sendOff()) === false);
  ok(`${tag} text survives removing threads with ×`, /@muck review this/.test(await val()), JSON.stringify(await val()));

  // ---- 4. Esc keeps the text
  await resetSel();
  await cmdClick(other === idHasMuck ? idHasMuck2 : idHasMuck);
  if ((await multi()).length < 2) await cmdClick(idNoMuck);
  await typeIn('review this please');
  await page.keyboard.press('Escape'); await wait(page, 200);
  ok(`${tag} Esc clears the selection`, (await multi()).length === 0);
  const single = await val();
  ok(`${tag} Esc doesn't put the text into one thread`, single !== 'review this please', JSON.stringify(single));
  await cmdClick((await focused()) === idHasMuck ? idHasMuck2 : idHasMuck);
  ok(`${tag} text comes back on the next multi-select`, (await val()) === 'review this please', JSON.stringify(await val()));
  // Plain click inside the selection keeps it; plain click outside clears it but keeps the text.
  const sel = await multi();
  const inSel = await page.$$eval('.pane.mk-multi-selected:not(.focused)', (ps) => ps.filter((p) => { const r = p.getBoundingClientRect(); return r.top >= 0 && r.top + 28 <= innerHeight; }).map((p) => p.dataset.id));
  await plainClick(inSel[0] || sel[0]);
  ok(`${tag} plain click inside the selection keeps it`, (await multi()).length === sel.length);
  ok(`${tag} single-thread draft was not copied in`, (await val()) === 'review this please');

  // ---- 5. Outline at every zoom step, every layout (real Ctrl+wheel = pinch)
  for (const lay of ['grid', 'left', 'right']) {
    await resetSel();
    await page.click('.layout-picker-trigger'); await page.click(`.layout-choice[data-layout="${lay}"]`); await wait(page, 700);
    const pre = await page.$eval('.mk-to-count', (e) => e.textContent).catch(() => 'none');
    ok(`${tag} ${lay}: starts with no selection`, pre === 'none', pre);
    const pick = await page.$$eval('.pane:not(.focused):not(.mk-syn)', (ps) => ps.filter((p) => { const r = p.getBoundingClientRect(); return r.width > 150 && r.top >= 0 && r.bottom <= innerHeight; }).map((p) => p.dataset.id).slice(0, 2));
    for (const id of pick) await cmdClick(id);
    // At maximum zoom the compact Focus layouts fall back to Grid and may
    // have no fully visible nonfocused pane. Select through the sidebar,
    // as a user would, rather than testing outlines with an empty selection.
    if (!pick.length) {
      const current = await focused();
      const id = [idHasMuck, idNoMuck, idHasMuck2].find((id) => id !== current);
      await page.locator(`[data-pane-row="${id}"]`).click({modifiers:['Meta']});
      await wait(page, 200);
    }
    const want = await page.evaluate(() => [...document.querySelectorAll('.mk-sidebar .mk-multi-selected, [data-pane-row].mk-multi-selected')].map((r) => r.dataset.paneRow));
    const line1 = await page.$eval('.mk-to-count', (e) => e.textContent).catch(() => '');
    let bad = []; let steps = 0; let pictureSteps = 0;
    const check = async (dir) => {
      for (let k = 0; k < 16; k++) {
        await page.mouse.move(vw / 2, vh / 2);
        await page.keyboard.down('Control'); await page.mouse.wheel(0, dir * 100); await page.keyboard.up('Control'); await wait(page, 450);
        steps++;
        const r = await page.evaluate((want) => {
          const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
          const out = [];
          let pictures = 0;
          for (const id of want) {
            const p = document.querySelector(`.pane[data-id="${id}"]`);
            const pr = p && p.getBoundingClientRect();
            const host = document.querySelector('.mk-grid').getBoundingClientRect();
            if (p && p.isConnected && pr.width > 0 && !p.classList.contains('mk-tile')) {
              const vis = pr.right > host.left && pr.left < host.right && pr.bottom > host.top && pr.top < host.bottom;
              if (vis && !p.classList.contains('mk-multi-selected')) out.push(id + ':live-no-outline');
              continue;
            }
            // Drawn as a picture on the map canvas: sample its edge for the accent stroke.
            const i = window.mkMap.indexOf(id); const rc = i >= 0 && window.mkMap.rectOf(i);
            if (!rc) continue;
            const cv = document.querySelector('.mk-map-cv');
            if (!cv || !cv.isConnected) { out.push(id + ':no-canvas'); continue; }
            const b = cv.getBoundingClientRect(); const k2 = cv.width / b.width;
            const sx = b.left + rc.x; const sy = b.top + rc.y;
            if (rc.x + rc.w < 0 || rc.x > b.width || rc.y + rc.h / 2 < 0 || rc.y + rc.h / 2 > b.height) continue;
            pictures++;
            const ctx = cv.getContext('2d');
            const d = ctx.getImageData(Math.max(0, Math.round((sx - b.left - 3) * k2)), Math.max(0, Math.round((sy - b.top + rc.h / 2) * k2)), Math.round(8 * k2), 1).data;
            let hit = false;
            for (let j = 0; j < d.length; j += 4) if (d[j] > 150 && d[j] - d[j + 2] > 50) hit = true;
            if (!hit) out.push(id + ':picture-no-outline');
          }
          return { out, pictures, accent };
        }, want);
        bad.push(...r.out); pictureSteps += r.pictures ? 1 : 0;
      }
    };
    await check(1); await check(-1);
    ok(`${tag} ${lay}: outline on every visible selected thread at every zoom step`, bad.length === 0, `${steps} steps, ${pictureSteps} with pictures ${bad.length ? JSON.stringify([...new Set(bad)].slice(0, 6)) : ''}`);
    const line2 = await page.$eval('.mk-to-count', (e) => e.textContent).catch(() => '');
    ok(`${tag} ${lay}: selection unchanged by zooming`, want.length >= 2 && line2 === line1 && line1.includes(`${want.length} threads`), JSON.stringify(line2));
  }

  // ---- 6. Send clears the text
  await page.click('.layout-picker-trigger'); await page.click('.layout-choice[data-layout="grid"]'); await wait(page, 700);
  await typeIn('ship it');
  if (!(await sendOff())) {
    await page.click('#mk-shared .round-send'); await wait(page, 100);
    await wait(page, 300);
    ok(`${tag} Send empties the multi draft`, (await val()) === '');
  }
  ok(`${tag} no page errors`, errs.length === 0, errs.join(' | '));
  await page.close();
}

await run(1512, 945);
await run(1100, 650);
await browser.close();
const fails = results.filter((r) => !r.pass);
console.log(`\n${results.length - fails.length}/${results.length} checks passed`);
if (fails.length) { console.error('Failed:', fails.map((f) => f.name).join('\n  ')); process.exit(1); }
