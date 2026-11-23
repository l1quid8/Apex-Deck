import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import electron from 'electron';
import {createServer} from 'vite';
import {runElectronScenario} from './helpers/electron-test.mjs';

for (const [name, query] of [
  ['phone Git controls recover a pending wait on reopen, cancel, and request a fix once', ''],
  ['phone reply suggestions share the Host setting, decisions, and active merge across modes', '?suggestions'],
  ['phone agent suggestions work on connections without native Git actions', '?suggestions&textOnly'],
]) test(name, {timeout:90000}, async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'phone-thread-git-'));
  const server = await createServer({cacheDir:path.join(temp,'cache'), server:{port:0}, logLevel:'error'});
  try {
    await server.listen();
    const url = new URL('/tests/fixtures/phone-thread-git.html'+query, server.resolvedUrls.local[0]);
    const main = path.join(temp, 'main.cjs');
    await fs.writeFile(main, `
      const {app, BrowserWindow} = require('electron');
      app.whenReady().then(async () => {
        const win = new BrowserWindow({show:false,width:393,height:852,webPreferences:{backgroundThrottling:false}});
        await win.loadURL(${JSON.stringify(url.href)});
        for(let i=0;i<400;i++) {
          const result = await win.webContents.executeJavaScript("document.querySelector('#result')?.textContent");
          if(result) { console.log(result); app.exit(result==='PASS'?0:1); return; }
          await new Promise(resolve => setTimeout(resolve,50));
        }
        app.exit(1);
      }).catch(error => { console.error(error); app.exit(1); });
    `);
    const result = await runElectronScenario(electron,main,temp,{attempts:1});
    assert.equal(result.code,0,result.output);
  } finally {
    await server.close();
    await fs.rm(temp,{recursive:true,force:true});
  }
});
