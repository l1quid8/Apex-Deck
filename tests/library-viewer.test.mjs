import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import electron from 'electron';
import { createServer } from 'vite';

// Exercise the real React viewer and CSS in Chromium; only asset storage is faked.
test('Library controls stay outside media and navigation resets the active preview', { timeout: 60000 }, async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'library-viewer-'));
  const html = `<html><head><style>body{margin:0}</style></head><body><div id="test-root"></div><script type="module">
    import React from 'react'; import {createRoot} from 'react-dom/client';
    import {LibraryView} from '/src/LibraryView.tsx'; import '/src/styles.css';
    const canvas = document.createElement('canvas'); canvas.width=1400; canvas.height=800;
    const ctx=canvas.getContext('2d');ctx.fillStyle='#193852';ctx.fillRect(0,0,1400,800);ctx.fillStyle='#86bedc';ctx.font='64px sans-serif';ctx.fillText('Library preview',420,410);
    const bytes = new Uint8Array(await (await fetch(canvas.toDataURL())).arrayBuffer());
    const items = ['a','b','c'].map((id,i)=>({file:id+'.png',path:'/lib/'+id+'.png',kind:'image',source:'chat',room:'gone',by:'Test bot',created:i+1}));
    window.fixture = {delay:false,pending:[],resolve(){this.pending.splice(0).forEach(resolve=>resolve(bytes));}};
    const backend = {libraryList:async()=>items,readAttachment:async()=>window.fixture.delay ? new Promise(resolve=>window.fixture.pending.push(resolve)) : bytes};
    createRoot(document.getElementById('test-root')).render(React.createElement(LibraryView,{machines:[{id:'local',name:'Test Mac',offline:false}],backendOf:()=>backend,threads:[],workspaces:[],onOpenThread(){}}));
    window.ready=true;
  </script></body></html>`;
  // Each parallel test file gets its own dependency cache: Vite servers sharing
  // node_modules/.vite race renaming deps_temp into deps (ENOTEMPTY), and the
  // loser's page never finishes loading.
  const server = await createServer({ cacheDir: path.join(temp, 'vite-cache'), server: { port: 0 }, logLevel: 'error', plugins: [{ name: 'library-test', configureServer(server) { server.middlewares.use('/__library_test', async (_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(await server.transformIndexHtml('/__library_test', html)); }); } }] });
  await server.listen();
  const url = `http://localhost:${server.httpServer.address().port}/__library_test`;
  const main = path.join(temp, 'main.cjs');
  fs.writeFileSync(main, `
    const {app,BrowserWindow}=require('electron'); const assert=require('node:assert/strict');
    app.whenReady().then(async()=>{
      const win=new BrowserWindow({show:false,width:1280,height:900,webPreferences:{contextIsolation:true}});
      win.webContents.on('console-message',(_e,...args)=>console.log(...args));
      const run=fn=>win.webContents.executeJavaScript('('+fn.toString()+')()');
      const wait=async fn=>{for(let i=0;i<200;i++){if(await run(fn)) return;await new Promise(r=>setTimeout(r,20));}throw Error('Timed out: '+fn+' '+JSON.stringify(await run(()=>({ready:window.ready,body:document.body.innerHTML.slice(0,1600)}))));};
      const click=label=>win.webContents.executeJavaScript('document.querySelector('+JSON.stringify('[aria-label="'+label+'"]')+').click()');
      try {
        await win.loadURL(${JSON.stringify(url)});
        await wait(()=>window.ready && document.querySelectorAll('.library-tile').length===3);
        await run(()=>document.querySelector('.library-tile').click());
        await wait(()=>document.querySelector('.library-viewer-image img')?.naturalWidth>0);
        const geometry=()=>{const p=document.querySelector('.library-viewer-nav.is-previous').getBoundingClientRect();const n=document.querySelector('.library-viewer-nav.is-next').getBoundingClientRect();const m=document.querySelector('.library-viewer-image').getBoundingClientRect();return {previous:p.right<=m.left,next:n.left>=m.right};};
        assert.deepEqual(await run(geometry),{previous:true,next:true},'navigation must not overlap the image viewport');
        if(process.env.APEX_LIBRARY_SCREENSHOT) require('node:fs').writeFileSync(process.env.APEX_LIBRARY_SCREENSHOT,(await win.webContents.capturePage()).toPNG());
        await click('Zoom in');
        assert.equal(await run(()=>document.querySelector('.library-zoom-label').textContent),'125%');
        await run(()=>{window.fixture.delay=true;document.querySelector('[aria-label="Next picture"]').click();});
        assert.equal(await run(()=>document.querySelector('.library-viewer-bar strong').textContent),'b.png');
        assert.equal(await run(()=>!!document.querySelector('.library-viewer-image img')),false,'do not display previous bytes under the next filename');
        assert.equal(await run(()=>document.querySelector('.library-zoom-label').textContent),'100%','reset zoom on navigation');
        await run(()=>{window.fixture.delay=false;window.fixture.resolve();});
        await wait(()=>document.querySelector('.library-viewer-image img')?.naturalWidth>0);
        // Repeated events in one turn must advance from the most recent item.
        await run(()=>{for(let i=0;i<2;i++)window.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));});
        assert.equal(await run(()=>document.querySelector('.library-viewer-bar strong').textContent),'c.png');
        await click('Previous picture');
        assert.equal(await run(()=>document.querySelector('.library-viewer-bar strong').textContent),'a.png','previous wraps at the first item');
        await run(()=>[...document.querySelectorAll('.library-viewer-actions button')].find(b=>b.textContent==='Rename').click());
        await run(()=>document.querySelector('.library-viewer-rename input').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true})));
        assert.equal(await run(()=>document.querySelector('.library-viewer-bar strong').textContent),'a.png','editing does not navigate');
        await run(()=>document.querySelector('.library-viewer-rename input').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true})));
        assert.equal(await run(()=>!!document.querySelector('.library-viewer')),true,'Escape cancels rename without closing viewer');
        await run(()=>[...document.querySelectorAll('.library-viewer-actions button')].find(b=>b.textContent==='Delete').click());
        await run(()=>window.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true})));
        assert.equal(await run(()=>document.querySelector('.library-viewer-bar strong').textContent),'a.png','confirmation freezes the active asset');
        await run(()=>document.querySelector('.confirm-actions button').click());
        assert.equal(await run(()=>!!document.querySelector('[role="alertdialog"]')),false);
        for(const width of [800,480]){
          win.setSize(width,750); await new Promise(r=>setTimeout(r,50));
          assert.deepEqual(await run(geometry),{previous:true,next:true},'controls outside media at width '+width);
          if(width===480 && process.env.APEX_LIBRARY_SCREENSHOT) require('node:fs').writeFileSync(process.env.APEX_LIBRARY_SCREENSHOT.replace('.png','-narrow.png'),(await win.webContents.capturePage()).toPNG());
          assert.equal(await run(()=>{const r=document.querySelector('.library-viewer').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.bottom<=innerHeight;}),true,'viewer fits viewport');
          assert.equal(await run(()=>{const r=document.querySelector('.library-viewer').getBoundingClientRect();return [...document.querySelectorAll('.library-viewer-actions button')].every(b=>{const q=b.getBoundingClientRect();return q.left>=r.left&&q.right<=r.right&&q.bottom<=r.bottom;});}),true,'all viewer actions remain visible');
        }
        console.log('Library viewer Chromium checks passed'); app.exit(0);
      }catch(error){console.error(error.stack);app.exit(1);}
    });
  `);
  try {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(electron, [main, '--user-data-dir=' + path.join(temp, 'profile')], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = ''; child.stdout.on('data', bytes => output += bytes); child.stderr.on('data', bytes => output += bytes);
      const timer = setTimeout(() => child.kill('SIGKILL'), 50000);
      child.on('error', reject); child.on('exit', code => { clearTimeout(timer); resolve({ code, output }); });
    });
    assert.equal(result.code, 0, result.output);
  } finally { await server.close(); fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});
