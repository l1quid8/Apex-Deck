import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import electron from 'electron';
import { createServer } from 'vite';
import { runElectronScenario } from './helpers/electron-test.mjs';
import { CHIP_STYLES } from '../src/botChip.ts';

// Catches a picker that only changes its preview, fails to save, or loses its choice on launch.
test('phone Settings previews chip styles and restores the selected style after reload', {timeout:120000}, async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'phone-chip-settings-'));
  const server = await createServer({cacheDir:path.join(temp,'cache'), server:{port:0}, logLevel:'error'});
  try {
    await server.listen();
    const main = path.join(temp,'main.cjs');
    fs.writeFileSync(main, `
      const {app,BrowserWindow}=require('electron'); const assert=require('node:assert/strict');
      app.whenReady().then(async()=>{try {
        const win=new BrowserWindow({show:false,width:393,height:852});
        const run=code=>win.webContents.executeJavaScript(code);
        const wait=async code=>{for(let i=0;i<400;i++){if(await run(code))return;await new Promise(r=>setTimeout(r,25));}throw Error('Timed out: '+code);};
        await win.loadURL('http://localhost:${server.httpServer.address().port}/phone.html');
        await wait('!!document.querySelector("button[aria-label=Settings]")');
        await run('document.querySelector("button[aria-label=Settings]").click()');
        await wait('!!document.querySelector(".ph-preference")');
        await run('[...document.querySelectorAll(".ph-preference")].find(b=>b.textContent.includes("Appearance")).click()');
        await wait('!!document.querySelector(".ph-appearance")');
        assert.equal(await run('!!document.querySelector("[role=radiogroup]")'),true,'Appearance contains chip controls');
        assert.equal(await run('document.querySelectorAll("[role=radio]").length'),${CHIP_STYLES.length});
        for(const {id,label:name} of ${JSON.stringify(CHIP_STYLES)}) {
          await run('([...document.querySelectorAll("[role=radio]")].find(b=>b.textContent.includes('+JSON.stringify(name)+'))).click()');
          await new Promise(r=>setTimeout(r,50));
          assert.equal(await run('document.querySelector("[role=radio][aria-checked=true]").textContent.replace("✓", "").trim()'),name);
          assert.equal(await run('document.querySelector(".ph-chip-preview [data-chip-style]").dataset.chipStyle'),id);
          assert.equal(await run('document.querySelector(".ph-app").dataset.chipStyle'),id,'selection updates the phone, not just the preview');
          assert.equal(await run('document.documentElement.scrollWidth <= innerWidth'),true,'no page overflow');
        }
        await run('[...document.querySelectorAll("[role=radio]")].find(b=>b.textContent.includes("Ticket")).click()');
        await new Promise(r=>setTimeout(r,50));
        await win.webContents.reload();
        await wait('document.querySelector(".ph-app")?.dataset.chipStyle === "ticket"');
        await run('document.querySelector("button[aria-label=Settings]").click()');
        await wait('!!document.querySelector(".ph-preference")');
        await run('[...document.querySelectorAll(".ph-preference")].find(b=>b.textContent.includes("Appearance")).click()');
        await wait('!!document.querySelector("[role=radio][aria-checked=true]")');
        assert.equal(await run('document.querySelector("[role=radio][aria-checked=true]").textContent.replace("✓", "").trim()'),'Ticket');
        win.destroy();app.exit(0);
      }catch(error){console.error(error.stack);app.exit(1);}});
    `);
    const result=await runElectronScenario(electron,main,temp,{attempts:1});
    assert.equal(result.code,0,result.output);
  } finally {await server.close();fs.rmSync(temp,{recursive:true,force:true});}
});
