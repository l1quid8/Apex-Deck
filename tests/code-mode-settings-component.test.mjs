import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import electron from 'electron';
import { createServer } from 'vite';
import { runElectronScenario } from './helpers/electron-test.mjs';

test('Code Mode controls acknowledge saves, show failures, sync host changes and gate phone writes', { timeout: 180000 }, async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'code-mode-controls-'));
  const html = `<html><body><div id="root"></div><script type="module">
    import React from 'react'; import {createRoot} from 'react-dom/client';
    import {CodeModeControl} from '/src/CodeModeControl.tsx';
    import {CodeModeSettings} from '/src/phone/CodeModeSettings.tsx';
    const root=createRoot(document.getElementById('root'));
    const listeners=new Set(), connections=new Set();
    const f=window.fixture={mode:'auto',kind:'connected',calls:[],fail:false,hold:false,
      emit(mode){this.mode=mode;for(const cb of listeners)cb({apexCodeMode:mode});},
      connection(kind){this.kind=kind;for(const cb of connections)cb();},
      mount(phone){root.render(React.createElement(phone?CodeModeSettings:CodeModeControl,phone?{hosts:[host]}:{backend}));}};
    const backend={settingsLoad:async()=>({apexCodeMode:f.mode}),
      onSettingsChanged:async cb=>{listeners.add(cb);return()=>listeners.delete(cb);},
      async call(cmd,args){f.calls.push([cmd,args]);if(f.fail)throw Error('save refused');
        if(f.hold)await new Promise(resolve=>f.release=resolve);
        f.emit(args.enabled?'auto':'off');return {mode:f.mode};}};
    const host={machine:{id:'mac',name:'Test Mac'},backend,
      connection:{get:()=>({status:{kind:f.kind}}),subscribe:cb=>{connections.add(cb);return()=>connections.delete(cb);}}};
    f.mount(false);window.ready=true;
  </script></body></html>`;
  const server = await createServer({ cacheDir: path.join(temp, 'vite-cache'), server: { host: '127.0.0.1', port: 0 }, logLevel: 'error', plugins: [{ name: 'code-mode-test', configureServer(server) { server.middlewares.use('/__code_mode_test', async (_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(await server.transformIndexHtml('/__code_mode_test', html)); }); } }] });
  await server.listen();
  const url = `http://127.0.0.1:${server.httpServer.address().port}/__code_mode_test`;
  const main = path.join(temp, 'main.cjs');
  fs.writeFileSync(main, `const {app,BrowserWindow}=require('electron');const assert=require('node:assert/strict');
    app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,webPreferences:{nodeIntegration:false,contextIsolation:true,backgroundThrottling:false}});
      win.webContents.on('console-message',(_event,_level,message)=>console.log(message));
      const run=fn=>win.webContents.executeJavaScript('('+fn.toString()+')()');
      const wait=async(fn,label)=>{for(let i=0;i<200;i++){if(await run(fn))return;await new Promise(r=>setTimeout(r,30));}throw Error('Timed out: '+label);};
      const choose=async value=>win.webContents.executeJavaScript('('+function(value){const s=document.querySelector('select[aria-label="Apex Code Mode"]');const set=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set;set.call(s,value);s.dispatchEvent(new Event('change',{bubbles:true}));}.toString()+')('+JSON.stringify(value)+')');
      try{await win.loadURL(${JSON.stringify(url)});await wait(()=>window.ready&&document.querySelector('select')?.value==='auto','desktop load');
        await run(()=>{window.fixture.hold=true;});await choose('off');
        await wait(()=>document.querySelector('select').disabled,'pending save disables control');
        assert.equal(await run(()=>document.querySelector('select').value),'auto');
        await run(()=>{window.fixture.hold=false;window.fixture.release();});
        await wait(()=>document.querySelector('select').value==='off'&&document.body.innerText.includes('Saved'),'desktop acknowledged Off');
        await run(()=>{window.fixture.fail=true;});await choose('auto');
        await wait(()=>document.body.innerText.includes('Could not confirm'),'save error');
        assert.equal(await run(()=>document.querySelector('select').value),'off');
        await run(()=>{window.fixture.fail=false;window.fixture.emit('auto');});
        await wait(()=>document.querySelector('select').value==='auto','external host update');
        await run(()=>window.fixture.mount(true));await wait(()=>document.body.innerText.includes('General')&&document.querySelector('select[aria-label="Apex Code Mode"]')?.value==='auto','phone load');
        assert.equal(await run(()=>document.querySelector('select[aria-label="Apex Code Mode"]').disabled),false);
        assert.doesNotMatch(await run(()=>document.body.innerText),/Full access is required/);
        await choose('off');await wait(()=>document.body.innerText.includes('Test Mac confirmed Off'),'phone acknowledged save');
        await run(()=>window.fixture.connection('idle'));
        await wait(()=>document.body.innerText.includes('disconnected')&&document.querySelector('select[aria-label="Apex Code Mode"]').disabled,'offline phone');
        assert.doesNotMatch(await run(()=>document.body.innerText),/Full access is required/);
        const calls=await run(()=>window.fixture.calls);assert.equal(calls.length,3);assert.ok(calls.every(c=>c[0]==='settings_code_mode_set'));assert.deepEqual(calls[0][1],{enabled:false});
        console.log('CODE_MODE_CONTROLS_OK');win.destroy();app.exit(0);
      }catch(e){console.error(e.stack);win.destroy();app.exit(1);}});
  `);
  try { const result = await runElectronScenario(electron, main, temp, { timeoutMs: 60000 }); assert.equal(result.code, 0, result.output); assert.match(result.output, /CODE_MODE_CONTROLS_OK/); }
  finally { await server.close(); fs.rmSync(temp, { recursive: true, force: true }); }
});
