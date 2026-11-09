import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import electron from 'electron';
import { createServer } from 'vite';
import { runElectronScenario } from './helpers/electron-test.mjs';

async function runFixture(query = '') {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-pane-map-'));
  const html = '<div id="root"></div><script type="module" src="/tests/helpers/pane-map-browser.jsx"></script>';
  const server = await createServer({ cacheDir: path.join(temp, 'vite-cache'), server: { port: 0 }, logLevel: 'error', plugins: [{
    name: 'pane-map-fixture',
    configureServer(vite) {
      vite.middlewares.use('/__pane_map', async (_request, response) => {
        response.setHeader('Content-Type', 'text/html');
        response.end(await vite.transformIndexHtml('/__pane_map', html));
      });
    },
  }] });
  try {
    await server.listen();
    const main = path.join(temp, 'main.cjs');
    const scenario = fs.readFileSync(new URL('./helpers/pane-map-electron.cjs', import.meta.url), 'utf8');
    fs.writeFileSync(main, `const fixtureUrl = ${JSON.stringify(`http://localhost:${server.httpServer.address().port}/__pane_map?${query || process.env.APEX_PANE_MAP_SCENARIO || ''}`)};\nconst screenshotDir = ${JSON.stringify(process.env.APEX_PANE_MAP_SCREENSHOTS || '')};\n${scenario}`);
    const result = await runElectronScenario(electron, main, temp, { timeoutMs: 80000, attempts: 1 });
    assert.equal(result.code, 0, result.output);
    const frames = result.output.match(/Focus compositor frames \d+/);
    if (frames) console.log(frames[0]);
  } finally {
    await server.close();
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

test('native PaneMap wheel, keys, scrolling, reveal and stable pane parents', { timeout: 180000 }, () => runFixture());

test('native PaneMap title drag reorders, cancels and excludes title buttons', { timeout: 120000 }, () => runFixture('drag-only'));

test('native PaneMap focus divider holds valid bounds under repeated keys', { timeout: 120000 }, () => runFixture('divider-only'));

test('native PaneMap reports panes actually inside the viewport', { timeout: 120000 }, () => runFixture('viewport-only'));

test('native PaneMap retires drags interrupted by section and geometry changes', { timeout: 120000 }, () => runFixture('interruptions-only'));

for (const scenario of ['popups', 'renders', 'keys', 'restore', 'drag-out', 'paint', 'reduced-pinned', 'focus-glide', 'divider-live', 'focus-interruptions']) {
  test(`PaneMap review regression: ${scenario}`, { timeout: 120000 }, () => runFixture('review=' + scenario));
}
