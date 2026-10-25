import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import electron from 'electron';
import { createServer } from 'vite';
import { runElectronScenario } from './helpers/electron-test.mjs';

test('folder switches dismiss Revert confirmations and discard plans from the previous folder', {timeout:60000}, async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-mount-chat-'));
  const html = `<html><body><div id="root"></div><script type="module">
    import React from 'react';import{createRoot}from'react-dom/client';
    import{ChatPane}from'/src/ChatPane.tsx';import{getBackend}from'/src/backend.ts';
    const root=createRoot(document.getElementById('root'));
    const bot={id:'bot',display_name:'Bot',persona:'',access:'read',effort:null,backend:{kind:'scripted',lines:['[pass]']}};
    const plan={available:true,note:null,files:[{path:'a.ts',delete:false,conflict:false}],skipped:[],effects:[]};
    window.fixture={cwd:'/repo',defer:false,resolve:null,reverts:0,mount(cwd){this.cwd=cwd;root.render(React.createElement(ChatPane,{pane:{id:'r',workspaceId:'w',kind:'chat',title:'Thread'},cwd,backend,agents:[],focused:true,onActivity(){},profiles:[],onProfilesChange(){},disabledProviders:[]}));}};
    const snapshot={participants:[bot],options:{policy:'mention',max_bot_hops:0},changes:[],transcript:[{seq:0,speaker:{kind:'human'},text:'Change a.ts',timestamp:0},{seq:1,speaker:{kind:'bot',id:'bot'},text:'Done.',timestamp:1}]};
    const backend={...await getBackend(),roomCreate:async()=>snapshot,roomState:async()=>({cwd:window.fixture.cwd,snapshot,active:[],approvals:[],questions:[],mounts:[]}),roomSteps:async()=>null,roomClose:async()=>{},onRoomEvent:async()=>()=>{},onPtyData:async()=>()=>{},onPtyExit:async()=>()=>{},roomRevertPlan:async()=>window.fixture.defer?new Promise(resolve=>window.fixture.resolve=()=>resolve(plan)):plan,roomRevert:async()=>{window.fixture.reverts++;return[];},call:async()=>{throw Error('No git fixture');}};
    window.fixture.mount('/repo');window.ready=true;
  </script></body></html>`;
  const server = await createServer({cacheDir:path.join(temp,'cache'),server:{port:0},logLevel:'error',plugins:[{name:'mount-chat-fixture',configureServer(s){s.middlewares.use('/__mount_chat',async(_req,res)=>{res.setHeader('Content-Type','text/html');res.end(await s.transformIndexHtml('/__mount_chat',html));});}}]});
  await server.listen();
  const main = path.join(temp, 'main.cjs');
  fs.writeFileSync(main, `
    const{app,BrowserWindow}=require('electron');const assert=require('node:assert/strict');
    app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,width:1000,height:800,webPreferences:{contextIsolation:true,backgroundThrottling:false}});const run=fn=>win.webContents.executeJavaScript('('+fn.toString()+')()');const wait=async fn=>{for(let i=0;i<400;i++){if(await run(fn))return;await new Promise(r=>setTimeout(r,25));}throw Error('Timed out '+fn+' '+await run(()=>document.body.innerText));};try{
      await win.loadURL(${JSON.stringify(`http://localhost:${server.httpServer.address().port}/__mount_chat`)});
      await wait(()=>window.ready&&!document.querySelector('textarea')?.disabled);
      await wait(()=>document.querySelector('[data-message-more="0"]'));
      await run(()=>document.querySelector('[data-message-more="0"]').click());
      await wait(()=>document.querySelector('[aria-label="Revert to here"]'));
      await run(()=>document.querySelector('[aria-label="Revert to here"]').click());
      await wait(()=>document.querySelector('.goback-pop'));
      await run(()=>window.fixture.mount('/tree'));
      await wait(()=>!document.querySelector('textarea')?.disabled);
      await new Promise(r=>setTimeout(r,200));
      assert.equal(await run(()=>!!document.querySelector('.goback-pop')),false,'old Revert confirmation must close on mount');
      await run(()=>{window.fixture.defer=true;document.querySelector('[aria-label="Revert to here"]').click();});
      await wait(()=>!!window.fixture.resolve);
      await run(()=>window.fixture.mount('/other-tree'));
      await wait(()=>!document.querySelector('textarea')?.disabled);
      // Returning to the same pathname is still a different room lifecycle.
      await run(()=>window.fixture.mount('/tree'));
      await wait(()=>!document.querySelector('textarea')?.disabled);
      await run(()=>window.fixture.resolve());
      await new Promise(r=>setTimeout(r,200));
      assert.equal(await run(()=>!!document.querySelector('.goback-pop')),false,'late old-folder plan must be discarded');
      assert.equal(await run(()=>window.fixture.reverts),0);
      console.log('Mount clears stale Revert state');app.exit(0);
    }catch(error){console.error(error.stack);app.exit(1);}});
  `);
  try { const result = await runElectronScenario(electron,main,temp,{timeoutMs:30000}); assert.equal(result.code,0,result.output); }
  finally { await server.close(); fs.rmSync(temp,{recursive:true,force:true,maxRetries:5,retryDelay:100}); }
});
