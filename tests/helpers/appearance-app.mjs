import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createServer } from 'vite';
import { runElectronScenario } from './electron-test.mjs';

const electronBinary = createRequire(import.meta.url)('electron');

/** Run `scenario` (source text for the body of an async function) against the
 *  real App in Electron. With no preload, App uses its browser demo backend,
 *  whose settings file is localStorage. Inside the scenario: win, run(code),
 *  frame(), size(w, h), seed(settings), stored(), openAppearance(), assert, sleep(ms). */
export async function withAppearanceApp(name, scenario, { width = 1164, height = 655, timeoutMs = 150000, plugins = [] } = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
  const server = await createServer({ cacheDir: path.join(temp, 'vite-cache'), server: { port: 0 }, logLevel: 'error', plugins });
  await server.listen();
  const url = `http://localhost:${server.httpServer.address().port}/`;
  const main = path.join(temp, 'main.cjs');
  fs.writeFileSync(main, `
    const {app,BrowserWindow}=require('electron');
    const assert=require('node:assert/strict');
    const fs=require('node:fs');
    const SHOTS=${JSON.stringify(process.env.APPEARANCE_SHOTS ?? '')};
    app.whenReady().then(async()=>{
      const win=new BrowserWindow({show:false,width:${width},height:${height},useContentSize:true,enableLargerThanScreen:true,webPreferences:{contextIsolation:true,sandbox:true,backgroundThrottling:false}});
      win.webContents.on('console-message',(e)=>{ if(e.level==='error'||e.level===3) console.log('[page]',e.message); });
      const run=async code=>{ try { return await win.webContents.executeJavaScript(code); } catch(error) { throw new Error(String(error)+" in renderer script: "+code); } };
      const sleep=ms=>new Promise(r=>setTimeout(r,ms));
      const frame=()=>run('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
      const until=async(code,what)=>{ for(let i=0;i<500;i++){ if(await run(code)) return; await sleep(20);} assert.fail('timed out: '+(what||code)); };
      const size=async(w,h)=>{ win.setContentSize(w,h); await sleep(60); await frame(); };
      const shot=async(file)=>{ if(!SHOTS) return; await frame(); const image=await win.webContents.capturePage(); fs.writeFileSync(SHOTS+'/'+file+'.png',image.toPNG()); };
      const KEY='apex-deck.demo.settings.v1';
      const load=async()=>{ await win.loadURL(${JSON.stringify(url)}); await until("!!document.querySelector('.rail')",'the deck to load'); };
      const seed=async(settings)=>{ await run('localStorage.setItem('+JSON.stringify(KEY)+','+JSON.stringify(JSON.stringify(settings))+')'); await load(); };
      const stored=()=>run('JSON.parse(localStorage.getItem('+JSON.stringify(KEY)+'))');
      const openAppearance=async()=>{
        await run("document.querySelector('.rail [aria-label=Appearance]').click()");
        await until("!!document.querySelector('.settings .studio-editor')",'the Appearance page');
        await until("document.querySelector('.studio-preview iframe')?.contentDocument?.querySelector('.appearance-preview-page')",'the preview page');
      };
      try {
        await load();
        await (async()=>{ ${scenario} })();
        app.exit(0);
      } catch(error){ console.error(error); app.exit(1); }
    });
  `);
  try {
    const { code, output } = await runElectronScenario(electronBinary, main, temp, { timeoutMs });
    assert.equal(code, 0, output);
  } finally {
    await server.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

/** Settings as settings.json would hold them, on one built-in preset. */
export const onSkin = (id, BUILTIN_SKINS, extra = {}) => {
  const skin = BUILTIN_SKINS.find((s) => s.id === id);
  return { appearance: { current: { format: 'apex-glass-playground', version: 2, name: skin.name, appearance: skin.appearance }, saved: [], colorMode: 'dark' }, ...extra };
};

export const STUDIO_HELPERS = `
  const labels=()=>run("[...document.querySelectorAll('.studio-panel:not([hidden]) .studio-ctl-name')].map(e=>e.textContent)");
  const tab=async(name)=>{ await run("document.querySelector('.studio-tabs [role=tab][data-tab=\\""+name+"\\"]').click()"); await frame(); };
  const pickTheme=async(name)=>{ await run("document.querySelector('input[name=studio-theme][value="+name+"]').click()"); await frame(); };
  const buttons=()=>run("[...document.querySelectorAll('.studio-status button, .studio-preset-meta button')].filter(b=>!b.hidden).map(b=>b.textContent)");
  const text=()=>run("document.querySelector('.studio-editor').innerText");
`;
