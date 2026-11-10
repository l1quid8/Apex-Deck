import { chromium } from 'playwright-core';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const screenshots = path.join(here, 'screenshots');
const baseUrl = 'http://127.0.0.1:8767/';
const results = [];
const requests = [];
const errors = [];
let browser;
let page;

async function check(name, fn) {
  try {
    const details = await fn();
    results.push({ name, status: 'passed', ...(details === undefined ? {} : { details }) });
  } catch (error) {
    results.push({ name, status: 'failed', error: String(error?.stack || error) });
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function countPanes() {
  return page.locator('#pane-grid > .pane').count();
}

async function selectByTitle(title) {
  const row = page.locator('.thread-row').filter({ has: page.locator('.thread-row-title', { hasText: title }) }).first();
  await row.click();
  await page.waitForTimeout(80);
}

async function screenshot(name, width, height) {
  await page.setViewportSize({ width, height });
  await page.waitForTimeout(180);
  const file = path.join(screenshots, `${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  return { name: `${width}x${height}`, file: path.relative(here, file) };
}

await fs.mkdir(screenshots, { recursive: true });
browser = await chromium.launch({ headless: true });
page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
page.on('request', (request) => requests.push(request.url()));
page.on('pageerror', (error) => errors.push(String(error)));
page.on('console', (message) => { if (message.type() === 'error') errors.push(`console: ${message.text()}`); });

try {
  await page.goto(baseUrl, { waitUntil: 'networkidle' });

  const snapshot = await page.evaluate(() => ({
    threads: window.THREAD_SNAPSHOT.threads.map(({ id, title, closed, open }) => ({ id, title, closed, open })),
    focusedId: window.THREAD_SNAPSHOT.focusedId,
  }));
  await check('snapshot identity and 14/4 counts', async () => {
    const historyCount = await countPanes();
    assert(snapshot.threads.length === 14, `fixture has ${snapshot.threads.length} threads; expected 14`);
    assert(new Set(snapshot.threads.map((thread) => thread.id)).size === 14, 'thread IDs are not unique');
    assert(historyCount === 14, `history renders ${historyCount} panes; expected 14`);
    await page.locator('#dataset').selectOption('open');
    const openCount = await countPanes();
    assert(openCount === 4, `open dataset renders ${openCount} panes; expected 4`);
    assert(snapshot.threads.filter((thread) => thread.open !== false).length === 4, 'fixture open flags do not total 4');
    await page.locator('#dataset').selectOption('history');
    return { threadIds: snapshot.threads.map((thread) => thread.id), titles: snapshot.threads.map((thread) => thread.title), historyCount, openCount, focusedId: snapshot.focusedId };
  });

  await check('closed threads visibly distinguished as archived', async () => {
    const archivedCount = snapshot.threads.filter((thread) => thread.closed).length;
    const visibleArchived = await page.locator('.thread-row-meta', { hasText: 'Archived ·' }).count();
    const archivedPanes = await page.locator('.pane-meta', { hasText: 'Archived snapshot' }).count();
    assert(archivedCount === 10, `fixture marks ${archivedCount} closed; expected 10`);
    assert(visibleArchived === archivedCount, `sidebar labels ${visibleArchived}/${archivedCount} archived threads`);
    assert(archivedPanes >= 1, 'no pane marks its archived snapshot state');
    return { archivedCount, visibleArchived, archivedPanes };
  });

  await check('draft remains attached to its thread through selection, modes, filter, dataset and layout', async () => {
    await page.locator('#reset').click();
    await page.locator('#dataset').selectOption('history');
    await selectByTitle('Multiple thread pane management');
    await page.locator('#shared-draft').fill('draft A stays with management thread');
    await selectByTitle('t3 code');
    await page.locator('#shared-draft').fill('draft B stays with t3');
    await selectByTitle('Multiple thread pane management');
    assert(await page.locator('#shared-draft').inputValue() === 'draft A stays with management thread', 'shared composer did not restore draft A');
    await page.locator('#composer-mode').selectOption('per-pane');
    const a = page.locator('.pane[data-thread-id="pane-mw7h99uz-0"] .pane-draft');
    await page.locator('#layout-mode').selectOption('grid');
    await page.locator('#columns').selectOption('3');
    await page.locator('#search').fill('Muck');
    await page.waitForTimeout(100);
    assert(await page.locator('#destination').innerText().then((text) => text.includes('Multiple thread pane management')), 'filter silently retargeted composer destination');
    assert(await page.locator('.pane[data-thread-id="pane-mw7h99uz-0"]').count() === 0, 'Muck filter unexpectedly shows the management pane');
    await page.locator('#search').fill('');
    assert(await a.inputValue() === 'draft A stays with management thread', 'filter or layout change lost draft A');
    await page.locator('#dataset').selectOption('open');
    assert(await page.locator('#destination').innerText().then((text) => text.includes('Multiple thread pane management')), 'dataset change retargeted shared destination');
    await page.locator('#dataset').selectOption('history');
    await page.locator('#composer-mode').selectOption('shared');
    assert(await page.locator('#shared-draft').inputValue() === 'draft A stays with management thread', 'return to shared mode lost draft A');
    await selectByTitle('t3 code');
    assert(await page.locator('#shared-draft').inputValue() === 'draft B stays with t3', 'draft B did not survive cross-mode transitions');
    return { selectedDuringFilteredDataset: 'Multiple thread pane management', draftsRestored: ['A', 'B'] };
  });

  await check('preview send is local-only and does not issue requests', async () => {
    await page.locator('#reset').click();
    await selectByTitle('t3 code');
    await page.locator('#composer-mode').selectOption('shared');
    await page.locator('#shared-draft').fill('local preview only marker');
    const before = requests.length;
    await page.locator('#preview-send').click();
    await page.waitForTimeout(100);
    const after = requests.length;
    assert(await page.locator('#feedback').innerText().then((text) => text.includes('Nothing was sent')), 'preview feedback does not state nothing was sent');
    assert(await page.locator('.preview-message').filter({ hasText: 'local preview only marker' }).count() === 1, 'local preview message is missing');
    assert(before === after, `Preview send caused ${after - before} network requests`);
    return { requestsBefore: before, requestsAfter: after, localPreviewFound: true };
  });

  await check('layout uses discrete columns and focus spans', async () => {
    await page.locator('#reset').click();
    await page.locator('#search').fill('');
    await page.locator('#dataset').selectOption('history');
    await page.locator('#layout-mode').selectOption('grid');
    await page.locator('#columns').selectOption('3');
    const gridState = await page.locator('#pane-grid').evaluate((el) => ({ columns: getComputedStyle(el).gridTemplateColumns, requested: el.style.getPropertyValue('--requested-columns'), actual: el.style.getPropertyValue('--actual-columns') }));
    assert(gridState.requested === '3', `requested columns is ${gridState.requested}`);
    await page.locator('#layout-mode').selectOption('focus');
    const selected = page.locator('.pane.selected');
    const selectedGridColumn = await selected.evaluate((el) => getComputedStyle(el).gridColumn);
    assert(selectedGridColumn.includes('span 2'), `focus pane is not spanning two columns (${selectedGridColumn})`);
    await page.locator('#columns').selectOption('1');
    const oneColumnTracks = await page.locator('#pane-grid').evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').filter(Boolean).length);
    assert(oneColumnTracks === 1, `one-column mode computes ${oneColumnTracks} tracks`);
    return { gridState, focusGridColumn: selectedGridColumn, oneColumnTracks };
  });

  await check('Escape cancels drag without changing pane order', async () => {
    await page.locator('#reset').click();
    await page.locator('#layout-mode').selectOption('grid');
    const before = await page.locator('.pane').evaluateAll((nodes) => nodes.map((node) => node.dataset.threadId));
    const handle = page.locator('.pane').first().locator('.pane-drag');
    const box = await handle.boundingBox();
    assert(box, 'drag handle has no visible box');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 8, box.y + box.height / 2 + 8, { steps: 2 });
    await page.keyboard.press('Escape');
    await page.mouse.up();
    const after = await page.locator('.pane').evaluateAll((nodes) => nodes.map((node) => node.dataset.threadId));
    assert(JSON.stringify(before) === JSON.stringify(after), 'Escape changed the order');
    assert(await page.locator('.snap-preview').count() === 0, 'drag ghost remains after Escape');
    return { orderPreserved: true, ghostRemoved: true };
  });

  await check('dropping outside the grid cancels the drag', async () => {
    await page.locator('#reset').click();
    await page.locator('#layout-mode').selectOption('grid');
    const before = await page.locator('.pane').evaluateAll((nodes) => nodes.map((node) => node.dataset.threadId));
    const handle = page.locator('.pane').first().locator('.pane-drag');
    const box = await handle.boundingBox();
    const grid = await page.locator('#pane-grid').boundingBox();
    assert(box && grid, 'drag handle or grid has no visible box');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(grid.x - 45, grid.y - 45, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(80);
    const after = await page.locator('.pane').evaluateAll((nodes) => nodes.map((node) => node.dataset.threadId));
    assert(JSON.stringify(before) === JSON.stringify(after), 'outside-grid drop committed a reorder');
    return { orderPreserved: true };
  });

  await check('keyboard movement reorders the pane and leaves focus in its controls', async () => {
    await page.locator('#reset').click();
    await page.locator('#layout-mode').selectOption('grid');
    const pane = page.locator('.pane').first();
    const id = await pane.getAttribute('data-thread-id');
    const before = await page.locator('.pane').evaluateAll((nodes) => nodes.map((node) => node.dataset.threadId));
    await pane.locator('.pane-drag').focus();
    await page.keyboard.press('Alt+ArrowRight');
    await page.waitForTimeout(80);
    const after = await page.locator('.pane').evaluateAll((nodes) => nodes.map((node) => node.dataset.threadId));
    const active = await page.evaluate(() => ({ tag: document.activeElement?.tagName, aria: document.activeElement?.getAttribute('aria-label') }));
    assert(JSON.stringify(before) !== JSON.stringify(after) && after.indexOf(id) > before.indexOf(id), 'Alt+Right did not move the first pane later');
    assert(active.tag === 'BUTTON' && active.aria?.startsWith('Move '), `focus was not restored to pane controls: ${JSON.stringify(active)}`);
    return { movedId: id, active };
  });

  await check('pointer drag reorders panes when dropped on a valid target', async () => {
    await page.locator('#reset').click();
    await page.locator('#layout-mode').selectOption('grid');
    const before = await page.locator('.pane').evaluateAll((nodes) => nodes.map((node) => node.dataset.threadId));
    const first = page.locator('.pane').nth(0).locator('.pane-drag');
    const target = page.locator('.pane').nth(1);
    const from = await first.boundingBox();
    const to = await target.boundingBox();
    assert(from && to, 'drag source or target has no visible box');
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(to.x + to.width * 0.8, to.y + to.height / 2, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(100);
    const after = await page.locator('.pane').evaluateAll((nodes) => nodes.map((node) => node.dataset.threadId));
    assert(JSON.stringify(before) !== JSON.stringify(after), 'pointer drop did not change pane order');
    return { before: before.slice(0, 4), after: after.slice(0, 4) };
  });

  const shotResults = [];
  for (const [name, width, height] of [
    ['1440x900', 1440, 900], ['1100x700', 1100, 700], ['800x600', 800, 600],
    ['390x844', 390, 844], ['wide-shallow', 1600, 440],
  ]) {
    shotResults.push(await screenshot(name, width, height));
  }
  await check('responsive viewports have no horizontal page overflow', async () => {
    const measurements = [];
    for (const [name, width, height] of [
      ['1440x900', 1440, 900], ['1100x700', 1100, 700], ['800x600', 800, 600],
      ['390x844', 390, 844], ['wide-shallow', 1600, 440],
    ]) {
      await page.setViewportSize({ width, height });
      await page.waitForTimeout(100);
      const dims = await page.evaluate(() => ({ innerWidth, clientWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth, bodyScrollWidth: document.body.scrollWidth }));
      measurements.push({ name, ...dims });
      assert(dims.scrollWidth <= dims.clientWidth + 1 && dims.bodyScrollWidth <= width + 1, `${name} overflows horizontally: ${JSON.stringify(dims)}`);
    }
    return measurements;
  });

  await check('local static requests only; no page or console errors', async () => {
    const nonLocal = requests.filter((url) => !url.startsWith('http://127.0.0.1:8767/'));
    assert(nonLocal.length === 0, `non-local requests: ${nonLocal.join(', ')}`);
    assert(errors.length === 0, errors.join('\n'));
    return { requestUrls: requests, errors };
  });

  await fs.writeFile(path.join(here, 'verification.json'), JSON.stringify({
    verifiedAt: new Date().toISOString(),
    url: baseUrl,
    browser: 'Chromium headless via playwright-core',
    screenshots: shotResults,
    checks: results,
    networkRequests: requests,
    runtimeErrors: errors,
    summary: { passed: results.filter((result) => result.status === 'passed').length, failed: results.filter((result) => result.status === 'failed').length },
  }, null, 2) + '\n');
} finally {
  await browser?.close();
}

const failed = results.filter((result) => result.status === 'failed');
console.log(JSON.stringify({ passed: results.length - failed.length, failed: failed.length, failures: failed.map(({ name, error }) => ({ name, error })), verification: path.join(here, 'verification.json') }, null, 2));
if (failed.length) process.exitCode = 1;
