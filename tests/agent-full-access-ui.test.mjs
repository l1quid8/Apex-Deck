import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import electron from 'electron';
import { createServer } from 'vite';
import { runElectronScenario } from './helpers/electron-test.mjs';

test('Full access settings confirm, cancel, revoke, and explain an older host in Chromium', { timeout: 200000 }, async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-full-access-ui-'));
  const html = `<html><body><div id="test-root"></div><script type="module">
    import React from 'react'; import {createRoot} from 'react-dom/client';
    import {AgentFullAccessStatus} from '/src/AgentFullAccessStatus.tsx'; import '/src/styles.css';
    const root=createRoot(document.getElementById('test-root'));
    window.fixture={calls:[],dialogs:[],answer:true,approved:false,supported:true,failRevoke:false,
      mount(access='full',approved=false,supported=true){
        this.calls=[];this.dialogs=[];this.approved=approved;this.supported=supported;this.answer=true;this.failRevoke=false;
        this.key=crypto.randomUUID();this.config={id:'agent-866a3317-38ca-484a-bc9b-356293eeafab',display_name:'Null',access,backend:{kind:'agent',tool:'codex'}};
        root.render(React.createElement(AgentFullAccessStatus,{key:this.key,backend,config:this.config}));
      }};
    window.confirm=message=>{window.fixture.dialogs.push(message);return window.fixture.answer;};
    const backend={host:{name:'VPS'},supports:()=>window.fixture.supported,call:async(command,args)=>{
      const f=window.fixture;f.calls.push({command,args});
      if(args.confirm)f.approved=true;
      if(args.revoke){if(f.failRevoke)throw Error('VPS unavailable');f.approved=false;}
      return {approved:f.approved};
    }};
    window.ready=true;
  </script></body></html>`;
  const server = await createServer({ cacheDir: path.join(temp, 'vite-cache'), server: { port: 0 }, logLevel: 'error', plugins: [{ name: 'agent-full-access-test', configureServer(server) { server.middlewares.use('/__agent_full_access_test', async (_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(await server.transformIndexHtml('/__agent_full_access_test', html)); }); } }] });
  await server.listen();
  const url = `http://localhost:${server.httpServer.address().port}/__agent_full_access_test`;
  const main = path.join(temp, 'main.cjs');
  fs.writeFileSync(main, `
    const {app,BrowserWindow}=require('electron');const assert=require('node:assert/strict');
    app.whenReady().then(async()=>{
      const win=new BrowserWindow({show:false,width:700,height:650,webPreferences:{contextIsolation:true}});
      const run=fn=>win.webContents.executeJavaScript('('+fn.toString()+')()');
      const wait=async fn=>{for(let i=0;i<200;i++){if(await run(fn))return;await new Promise(r=>setTimeout(r,20));}throw Error('Timed out: '+fn+' '+await run(()=>document.body.innerText));};
      try {
        await win.loadURL(${JSON.stringify(url)});await wait(()=>window.ready);
        await run(()=>window.fixture.mount());
        await wait(()=>document.querySelector('button')?.textContent==='Confirm Full access');
        assert.match(await run(()=>document.querySelector('[role="status"]').textContent),/allowed folders/);
        // Cancelling the native confirmation never writes a grant.
        await run(()=>{window.fixture.answer=false;document.querySelector('button').click();});
        await wait(()=>document.querySelector('[role="alert"]'));
        assert.match(await run(()=>document.querySelector('[role="alert"]').textContent),/not confirmed/);
        assert.equal(await run(()=>window.fixture.calls.some(c=>c.args.confirm)),false);
        // Confirmation is addressed to the current agent and machine.
        await run(()=>{window.fixture.answer=true;document.querySelector('button').click();});
        await wait(()=>document.querySelector('button')?.textContent==='Revoke Full access approval');
        assert.equal(await run(()=>window.fixture.calls.filter(c=>c.args.confirm).length),1);
        assert.equal(await run(()=>window.fixture.calls.find(c=>c.args.confirm).args.agent),'agent-866a3317-38ca-484a-bc9b-356293eeafab');
        assert.match(await run(()=>window.fixture.dialogs.at(-1)),/Null on VPS/);
        assert.match(await run(()=>window.fixture.dialogs.at(-1)),/code written by other agents/);
        assert.match(await run(()=>document.querySelector('[role="status"]').textContent),/confirmed on this machine/);
        // Cancelled revocation preserves approval. A transport failure stays visible.
        await run(()=>{window.fixture.answer=false;document.querySelector('button').click();});
        assert.equal(await run(()=>window.fixture.calls.some(c=>c.args.revoke)),false);
        await run(()=>{window.fixture.answer=true;window.fixture.failRevoke=true;document.querySelector('button').click();});
        await wait(()=>document.querySelector('[role="alert"]')?.textContent.includes('VPS unavailable'));
        assert.equal(await run(()=>document.querySelector('button').textContent),'Revoke Full access approval');
        await run(()=>{window.fixture.failRevoke=false;document.querySelector('button').click();});
        await wait(()=>document.querySelector('button')?.textContent==='Confirm Full access');
        assert.equal(await run(()=>window.fixture.approved),false);
        assert.match(await run(()=>window.fixture.dialogs.at(-1)),/Active Full-access copies.*will be stopped/);
        // A saved grant remains discoverable and revocable after lowering access.
        await run(()=>window.fixture.mount('read',true));
        await wait(()=>document.querySelector('button')?.textContent==='Revoke Full access approval');
        assert.match(await run(()=>document.querySelector('[role="status"]').textContent),/while the agent uses Full access/);
        await run(()=>document.querySelector('button').click());
        await wait(()=>!document.querySelector('.agent-full-access'));
        assert.equal(await run(()=>window.fixture.approved),false);
        await run(()=>window.fixture.mount('read',false));
        await wait(()=>window.fixture.calls.length===1);
        assert.equal(await run(()=>!!document.querySelector('.agent-full-access')),false);
        // An old host has actionable text without a confirmation that could silently fail.
        await run(()=>window.fixture.mount('full',false,false));
        await wait(()=>document.querySelector('[role="status"]')?.textContent.includes('Update this machine'));
        assert.equal(await run(()=>!!document.querySelector('button')),false);
        assert.equal(await run(()=>window.fixture.calls.length),0);
        console.log('Full access Chromium checks passed');app.exit(0);
      }catch(error){console.error(error.stack);app.exit(1);}
    });
  `);
  try {
    const result = await runElectronScenario(electron, main, temp);
    assert.equal(result.code, 0, result.output);
  } finally { await server.close(); fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});
