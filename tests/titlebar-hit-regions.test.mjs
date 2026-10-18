import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import electron from 'electron';
import { createServer } from 'vite';
import { runElectronScenario } from './helpers/electron-test.mjs';

function readRegions() {
  const header = document.querySelector('.titlebar');
  const tabs = header.querySelector('.section-navigation');
  const end = header.querySelector('.titlebar-end');
  const rect = el => el.getBoundingClientRect().toJSON();
  return { header: rect(header), tabs: rect(tabs), end: rect(end), region: getComputedStyle(header).webkitAppRegion,
    buttons: [...tabs.querySelectorAll('button')].map(el => ({ label: el.textContent, rect: rect(el), region: getComputedStyle(el).webkitAppRegion })) };
}

// A later sibling's inherited drag rectangle wins over a tab's no-drag
// rectangle in Electron, even when the tab is visually above it (z-index).
// Exercise the real App layout; inspecting the button's CSS alone misses this.
test('the right toolbar drag region never covers the section switcher', { timeout: 200000 }, async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'titlebar-hit-regions-'));
  // Each parallel test file gets its own dependency cache: Vite servers sharing
  // node_modules/.vite race renaming deps_temp into deps (ENOTEMPTY), and the
  // loser's page never finishes loading.
  const server = await createServer({ cacheDir: path.join(temp, 'vite-cache'), server: { port: 0 }, logLevel: 'error' });
  await server.listen();
  const url = `http://localhost:${server.httpServer.address().port}/`;
  const main = path.join(temp, 'main.cjs');
  fs.writeFileSync(main, `
    const {app,BrowserWindow}=require('electron');
    const assert=require('node:assert/strict');
    app.whenReady().then(async()=>{
      const win=new BrowserWindow({show:false,width:1200,height:900,titleBarStyle:'hiddenInset',webPreferences:{contextIsolation:true,sandbox:true}});
      const run=code=>win.webContents.executeJavaScript(code);
      try {
        await win.loadURL(${JSON.stringify(url)});
        for(let i=0;i<200;i++){
          if(await run("!!document.querySelector('.titlebar')"))break;
          await new Promise(resolve=>setTimeout(resolve,20));
        }
        assert.equal(await run("!!document.querySelector('.titlebar')"),true,'App must render');
        for(const theme of ['plain','glass'])for(const width of [1200,1512,1051,1050,900]){
          win.setSize(width,900);
          await run('document.documentElement.dataset.deckTheme='+JSON.stringify(theme));
          await run('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
          const state=await run('('+${JSON.stringify(readRegions.toString())}+')()');
          const context=theme+' at '+width+'px: '+JSON.stringify(state);
          assert.ok(state.end.left>=state.tabs.right || state.end.top>=state.tabs.bottom || state.end.bottom<=state.tabs.top,
            'Later right-hand drag region overlaps section tabs: '+context);
          assert.equal(state.region,'drag','empty toolbar still drags: '+context);
          for(const button of state.buttons){
            assert.equal(button.region,'no-drag',button.label+': '+context);
            assert.ok(button.rect.left>=0 && button.rect.right<=width && button.rect.top>=0 && button.rect.bottom<=state.header.bottom,
              button.label+' fits the toolbar: '+context);
          }
        }
        console.log('Toolbar drag geometry passed in both themes at five native widths');
        app.exit(0);
      }catch(error){console.error(error.stack);app.exit(1);}
    });
  `);
  try {
    const result = await runElectronScenario(electron, main, temp);
    assert.equal(result.code, 0, result.output);
  } finally {
    await server.close();
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
