import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import electron from 'electron';
import { createServer } from 'vite';
import { runElectronScenario } from './helpers/electron-test.mjs';

async function scenario(name) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-browser-map-'));
  const html = '<div id="root"></div><script type="module" src="/tests/helpers/browser-view-map.jsx"></script>';
  const server = await createServer({ cacheDir: path.join(temp, 'vite-cache'), server: { port: 0 }, logLevel: 'error', plugins: [{
    name: 'browser-view-map-fixture',
    configureServer(vite) {
      vite.middlewares.use('/__browser_map', async (_request, response) => {
        response.setHeader('Content-Type', 'text/html');
        response.end(await vite.transformIndexHtml('/__browser_map', html));
      });
    },
  }] });
  try {
    await server.listen();
    const main = path.join(temp, 'main.cjs');
    const script = fs.readFileSync(new URL('./helpers/browser-view-map-electron.cjs', import.meta.url), 'utf8');
    fs.writeFileSync(main, `const fixtureUrl = ${JSON.stringify(`http://localhost:${server.httpServer.address().port}/__browser_map?${name}`)};\n${script}`);
    const result = await runElectronScenario(electron, main, temp, { timeoutMs: 45000, attempts: 1 });
    assert.equal(result.code, 0, result.output);
  } finally {
    await server.close();
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

test('BrowserView snapshots a placeholder clipped by native map scrolling', { timeout: 60000 }, () => scenario('clipped'));
test('BrowserView follows only its nearest map moving attribute without waiting for fallback', { timeout: 60000 }, () => scenario('moving'));
test('BrowserView updates native bounds at the end of a position-only glide', { timeout: 60000 }, () => scenario('transition'));
test('BrowserView rechecks settled geometry on a map scrollend event', { timeout: 60000 }, () => scenario('scrollend'));
test('full-window Preview uses window geometry, keeps overlays, and restores the docked map guard', { timeout: 60000 }, () => scenario('full-window'));
