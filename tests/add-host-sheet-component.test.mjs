import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import electron from 'electron';
import { createServer } from 'vite';
import { runElectronScenario } from './helpers/electron-test.mjs';

test('desktop Add host guides trust and installation, cancels stale work and preserves editing', { timeout: 120000 }, async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'guided-host-'));
  const html = `<html><body><button id="opener">Add host</button><div id="root"></div><script type="module">
    import React from 'react'; import {createRoot} from 'react-dom/client';
    import {ConnectionDialog} from '/src/ConnectionDialog.tsx'; import '/src/styles.css';
    const root=createRoot(document.getElementById('root'));
    const f=window.fixture={calls:[],saved:[],scenario:'install',closed:0,finish:null,
      mount(edit=false){if(edit==='paired')host.transport='paired';root.render(React.createElement(ConnectionDialog,{key:Math.random(),mode:edit?{kind:'edit',hostId:'one'}:{kind:'add'},hosts:[host],api,onClose:()=>{f.closed++;root.render(null)},onSaved:list=>{f.saved.push(list);root.render(null)}}))}};
    const host={id:'one',name:'Existing',remote:true,ssh:'old-box',command:'apex-daemon',port:2222};
    const api={list:async()=>[host],add:async()=>{throw Error('legacy add must not run')},update:async(id,fields)=>{f.calls.push(['update',fields]);return {ok:true,hosts:[host]}},
      setup:{pairStart:async link=>{f.calls.push(['pairStart',link]);f.pairState={kind:'code',code:'482916',hostName:'Studio Mac'}},pairStatus:async()=>f.pairState,pairCancel:async()=>{f.calls.push(['pairCancel'])},cancel:async()=>{f.calls.push(['cancel'])},check:async fields=>{f.calls.push(['check',fields]);if(f.scenario==='error')throw Error('Permission denied (publickey).');return {kind:'trust',ticket:'t1',fingerprint:'SHA256:real-test-fingerprint',algorithm:'ED25519'}},
      trust:async ticket=>{f.calls.push(['trust',ticket]);return {kind:f.scenario==='ready'?'ready':'install',ticket:'t1',name:'box',os:'Linux'}},
      finish:async ticket=>{f.calls.push(['finish',ticket]);if(f.scenario==='slow')return new Promise(resolve=>{f.finish=resolve});return [{id:'new',name:'box'}]}}};
    window.ready=true;
  </script></body></html>`;
  const server = await createServer({ cacheDir: path.join(temp, 'vite-cache'), server: { port: 0 }, logLevel: 'error', plugins: [{ name: 'guided-host-fixture', configureServer(server) { server.middlewares.use('/__guided_host', async (_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(await server.transformIndexHtml('/__guided_host', html)); }); } }] });
  await server.listen();
  const main = path.join(temp, 'main.cjs');
  fs.writeFileSync(main, `
    const {app,BrowserWindow}=require('electron');const assert=require('node:assert/strict');const fs=require('node:fs');
    app.whenReady().then(async()=>{
      const win=new BrowserWindow({show:false,width:760,height:880,webPreferences:{contextIsolation:true}});
      const run=fn=>win.webContents.executeJavaScript('('+fn.toString()+')()');
      const wait=async fn=>{for(let i=0;i<300;i++){if(await win.webContents.executeJavaScript('!!('+fn.toString()+')()'))return;await new Promise(r=>setTimeout(r,20));}throw Error('Timeout: '+await run(()=>document.body.innerText));};
      const click=label=>win.webContents.executeJavaScript('[...document.querySelectorAll("button")].find(b=>b.textContent.trim()==='+JSON.stringify(label)+').click()');
      const fill=async()=>run(()=>{const input=document.querySelector('input');const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;setter.call(input,'me@box');input.dispatchEvent(new Event('input',{bubbles:true}));});
      const text=()=>run(()=>document.body.innerText);
      try{
        await win.loadURL(${JSON.stringify(`http://localhost:${server.httpServer.address().port}/__guided_host`)});
        await wait(()=>window.ready);
        await run(()=>{document.querySelector('#opener').focus();window.fixture.mount()});
        await wait(()=>document.querySelector('.conn-route'));
        assert.match(await text(),/Pair a phone/);
        await click('QR code / pairing link →Deck already running there? Pair from its invitation.');
        await wait(()=>document.body.innerText.includes('Pairing link'));
        await click('Back');await wait(()=>document.querySelector('.conn-route'));
        await click('Remote SSH →Use your SSH key. Deck checks the machine and guides setup.');await wait(()=>document.querySelector('input'));await fill();
        await click('Check connection');await wait(()=>document.body.innerText.includes('Trust this machine?'));
        assert.match(await text(),/SHA256:real-test-fingerprint/);
        assert.equal(await run(()=>window.fixture.calls.filter(c=>c[0]==='finish').length),0);
        await click('Trust and continue');await wait(()=>document.body.innerText.includes('Install and connect'));
        assert.equal(await run(()=>window.fixture.calls.filter(c=>c[0]==='finish').length),0);
        fs.writeFileSync(${JSON.stringify(path.join(temp, 'review.png'))},(await win.webContents.capturePage()).toPNG());
        await click('Install and connect');await wait(()=>window.fixture.saved.length===1);
        assert.equal(await run(()=>window.fixture.calls.filter(c=>c[0]==='finish').length),1);
        await run(()=>{window.fixture.scenario='error';window.fixture.mount()});await wait(()=>document.querySelector('.conn-route'));
        await click('Remote SSH →Use your SSH key. Deck checks the machine and guides setup.');await wait(()=>document.querySelector('input'));await fill();await click('Check connection');
        await wait(()=>document.querySelector('[role="alert"]'));
        assert.match(await text(),/Permission denied/);assert.ok(await run(()=>!!document.querySelector('input')));
        await click('Cancel');await wait(()=>!document.querySelector('[role="dialog"]'));
        await run(()=>{window.fixture.scenario='slow';window.fixture.mount()});await wait(()=>document.querySelector('.conn-route'));
        await click('Remote SSH →Use your SSH key. Deck checks the machine and guides setup.');await wait(()=>document.querySelector('input'));await fill();await click('Check connection');await wait(()=>document.body.innerText.includes('Trust this machine?'));await click('Trust and continue');await wait(()=>document.body.innerText.includes('Install and connect'));await click('Install and connect');await wait(()=>window.fixture.finish);
        await click('Cancel');await wait(()=>!document.querySelector('[role="dialog"]'));await run(()=>window.fixture.finish([{id:'late'}]));
        assert.equal(await run(()=>window.fixture.saved.length),1);
        await run(()=>window.fixture.mount(true));await wait(()=>document.querySelector('[data-field="ssh"]'));
        assert.match(await text(),/Edit connection/);assert.equal(await run(()=>document.querySelector('input[type="number"]').value),'2222');
        await click('Save');await wait(()=>window.fixture.saved.length===2);
        assert.equal(await run(()=>window.fixture.calls.find(c=>c[0]==='update')[1].port),2222);
        await run(()=>window.fixture.mount());await wait(()=>document.querySelector('.conn-route'));
        await click('QR code / pairing link →Deck already running there? Pair from its invitation.');await wait(()=>document.querySelector('input'));await fill();await click('Pair host');
        await wait(()=>document.body.innerText.includes('482 916'));
        assert.equal(await run(()=>window.fixture.saved.length),2);
        await run(()=>{window.fixture.pairState={kind:'verifying'}});await wait(()=>document.body.innerText.includes('Verifying the paired connection'));
        await run(()=>{window.fixture.pairState={kind:'done',hosts:[{id:'paired',name:'Studio Mac',transport:'paired'}]}});await wait(()=>window.fixture.saved.length===3);
        await run(()=>window.fixture.mount());await wait(()=>document.querySelector('.conn-route'));
        await click('QR code / pairing link →Deck already running there? Pair from its invitation.');await wait(()=>document.querySelector('input'));await fill();await click('Pair host');await wait(()=>document.body.innerText.includes('482 916'));
        await run(()=>{window.fixture.pairState={kind:'failed',message:'Pairing was denied on the host.'}});await wait(()=>document.body.innerText.includes('Pairing was denied'));
        assert.equal(await run(()=>window.fixture.saved.length),3);
        await click('Pair host');await wait(()=>document.body.innerText.includes('482 916'));await click('Back');await wait(()=>document.querySelector('.conn-route'));
        assert.ok(await run(()=>window.fixture.calls.filter(c=>c[0]==='pairCancel').length>0));
        await run(()=>{window.fixture.pairState={kind:'done',hosts:[{id:'late'}]}});
        await new Promise(r=>setTimeout(r,500));assert.equal(await run(()=>window.fixture.saved.length),3);
        await click('Cancel');
        await run(()=>window.fixture.mount('paired'));await wait(()=>document.body.innerText.includes('Paired connection'));
        assert.equal(await run(()=>document.querySelectorAll('input').length),0);
        assert.match(await text(),/encrypted paired link/);await click('Done');
        console.log('GUIDED_HOST_UI_OK screenshot='+${JSON.stringify(path.join(temp, 'review.png'))});app.exit(0);
      }catch(e){console.error(e.stack);app.exit(1)}
    });
  `);
  try {
    const result = await runElectronScenario(electron, main, temp, { attempts: 1 });
    assert.equal(result.code, 0, result.output);
    console.log(result.output);
  } finally { await server.close(); }
});
