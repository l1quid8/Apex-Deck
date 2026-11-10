import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import electron from 'electron';
import { createServer } from 'vite';
import { runElectronScenario } from './helpers/electron-test.mjs';

test('Focus BrowserView stays live through native side scroll and snapshots actual Focus motion', { timeout: 60000 }, async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-browser-focus-map-'));
  const html = '<div id="root"></div><script type="module" src="/tests/helpers/browser-view-focus-map.jsx"></script>';
  const server = await createServer({ cacheDir: path.join(temp, 'vite-cache'), server: { port: 0 }, logLevel: 'error', plugins: [{
    name: 'browser-view-focus-map-fixture',
    configureServer(vite) {
      vite.middlewares.use('/__browser_focus_map', async (_request, response) => {
        response.setHeader('Content-Type', 'text/html');
        response.end(await vite.transformIndexHtml('/__browser_focus_map', html));
      });
    },
  }] });
  try {
    await server.listen();
    const main = path.join(temp, 'main.cjs');
    const script = fs.readFileSync(new URL('./helpers/browser-view-focus-map-electron.cjs', import.meta.url), 'utf8');
    fs.writeFileSync(main, `const fixtureUrl = ${JSON.stringify(`http://localhost:${server.httpServer.address().port}/__browser_focus_map`)};\n${script}`);
    const result = await runElectronScenario(electron, main, temp, { timeoutMs: 45000, attempts: 1 });
    assert.equal(result.code, 0, result.output);
  } finally {
    await server.close();
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
