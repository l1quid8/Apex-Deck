import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import electron from 'electron';
import { createServer } from 'vite';
import { runElectronScenario } from './helpers/electron-test.mjs';

// The real UpdateNotices in App's shell (title bar, notices, then the body),
// with the real stylesheets in real Chromium. A chat's composer runs along the
// bottom of the panes. Update notices stay until answered, so they must never
// sit on it: they used to float at the window's bottom centre, over the send
// button of whichever chat was there.
function measure() {
  const rect = (el) => el.getBoundingClientRect().toJSON();
  const overlaps = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
  const composer = rect(document.querySelector('.composer'));
  const send = rect(document.querySelector('[aria-label="Send"]'));
  const notices = [...document.querySelectorAll('[role=status], [role=alert]')].map((el) => ({
    text: el.textContent,
    rect: rect(el),
    coversComposer: overlaps(rect(el), composer),
    coversSend: overlaps(rect(el), send),
    words: { clientWidth: el.querySelector('span').clientWidth, scrollWidth: el.querySelector('span').scrollWidth },
    buttons: [...el.querySelectorAll('button')].map((b) => ({ name: b.textContent, rect: rect(b) })),
  }));
  return {
    innerWidth: window.innerWidth,
    pageWidth: document.documentElement.scrollWidth,
    titlebar: rect(document.querySelector('.titlebar')),
    body: rect(document.querySelector('.body')),
    composer,
    notices,
  };
}

test('update notices sit under the title bar and never cover a chat box', { timeout: 200000 }, async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'update-notices-layout-'));
  const html = `<div id="root"></div><script type="module">
    import React from 'react'; import {createRoot} from 'react-dom/client';
    import {UpdateNotices} from '/src/UpdateNotices.tsx';
    import '/src/styles.css'; import '/src/glass-theme.css'; import '/src/clay-theme.css';
    const h=React.createElement;
    const ready={current:'0.9.0',state:'ready',disabledReason:null,available:{version:'0.9.1',notes:''},progress:null,error:null,checkedAt:null,dismissed:false,result:null};
    const failed={outcome:'failed',version:'0.9.1',message:'Apex Deck is still open in another account on this Mac. Quit it there, then try the update again.'};
    const states={ready,failed:{...ready,state:'up-to-date',available:null,result:failed},both:{...ready,result:failed}};
    window.restarts=0;
    const root=createRoot(document.getElementById('root'));
    window.show=(name)=>root.render(h('div',{className:'app'},
      h('header',{className:'titlebar'},h('span',{className:'brand'},'Apex Deck')),
      h(UpdateNotices,{updates:states[name],onRestart:()=>{window.restarts++;}}),
      h('div',{className:'body'},
        h('aside',{className:'rail'},'Projects'),
        h('main',{className:'canvas',style:{flex:1,display:'flex',flexDirection:'column'}},
          h('div',{style:{flex:1}},'Transcript'),
          h('form',{className:'composer',style:{height:140,flexShrink:0}},
            h('textarea',{'aria-label':'Message'}),
            h('button',{type:'button','aria-label':'Send',style:{position:'absolute',right:16,bottom:16}},'↑'))))));
    window.ready=true;
  </script>`;
  const server = await createServer({ cacheDir: path.join(temp, 'vite-cache'), server: { port: 0 }, logLevel: 'error', plugins: [{ name: 'update-notices-layout', configureServer(s) { s.middlewares.use('/__update_notices', async (_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(await s.transformIndexHtml('/__update_notices', html)); }); } }] });
  await server.listen();
  const url = `http://localhost:${server.httpServer.address().port}/__update_notices`;
  const main = path.join(temp, 'main.cjs');
  fs.writeFileSync(main, `
    const {app,BrowserWindow}=require('electron');const assert=require('node:assert/strict');
    app.whenReady().then(async()=>{
      const win=new BrowserWindow({show:false,width:1280,height:820,webPreferences:{offscreen:true}});
      const run=c=>win.webContents.executeJavaScript(c);
      const frame=()=>run('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
      try{
        await win.loadURL(${JSON.stringify(url)});
        for(let i=0;i<300&&!(await run('!!window.ready'));i++) await new Promise(r=>setTimeout(r,20));
        assert.equal(await run('!!window.ready'),true,'fixture must render');
        for(const width of [1280,720]){
          win.setContentSize(width,820);
          for(const name of ['ready','failed','both']){
            await run('window.show('+JSON.stringify(name)+')');await frame();
            const s=await run('('+${JSON.stringify(measure.toString())}+')()');
            const seen=width+'px '+name+': '+JSON.stringify(s);
            assert.equal(s.notices.length,name==='both'?2:1,'the notices render: '+seen);
            assert.ok(s.pageWidth<=s.innerWidth,'nothing runs off the side: '+seen);
            for(const n of s.notices){
              assert.equal(n.coversComposer,false,'a notice covers the chat box: '+seen);
              assert.equal(n.coversSend,false,'a notice covers the send button: '+seen);
              assert.ok(n.rect.top>=s.titlebar.bottom-0.5,'a notice covers the title bar: '+seen);
              assert.ok(n.rect.bottom<=s.body.top+0.5,'a notice sits over the panes: '+seen);
              assert.ok(n.words.scrollWidth<=n.words.clientWidth+1,'long words wrap instead of being cut off: '+seen);
              for(const b of n.buttons) assert.ok(b.rect.width>0&&b.rect.left>=0&&b.rect.right<=s.innerWidth+0.5,b.name+' fits the window: '+seen);
            }
          }
        }
        await run('window.show("ready")');await frame();
        await run('[...document.querySelectorAll("button")].find(b=>b.textContent==="Restart to update").click()');
        assert.equal(await run('window.restarts'),1,'Restart to update asks App to restart');
        app.exit(0);
      }catch(error){console.error(error.stack);app.exit(1);}
    });`);
  try {
    const result = await runElectronScenario(electron, main, temp);
    assert.equal(result.code, 0, result.output);
  } finally {
    await server.close();
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
