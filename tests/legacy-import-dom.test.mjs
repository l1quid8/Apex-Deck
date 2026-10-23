import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import electron from 'electron';
import { createServer } from 'vite';
import { runElectronScenario } from './helpers/electron-test.mjs';

test('older records read inert source text and import once with the displayed hashes in Chromium', { timeout: 120000 }, async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-import-dom-'));
  const html = `<div id="root"></div><script type="module">
    import React from 'react'; import {createRoot} from 'react-dom/client';
    import {LegacyImportScreen,legacyImportFor} from '/src/LegacyImportScreen.tsx'; import '/src/styles.css';
    const hash='a'.repeat(64), snapshot={id:'20261022-204152',path:'/data/legacy-import/20261022-204152',createdAtMs:1,reused:false};
    let imported=false; window.calls=[];
    const backend={supports:()=>true,call:async(cmd,args)=>{window.calls.push([cmd,args]);
      if(cmd==='legacy_import_preview')return {snapshot,ledgers:[{ledger:'assistant-conversations-v1.json',sourcePath:'/data/assistant-conversations-v1.json',size:4096,sha256:hash,state:imported?'imported':'ready',reason:imported?'Already imported.':'Ready to import.',counts:{records:1,importable:1,notImported:0},records:[{id:'request-7',kind:'conversation',title:'Restore startup history',originalStatus:'completed',importStatus:'legacy',reason:'Kept as unverified history. It never runs again.'}],problems:[]}]};
      if(cmd==='legacy_import_history')return {snapshot:snapshot.id,requestId:args.requestId,sourceSha256:hash,verified:false,label:'Unverified',record:{request:{text:'Please restore startup.'+String.fromCharCode(10)+'<scr'+'ipt>window.executed=true</scr'+'ipt>'},response:'Saved response. No work was restarted.',status:'completed'}};
      if(cmd==='legacy_import_apply'){imported=true;return {snapshot:snapshot.id,complete:true,ledgers:[{ledger:'assistant-conversations-v1.json',state:'imported',imported:1,skipped:0,verified:false}]};} throw Error(cmd);}};
    createRoot(document.getElementById('root')).render(React.createElement(LegacyImportScreen,{api:legacyImportFor(backend),onClose(){},onImported(){}}));
  </script>`;
  const server = await createServer({ cacheDir: path.join(temp, 'cache'), server: { port: 0 }, logLevel: 'error', plugins: [{ name: 'legacy-import-dom', configureServer(server) { server.middlewares.use('/__legacy_import', async (_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(await server.transformIndexHtml('/__legacy_import', html)); }); } }] });
  await server.listen();
  const url = `http://localhost:${server.httpServer.address().port}/__legacy_import`;
  const main = path.join(temp, 'main.cjs');
  fs.writeFileSync(main, `
    const {app,BrowserWindow}=require('electron'); const fs=require('node:fs'); const assert=require('node:assert/strict');
    app.whenReady().then(async()=>{
      const win=new BrowserWindow({show:false,width:1000,height:780});
      const run=fn=>win.webContents.executeJavaScript('('+fn.toString()+')()');
      const wait=async fn=>{for(let i=0;i<600;i++){if(await run(fn))return;await new Promise(r=>setTimeout(r,25));}throw Error('Timed out: '+await run(()=>document.body.innerText));};
      try {
        await win.loadURL(${JSON.stringify(url)});
        await wait(()=>[...document.querySelectorAll('button')].some(b=>b.textContent==='Read saved transcript'));
        assert.equal((await run(()=>window.calls)).filter(c=>c[0]==='legacy_import_apply').length,0);
        await run(()=>{document.querySelector('details').open=true;[...document.querySelectorAll('button')].find(b=>b.textContent==='Read saved transcript').click();});
        await wait(()=>document.querySelector('.legacy-history')?.textContent.includes('Saved response.'));
        assert.equal(await run(()=>window.executed),undefined);
        assert.equal(await run(()=>document.querySelector('.legacy-history textarea')!==null),false);
        const history=(await run(()=>window.calls)).find(c=>c[0]==='legacy_import_history');
        assert.deepEqual(history[1],{snapshot:'20261022-204152',requestId:'request-7'});
        fs.writeFileSync('/tmp/apex-g2b-transcript-smoke.png',(await win.webContents.capturePage()).toPNG());
        await run(()=>[...document.querySelectorAll('button')].find(b=>b.textContent==='Import 1 record').click());
        await wait(()=>document.body.textContent.includes('Import finished'));
        const applies=(await run(()=>window.calls)).filter(c=>c[0]==='legacy_import_apply');
        assert.equal(applies.length,1);
        assert.deepEqual(applies[0][1],{snapshot:'20261022-204152',sources:{'assistant-conversations-v1.json':'a'.repeat(64)}});
        console.log('Read-only history and one hash-bound import passed'); app.exit(0);
      }catch(e){console.error(e.stack);app.exit(1);}
    });
  `);
  try { const result = await runElectronScenario(electron, main, temp); assert.equal(result.code, 0, result.output); }
  finally { await server.close(); fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});
