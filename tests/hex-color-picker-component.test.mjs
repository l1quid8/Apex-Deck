import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import electron from 'electron';
import { createServer } from 'vite';
import { runElectronScenario } from './helpers/electron-test.mjs';

// The Agents tab colour control, driven in Chromium: presets, the colour well,
// typed hex, and the readability warning all have to move the saved colour.
test('Hex colour picker applies presets, typed hex and the colour well', { timeout: 200000 }, async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-picker-'));
  const html = `<html><body><div id="test-root"></div><script type="module">
    import React from 'react'; import {createRoot} from 'react-dom/client';
    import {HexColorPicker} from '/src/HexColorPicker.tsx'; import '/src/styles.css';
    const h=React.createElement; const root=createRoot(document.getElementById('test-root'));
    function Harness({initial}){
      const [value,set]=React.useState(initial);
      return h('div',{id:'host'},
        h(HexColorPicker,{label:'Color',value,presets:['#2dd4bf','#f59e0b','#a78bfa'],onChange:next=>{window.fixture.changes.push(next);set(next);}}),
        h('output',{id:'current'},value));
    }
    window.fixture={changes:[],mount(initial='#a78bfa'){root.render(h(Harness,{key:Math.random(),initial}));}};
    window.fixture.mount();
    window.ready=true;
  </script></body></html>`;
  // Each parallel test file gets its own dependency cache: Vite servers sharing
  // node_modules/.vite race renaming deps_temp into deps (ENOTEMPTY), and the
  // loser's page never finishes loading.
  const server = await createServer({ cacheDir: path.join(temp, 'vite-cache'), server: { port: 0 }, logLevel: 'error', plugins: [{ name: 'hex-picker-test', configureServer(server) { server.middlewares.use('/__hex_picker_test', async (_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(await server.transformIndexHtml('/__hex_picker_test', html)); }); } }] });
  await server.listen();
  const url = `http://localhost:${server.httpServer.address().port}/__hex_picker_test`;
  const main = path.join(temp, 'main.cjs');
  fs.writeFileSync(main, `
    const {app,BrowserWindow}=require('electron'); const assert=require('node:assert/strict');
    app.whenReady().then(async()=>{
      const win=new BrowserWindow({show:false,width:1280,height:900,webPreferences:{contextIsolation:true}});
      win.webContents.on('console-message',(_e,...args)=>console.log(...args));
      const run=fn=>win.webContents.executeJavaScript('('+fn.toString()+')()');
      const wait=async fn=>{for(let i=0;i<300;i++){if(await run(fn)) return;await new Promise(r=>setTimeout(r,20));}throw Error('Timed out: '+fn+' '+JSON.stringify(await run(()=>({ready:window.ready,body:document.body.innerHTML.slice(0,1600)}))));};
      const type=async (selector,value)=>win.webContents.executeJavaScript('(()=>{const e=document.querySelector('+JSON.stringify(selector)+');const proto=e instanceof HTMLInputElement?HTMLInputElement.prototype:HTMLTextAreaElement.prototype;Object.getOwnPropertyDescriptor(proto,"value").set.call(e,'+JSON.stringify(value)+');e.dispatchEvent(new Event("input",{bubbles:true}));})()');
      const current=()=>run(()=>document.querySelector('#current').textContent);
      const hint=()=>run(()=>document.querySelector('.hex-hint').textContent);
      try {
        await win.loadURL(${JSON.stringify(url)});
        await wait(()=>window.ready && document.querySelector('#host'));

        // The saved colour is shown, and its preset is the pressed one.
        assert.equal(await current(),'#a78bfa','initial colour');
        assert.equal(await run(()=>document.querySelector('.hex-text').value),'#a78bfa','hex field shows the colour');
        assert.equal(await run(()=>document.querySelectorAll('.hex-swatch').length),3,'one swatch per preset');
        assert.equal(await run(()=>document.querySelector('[aria-label="Use #a78bfa"]').getAttribute('aria-pressed')),'true','active preset is pressed');

        // A preset swatch applies immediately and takes over the pressed state.
        await run(()=>document.querySelector('[aria-label="Use #2dd4bf"]').click());
        await wait(()=>document.querySelector('#current').textContent==='#2dd4bf');
        assert.equal(await run(()=>document.querySelector('[aria-label="Use #2dd4bf"]').getAttribute('aria-pressed')),'true','pressed follows the choice');
        assert.equal(await run(()=>document.querySelector('[aria-label="Use #a78bfa"]').getAttribute('aria-pressed')),'false','old preset released');
        assert.equal(await run(()=>document.querySelector('.hex-text').value),'#2dd4bf','hex field follows the swatch');

        // Typed hex, in caps, applies as lowercase.
        await type('.hex-text','#FF8800');
        await wait(()=>document.querySelector('#current').textContent==='#ff8800');
        assert.equal(await current(),'#ff8800','typed hex applied');

        // A bare hex without the hash works too, and short form expands.
        await type('.hex-text','0f0');
        await wait(()=>document.querySelector('#current').textContent==='#00ff00');
        await type('.hex-text','#ABC');
        await wait(()=>document.querySelector('#current').textContent==='#aabbcc');

        // Half-typed text is a draft: it must not change the stored colour.
        const before=await current();
        await type('.hex-text','#ab');
        await new Promise(r=>setTimeout(r,60));
        assert.equal(await current(),before,'partial hex does not apply');
        assert.equal(await run(()=>document.querySelector('.hex-text').value),'#ab','partial text is kept while typing');
        // Leaving the field restores the canonical form of the saved colour.
        await run(()=>document.querySelector('.hex-text').dispatchEvent(new FocusEvent('focusout',{bubbles:true})));
        await wait(()=>document.querySelector('.hex-text').value==='#aabbcc');

        // The system colour well feeds the same path.
        await type('input[type="color"]','#123456');
        await wait(()=>document.querySelector('#current').textContent==='#123456');
        assert.equal(await run(()=>document.querySelector('.hex-text').value),'#123456','hex field follows the colour well');

        // An unreadable colour warns without being blocked.
        await type('.hex-text','#050505');
        await wait(()=>document.querySelector('#current').textContent==='#050505');
        assert.match(await hint(),/hard to read/,'dark colour warns');
        await type('.hex-text','#a78bfa');
        await wait(()=>document.querySelector('#current').textContent==='#a78bfa');
        assert.match(await hint(),/#abc/,'readable colour shows the format hint');
        assert.doesNotMatch(await hint(),/hard to read/,'warning clears');

        // Re-mounting with a saved colour (another agent's settings) resets the field.
        await win.webContents.executeJavaScript('window.fixture.mount("#60a5fa")');
        await wait(()=>document.querySelector('#current')?.textContent==='#60a5fa');
        assert.equal(await run(()=>document.querySelector('.hex-text').value),'#60a5fa','form follows a different agent');

        console.log('Hex colour picker Chromium checks passed'); app.exit(0);
      }catch(error){console.error(error.stack);app.exit(1);}
    });
  `);
  try {
    const result = await runElectronScenario(electron, main, temp);
    assert.equal(result.code, 0, result.output);
  } finally { await server.close(); fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});
