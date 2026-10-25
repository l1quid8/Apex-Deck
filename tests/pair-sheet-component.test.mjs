import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import electron from 'electron';
import { createServer } from 'vite';
import { runElectronScenario } from './helpers/electron-test.mjs';

// The Pair phone sheet in Chromium against a fake daemon: a big QR with no
// link text, Copy link, access on one line until Change, a code that expires
// unclaimed renewed with the same access, the one-card approval with the
// revoked-before warning, and the Paired state.
test('Pair phone shows the QR without the link, renews an expired code, and approves in one card', { timeout: 200000 }, async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pair-sheet-'));
  const shot = process.env.PAIR_SHEET_SHOT ?? '';
  const html = `<html><body><div id="test-root"></div><script type="module">
    import React from 'react'; import {createRoot} from 'react-dom/client';
    import {PairPhoneSheet} from '/src/PairPhoneSheet.tsx'; import '/src/styles.css';
    const root=createRoot(document.getElementById('test-root'));
    const f=window.fixture={calls:[],waits:{},paired:[],closed:0,n:0,
      mount(){root.render(React.createElement(PairPhoneSheet,{key:Math.random(),backend,onClose:()=>{f.closed++;root.render(null);},onPaired:d=>f.paired.push(d)}));},
      count(name){return this.calls.filter(c=>c[0]===name).length;},
      expire(inv){f.waits[inv].no(Object.assign(Error('expired'),{reason:'expired'}));},
      claim(inv,revoked){f.waits[inv].yes({claim_id:'c-'+inv,phone_id:'ab',label:'iPhone 16 Pro',code:'673149',previously_revoked_at:revoked??null});}};
    const backend={
      async call(cmd,args){f.calls.push([cmd,args]);
        if(cmd==='pair_start'){f.n++;return {invitation:'inv'+f.n,link:'apexdeck://pair?p=SECRET'+f.n+'x'.repeat(400),expires_at:Date.now()+272000};}
        if(cmd==='pair_wait'){if(!f.waits[args.invitation]){let yes,no;const p=new Promise((a,b)=>{yes=a;no=b;});f.waits[args.invitation]={p,yes,no};}return f.waits[args.invitation].p;}
        if(cmd==='pair_cancel')return null;
        if(cmd==='pair_approve')return {device:{endpointId:'ab',label:'iPhone 16 Pro',tier:args.tier??'chat',threads:'all',addedAt:Date.now(),lastSeen:null}};
        throw Error('unexpected '+cmd);},
      sessionLoad:async()=>({workspaces:[{id:'w',name:'apex-deck'}],panes:[{id:'t1',workspaceId:'w',kind:'chat',title:'Pairing'}]}),
      remoteAccess:{get:async()=>({on:true,owned:true}),set:async on=>({on,owned:true})},
      hosts:{},
    };
    window.ready=true;
  </script></body></html>`;
  const server = await createServer({ cacheDir: path.join(temp, 'vite-cache'), server: { port: 0 }, logLevel: 'error', plugins: [{ name: 'pair-sheet-test', configureServer(server) { server.middlewares.use('/__pair_sheet_test', async (_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(await server.transformIndexHtml('/__pair_sheet_test', html)); }); } }] });
  await server.listen();
  const url = `http://localhost:${server.httpServer.address().port}/__pair_sheet_test`;
  const main = path.join(temp, 'main.cjs');
  fs.writeFileSync(main, `
    const {app,BrowserWindow}=require('electron'); const assert=require('node:assert/strict'); const fs=require('node:fs');
    app.whenReady().then(async()=>{
      const win=new BrowserWindow({show:false,width:720,height:820,webPreferences:{contextIsolation:true}});
      win.webContents.on('console-message',(_e,...args)=>console.log(...args));
      const run=fn=>win.webContents.executeJavaScript('('+fn.toString()+')()');
      const truthy=fn=>win.webContents.executeJavaScript('!!('+fn.toString()+')()');
      const wait=async(fn,what)=>{for(let i=0;i<300;i++){if(await truthy(fn)) return;await new Promise(r=>setTimeout(r,20));}throw Error('Timed out: '+what+' '+JSON.stringify(await run(()=>({calls:window.fixture?.calls,body:document.body.innerText.slice(0,1200)}))));};
      const text=()=>run(()=>document.querySelector('.pair-sheet')?.innerText??'');
      const buttons=()=>run(()=>[...document.querySelectorAll('.pair-sheet button')].map(b=>b.textContent));
      const click=t=>win.webContents.executeJavaScript('[...document.querySelectorAll(".pair-sheet button")].find(b=>b.textContent==='+JSON.stringify(t)+').click()');
      const snap=async name=>{ if(${JSON.stringify(shot)}){ await new Promise(r=>setTimeout(r,200)); const img=await win.webContents.capturePage(); fs.writeFileSync(${JSON.stringify(shot)}+'-'+name+'.png',img.toPNG()); } };
      try {
        await win.loadURL(${JSON.stringify(url)});
        await wait(()=>window.ready,'page');
        await run(()=>window.fixture.mount());

        // Waiting: the QR, the scan line, the renew timer, Copy link, and access on one line.
        await wait(()=>document.querySelector('.pair-qr svg'),'QR');
        await wait(()=>document.querySelector('.pair-timer')?.textContent.startsWith('New code in'),'timer');
        assert.match(await text(),/Scan with the iPhone camera or the Apex Deck app\\./);
        assert.match(await run(()=>document.querySelector('.pair-timer').textContent),/^New code in 4:3\\d$/);
        assert.doesNotMatch(await run(()=>document.querySelector('.pair-sheet').outerHTML),/SECRET|apexdeck:/,'the link is nowhere in the sheet');
        assert.deepEqual(await buttons(),['Change','Copy link','Cancel']);
        assert.match(await run(()=>document.querySelector('.pair-scope-line').innerText),/Access: Chat and approvals · All threads/);
        assert.equal(await truthy(()=>document.querySelector('.pair-scope')),false,'access controls stay folded');
        assert.equal(await run(()=>Math.round(document.querySelector('.pair-qr').getBoundingClientRect().width)),260);
        await snap('waiting');

        // Change unfolds the same controls; picking Read only starts a code with it.
        await click('Change');
        await wait(()=>document.querySelector('.pair-scope select'),'controls');
        await run(()=>{const s=document.querySelector('.pair-scope select');const set=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set;set.call(s,'read_only');s.dispatchEvent(new Event('change',{bubbles:true}));});
        await wait(()=>window.fixture.count('pair_start')===2,'new code for the new access');
        assert.deepEqual(await run(()=>window.fixture.calls.filter(c=>c[0]==='pair_start').at(-1)[1]),{tier:'read_only',threads:'all'});
        assert.deepEqual(await run(()=>window.fixture.calls.filter(c=>c[0]==='pair_cancel').map(c=>c[1].invitation)),['inv1'],'the old code is cancelled');
        await snap('change');

        // The daemon says inv2 expired unclaimed: a new code, same access, no ended state.
        await wait(()=>!!window.fixture.waits.inv2,'waiting on inv2');
        await run(()=>window.fixture.expire('inv2'));
        await wait(()=>window.fixture.count('pair_start')===3,'renewed');
        assert.deepEqual(await run(()=>window.fixture.calls.filter(c=>c[0]==='pair_start').at(-1)[1]),{tier:'read_only',threads:'all'});
        await wait(()=>document.querySelector('.pair-qr svg'),'renewed QR');
        assert.equal(await truthy(()=>document.querySelector('.pair-sheet [role=alert]')),false,'renewing never shows an error');

        // A phone claims inv3: one card with the spaced code and the revoked-before warning.
        await wait(()=>!!window.fixture.waits.inv3,'waiting on inv3');
        await run(()=>window.fixture.claim('inv3',Date.UTC(2026,9,14)));
        await wait(()=>document.querySelector('.pair-claim-code'),'claim card');
        assert.equal(await run(()=>document.querySelector('.pair-claim-code').textContent),'673 149');
        assert.match(await text(),/iPhone 16 Pro wants to pair/);
        assert.match(await text(),/Approve if your phone shows the same code\\./);
        assert.match(await text(),/It gets Read only on all threads\\./);
        assert.match(await run(()=>document.querySelector('.pair-note.warn').textContent),/^This phone was removed on .*2026\\. Approving lets it back in\\.$/);
        assert.equal(await truthy(()=>document.querySelector('.pair-qr')),false,'no QR on the approval card');
        assert.equal(await truthy(()=>document.querySelector('.pair-scope-line')),false,'access is locked once claimed');
        assert.deepEqual(await buttons(),['Deny','Approve']);
        await snap('claimed');

        // Approve: the Paired state with Done.
        await click('Approve');
        await wait(()=>document.querySelector('.pair-done'),'paired');
        assert.match(await text(),/iPhone 16 Pro is paired/);
        assert.match(await text(),/It has Read only on all threads\\. Change it any time in Settings → Phones\\./);
        assert.deepEqual(await buttons(),['Done']);
        assert.equal(await run(()=>window.fixture.paired.length),1);
        await snap('paired');
        const cancels=await run(()=>window.fixture.count('pair_cancel'));
        await click('Done');
        await wait(()=>!document.querySelector('.pair-sheet'),'closed');
        assert.equal(await run(()=>window.fixture.count('pair_cancel')),cancels,'Done after pairing cancels nothing');

        // Copy link writes the whole link only when pressed, never shown.
        await run(()=>{window.fixture.copied=[];Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async t=>{window.fixture.copied.push(t);}}});window.fixture.mount();});
        await wait(()=>document.querySelector('.pair-qr svg'),'QR again');
        assert.deepEqual(await run(()=>window.fixture.copied),[]);
        await click('Copy link');
        await wait(()=>window.fixture.copied.length===1,'copied');
        assert.equal(await run(()=>window.fixture.copied[0].length),'apexdeck://pair?p=SECRET4'.length+400,'the whole link, not a cut-off one');
        await wait(()=>[...document.querySelectorAll('.pair-sheet button')].some(b=>b.textContent==='Copied'),'Copied');

        // Cancel closes and cancels the open code.
        await click('Cancel');
        await wait(()=>!document.querySelector('.pair-sheet'),'cancelled');
        assert.equal(await run(()=>window.fixture.calls.filter(c=>c[0]==='pair_cancel').at(-1)[1].invitation),'inv4');

        console.log('Pair sheet Chromium checks passed'); app.exit(0);
      }catch(error){console.error(error.stack);app.exit(1);}
    });
  `);
  try {
    const result = await runElectronScenario(electron, main, temp);
    assert.equal(result.code, 0, result.output);
  } finally { await server.close(); fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});
