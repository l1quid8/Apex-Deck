import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import electron from 'electron';
import { createServer } from 'vite';
import { runElectronScenario } from './helpers/electron-test.mjs';

// Exercise the real selector and save pipeline in Chromium with an in-memory backend.
test('Model switching and supported speed selections persist when the quick selector reopens', { timeout: 200000 }, async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-settings-'));
  const html = `<html><body><button id="anchor">Bot</button><div id="test-root"></div><script type="module">
    import React from 'react'; import {createRoot} from 'react-dom/client';
    import {BotSettings} from '/src/BotSettings.tsx'; import '/src/styles.css';
    const root=createRoot(document.getElementById('test-root'));
    window.fixture={config:null,fail:false,saves:0,mount(tool,fail=false){
      this.fail=fail; this.key=Math.random(); this.config={id:'bot',display_name:'Test',access:'read',effort:null,backend:tool==='api'?{kind:'open_ai_compatible',base_url:'http://test',model:'last'}:{kind:'agent',tool,model:'last'}};
      this.render();
    },render(){root.render(React.createElement(BotSettings,{key:this.key,config:this.config,roomId:'test',anchor:document.getElementById('anchor'),backend,save:async config=>{this.config=config;this.saves++;this.render();},close(){root.render(null);}}));}};
    const models=[{id:'first',label:'First model'},{id:'last',label:'Last model'}];
    const backend={agentModels:async()=>{if(window.fixture.fail)throw Error('offline');return models;},apiModels:async()=>{if(window.fixture.fail)throw Error('offline');return models;},roomCreate:async()=>({participants:[window.fixture.config]})};
    window.ready=true;
  </script></body></html>`;
  // Each parallel test file gets its own dependency cache: Vite servers sharing
  // node_modules/.vite race renaming deps_temp into deps (ENOTEMPTY), and the
  // loser's page never finishes loading.
  const server = await createServer({ cacheDir: path.join(temp, 'vite-cache'), server: { port: 0 }, logLevel: 'error', plugins: [{ name: 'bot-settings-test', configureServer(server) { server.middlewares.use('/__bot_settings_test', async (_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(await server.transformIndexHtml('/__bot_settings_test', html)); }); } }] });
  await server.listen();
  const url = `http://localhost:${server.httpServer.address().port}/__bot_settings_test`;
  const main = path.join(temp, 'main.cjs');
  fs.writeFileSync(main, `
    const {app,BrowserWindow}=require('electron'); const assert=require('node:assert/strict');
    app.whenReady().then(async()=>{
      const win=new BrowserWindow({show:false,width:1280,height:900,webPreferences:{contextIsolation:true}});
      win.webContents.on('console-message',(_e,...args)=>console.log(...args));
      const run=fn=>win.webContents.executeJavaScript('('+fn.toString()+')()');
      const wait=async fn=>{for(let i=0;i<200;i++){if(await run(fn)) return;await new Promise(r=>setTimeout(r,20));}throw Error('Timed out: '+fn+' '+JSON.stringify(await run(()=>({ready:window.ready,body:document.body.innerHTML.slice(0,1600)}))));};
      try {
        await win.loadURL(${JSON.stringify(url)});
        await wait(()=>window.ready);
        const enter=async (selector,value)=>win.webContents.executeJavaScript('(()=>{const e=document.querySelector('+JSON.stringify(selector)+');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(e,'+JSON.stringify(value)+');e.dispatchEvent(new Event("input",{bubbles:true}));})()');
        for(const tool of ['claude_code','codex','gemini','grok','muse','api']){
          await win.webContents.executeJavaScript('window.fixture.mount('+JSON.stringify(tool)+')');
          await wait(()=>document.querySelector('.model-select-trigger'));
          await run(()=>document.querySelector('.model-select-trigger').click());
          await wait(()=>document.querySelector('.model-menu'));
          assert.equal(await run(()=>!!document.querySelector('[aria-label="Filter models"]')),true,'search for '+tool);
          assert.equal(await run(()=>document.querySelector('[role="menuitemradio"]').getAttribute('aria-checked')),'true','current first for '+tool);
          await enter('[aria-label="Filter models"]','FIRST');
          await wait(()=>document.querySelectorAll('[role="menuitemradio"]').length===1);
          await run(()=>document.querySelector('[role="menuitemradio"]').click());
          await wait(()=>window.fixture.config.backend.model==='first');
          await run(()=>{window.fixture.key=Math.random();window.fixture.render();});
          await wait(()=>document.querySelector('.model-select-trigger')?.textContent.includes('First model'));
          await run(()=>document.querySelector('.model-select-trigger').click());
          await wait(()=>document.querySelector('[role="menuitemradio"]'));
          assert.equal(await run(()=>document.querySelector('[role="menuitemradio"]').getAttribute('aria-checked')),'true','saved choice survives reopening for '+tool);
          await win.webContents.executeJavaScript('window.fixture.mount('+JSON.stringify(tool)+',true)');
          await wait(()=>document.querySelector('.model-select-trigger')?.getAttribute('aria-expanded')==='false');
          await run(()=>document.querySelector('.model-select-trigger').click());
          await wait(()=>document.querySelector('[aria-label="Model name"]'));
          await enter('[aria-label="Model name"]',' custom-model ');
          await run(()=>document.querySelector('[aria-label="Model name"]').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true})));
          await wait(()=>window.fixture.config.backend.model==='custom-model');
          await run(()=>{window.fixture.key=Math.random();window.fixture.render();});
          await wait(()=>document.querySelector('.model-select-trigger')?.textContent.includes('custom-model'));
        }
        for(const tool of ['codex','claude_code','openai','gemini','grok','muse','api']){
          await win.webContents.executeJavaScript('window.fixture.mount('+JSON.stringify(tool==='openai'?'api':tool)+')');
          if(tool==='openai') await run(()=>{window.fixture.config.backend.base_url='https://api.openai.com/v1';window.fixture.render();});
          await wait(()=>document.querySelector('.model-select-trigger'));
          const supported=['codex','claude_code','openai'].includes(tool);
          assert.equal(await run(()=>!!document.querySelector('.bot-speed')),supported,'speed eligibility for '+tool);
          if(!supported) continue;
          for(const [label,value] of [['Fast','fast'],['Standard','standard'],['Default',undefined]]){
            await win.webContents.executeJavaScript('Array.from(document.querySelectorAll(".bot-speed button")).find(b=>b.textContent==='+JSON.stringify(label)+').click()');
            for(let i=0;i<100;i++){
              if(await run(()=>window.fixture.config.speed)===value)break;
              await new Promise(r=>setTimeout(r,20));
            }
            assert.equal(await run(()=>window.fixture.config.speed),value,'saved '+label+' for '+tool);
            await run(()=>{window.fixture.config=JSON.parse(JSON.stringify(window.fixture.config));window.fixture.key=Math.random();window.fixture.render();});
            await new Promise(r=>setTimeout(r,50));
            assert.equal(await run(()=>document.querySelector('.bot-speed [aria-checked="true"]')?.textContent),label,'reopened '+label+' for '+tool);
          }
        }
        for(const tool of ['claude_code','codex','gemini','grok','muse','api']){
          await win.webContents.executeJavaScript('window.fixture.mount('+JSON.stringify(tool)+')');
          await wait(()=>document.querySelector('.model-select-trigger'));
          const labels=await run(()=>Array.from(document.querySelectorAll('[aria-label="Access"] button')).map(b=>b.textContent));
          assert.deepEqual(labels,['grok','muse'].includes(tool)?['Read-only','Edit','Full']:['Read-only','Ask','Edit','Full'],'access choices for '+tool);
          for(const label of labels.slice().reverse()){
            await win.webContents.executeJavaScript('Array.from(document.querySelectorAll(".bot-access button")).find(b=>b.textContent==='+JSON.stringify(label)+').click()');
            await wait(()=>document.querySelector('[aria-label="Access"] [aria-checked="true"]'));
            for(let i=0;i<100;i++){if(await run(()=>document.querySelector('[aria-label="Access"] [aria-checked="true"]').textContent)===label && await run(()=>!document.querySelector('fieldset').getAttribute('aria-busy')||document.querySelector('fieldset').getAttribute('aria-busy')==='false'))break;await new Promise(r=>setTimeout(r,20));}
            const expected={'Read-only':'read',Ask:'ask',Edit:'edits',Full:'full'}[label];
            assert.equal(await run(()=>window.fixture.config.access),expected,'saved access for '+tool);
            await run(()=>{window.fixture.key=Math.random();window.fixture.render();});
            await wait(()=>document.querySelector('[aria-label="Access"] [aria-checked="true"]'));
            assert.equal(await run(()=>document.querySelector('[aria-label="Access"] [aria-checked="true"]').textContent),label,'access persists after reopen');
          }
        }
        console.log('Model selector Chromium checks passed'); app.exit(0);
      }catch(error){console.error(error.stack);app.exit(1);}
    });
  `);
  try {
    const result = await runElectronScenario(electron, main, temp);
    assert.equal(result.code, 0, result.output);
  } finally { await server.close(); fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});
