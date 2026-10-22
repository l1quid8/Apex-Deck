import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import electron from 'electron';
import { createServer } from 'vite';
import { runElectronScenario } from './helpers/electron-test.mjs';

// Settings → Phones in Chromium against a fake daemon: the status line and its
// button follow phone connections and the paired list, Advanced shows only
// while on, and revoking the last phone asks once whether to turn them off.
test('Settings → Phones shows connections, turns them off and on, and asks after the last revoke', { timeout: 200000 }, async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'phones-settings-'));
  const shot = process.env.PHONES_SETTINGS_SHOT ?? '';
  const html = `<html><body><div id="test-root" class="settings-column" style="padding:24px;max-width:760px"></div><script type="module">
    import React from 'react'; import {createRoot} from 'react-dom/client';
    import {PhonesSettings} from '/src/PhonesSettings.tsx'; import '/src/styles.css';
    const root=createRoot(document.getElementById('test-root'));
    const phone={endpointId:'ab'.repeat(32),label:'iPhone 16 Pro',tier:'chat',threads:'all',addedAt:Date.UTC(2026,9,21),lastSeen:Date.now()};
    const f=window.fixture={on:true,devices:[phone],calls:[],
      mount(){root.render(React.createElement(PhonesSettings,{key:Math.random(),backend}));},
      count(name){return this.calls.filter(c=>c[0]===name).length;}};
    const info=()=>({enabled:f.on,endpoint_id:f.on?'cb414f8b'.repeat(8):null,port:41641,advertise:[]});
    const backend={
      async call(cmd,args){f.calls.push([cmd,args]);
        if(cmd==='devices_list')return {version:1,devices:f.devices,revoked:[]};
        if(cmd==='devices_revoke'){f.devices=f.devices.filter(d=>d.endpointId!==args.id);return null;}
        if(cmd==='remote_info')return info();
        throw Error('unexpected '+cmd);},
      remoteAccess:{
        get:async()=>{f.calls.push(['get']);return {on:f.on,owned:true};},
        set:async on=>{f.calls.push(['set',on]);f.on=on;return {on,owned:true};}},
      hosts:{},
    };
    window.ready=true;
  </script></body></html>`;
  const server = await createServer({ cacheDir: path.join(temp, 'vite-cache'), server: { port: 0 }, logLevel: 'error', plugins: [{ name: 'phones-settings-test', configureServer(server) { server.middlewares.use('/__phones_settings_test', async (_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(await server.transformIndexHtml('/__phones_settings_test', html)); }); } }] });
  await server.listen();
  const url = `http://localhost:${server.httpServer.address().port}/__phones_settings_test`;
  const main = path.join(temp, 'main.cjs');
  fs.writeFileSync(main, `
    const {app,BrowserWindow}=require('electron'); const assert=require('node:assert/strict'); const fs=require('node:fs');
    app.whenReady().then(async()=>{
      const win=new BrowserWindow({show:false,width:900,height:900,webPreferences:{contextIsolation:true}});
      win.webContents.on('console-message',(_e,...args)=>console.log(...args));
      const run=fn=>win.webContents.executeJavaScript('('+fn.toString()+')()');
      const wait=async(fn,what)=>{for(let i=0;i<300;i++){if(await run(fn)) return;await new Promise(r=>setTimeout(r,20));}throw Error('Timed out: '+what+' '+JSON.stringify(await run(()=>({calls:window.fixture?.calls,body:document.body.innerText.slice(0,1200)}))));};
      const status=()=>run(()=>document.querySelector('.phones-status-text')?.innerText??'');
      const buttons=()=>run(()=>[...document.querySelectorAll('.phones-status button')].map(b=>b.textContent));
      const click=text=>win.webContents.executeJavaScript('[...document.querySelectorAll("button")].find(b=>b.textContent==='+JSON.stringify(text)+').click()');
      const confirm=text=>win.webContents.executeJavaScript('[...document.querySelectorAll("[role=alertdialog] button")].find(b=>b.textContent==='+JSON.stringify(text)+').click()');
      const snap=async name=>{ if(${JSON.stringify(shot)}){ await new Promise(r=>setTimeout(r,200)); const img=await win.webContents.capturePage(); fs.writeFileSync(${JSON.stringify(shot)}+'-'+name+'.png',img.toPNG()); } };
      try {
        await win.loadURL(${JSON.stringify(url)});
        await wait(()=>window.ready,'page');
        await run(()=>window.fixture.mount());

        // On, one phone: the anywhere line, Turn off, and a closed Advanced with the endpoint.
        await wait(()=>document.querySelector('.phones-advanced'),'Advanced while on');
        assert.equal(await status(),'Phones can reach this Mac from anywhere.');
        assert.deepEqual(await buttons(),['Pair phone','Turn off']);
        assert.equal(await run(()=>document.querySelector('.phones-advanced').open),false,'Advanced starts closed');
        assert.match(await run(()=>document.querySelector('.phones-advanced').textContent),/Endpoint ID.*UDP port.*41641.*Advertised addresses/s);
        assert.doesNotMatch(await run(()=>document.body.innerText),/Remote access|Paired devices/);
        await snap('on');

        // Turn off: live in the daemon, the off-with-phones lines, Turn on, no Advanced.
        await click('Turn off');
        await wait(()=>document.querySelector('.phones-status-text')?.innerText.startsWith('Phone connections are off.'),'off line');
        assert.equal(await status(),"Phone connections are off.\\nPaired phones stay saved but can't connect, even on the same Wi‑Fi.");
        assert.deepEqual(await buttons(),['Pair phone','Turn on']);
        assert.equal(await run(()=>document.querySelector('.phones-advanced')),null,'Advanced hides while off');
        assert.equal(await run(()=>window.fixture.count('set')),1);
        await snap('off-with-phones');

        // Turn on again, then revoke the only phone: asked once, Keep on leaves them on.
        await click('Turn on');
        await wait(()=>document.querySelector('.phones-advanced'),'back on');
        await click('Revoke');
        await wait(()=>document.querySelector('[role=alertdialog]'),'revoke dialog');
        await confirm('Revoke');
        await wait(()=>document.querySelector('#confirm-title')?.textContent==='No phones are paired','last-phone question');
        assert.equal(await run(()=>document.querySelector('#confirm-body').textContent),'Turn off phone connections too?');
        assert.deepEqual(await run(()=>[...document.querySelectorAll('[role=alertdialog] button')].map(b=>b.textContent)),['Keep on','Turn off']);
        await snap('last-revoke');
        await confirm('Keep on');
        await wait(()=>!document.querySelector('[role=alertdialog]'),'question closed');
        assert.equal(await run(()=>window.fixture.on),true,'Keep on leaves connections on');
        assert.equal(await run(()=>window.fixture.count('set')),2,'Keep on calls nothing');

        // Re-mount with one phone and revoke it again; Turn off this time.
        await run(()=>{window.fixture.devices=[{endpointId:'cd'.repeat(32),label:'iPhone 13',tier:'full',threads:'all',addedAt:Date.UTC(2026,9,1),lastSeen:null}];window.fixture.mount();});
        await wait(()=>document.body.innerText.includes('iPhone 13'),'second phone');
        await click('Revoke');
        await wait(()=>document.querySelector('[role=alertdialog]'),'revoke dialog 2');
        await confirm('Revoke');
        await wait(()=>document.querySelector('#confirm-title')?.textContent==='No phones are paired','question 2');
        await confirm('Turn off');
        await wait(()=>window.fixture.on===false,'turned off');
        await wait(()=>document.querySelector('.phones-status-text')?.innerText==='Phone connections are off. Pairing turns them on.','off, none');
        assert.deepEqual(await buttons(),['Pair phone'],'off with no phones: Pair phone turns them on, no button');
        assert.match(await run(()=>document.body.innerText),/No phones yet/);
        await snap('off-none');

        // Revoking while connections are off never asks.
        await run(()=>{window.fixture.devices=[{endpointId:'ef'.repeat(32),label:'iPad',tier:'chat',threads:'all',addedAt:Date.UTC(2026,9,2),lastSeen:null}];window.fixture.mount();});
        await wait(()=>document.body.innerText.includes('iPad'),'third phone');
        await click('Revoke');
        await wait(()=>document.querySelector('[role=alertdialog]'),'revoke dialog 3');
        await confirm('Revoke');
        await wait(()=>document.body.innerText.includes('No phones yet'),'revoked while off');
        await new Promise(r=>setTimeout(r,60));
        assert.equal(await run(()=>document.querySelector('[role=alertdialog]')),null,'no question while off');

        console.log('Phones settings Chromium checks passed'); app.exit(0);
      }catch(error){console.error(error.stack);app.exit(1);}
    });
  `);
  try {
    const result = await runElectronScenario(electron, main, temp);
    assert.equal(result.code, 0, result.output);
  } finally { await server.close(); fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});
