import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import electron from 'electron';
import { createServer } from 'vite';
import { runElectronScenario } from './helpers/electron-test.mjs';

// Exercise the real ChatPane renderer and actions with an in-memory service.
// Appearance changes must not reset the draft or recreate the room.
test('all chip styles preserve the live composer and bot actions in wide, narrow and folded layouts', { timeout: 200000 }, async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'chip-styles-'));
  const html = `<html><body><div id="test-root"></div><script type="module">
    import React from 'react'; import {createRoot} from 'react-dom/client';
    import {ChatPane} from '/src/ChatPane.tsx'; import {getBackend} from '/src/backend.ts'; import {applyAppearance, BUILTIN_SKINS} from '/src/themes.ts'; import '/src/styles.css'; import '/src/glass-theme.css'; import '/src/clay-theme.css'; import '/src/bot-chip-styles.css';
    const root=createRoot(document.getElementById('test-root'));
    const bot={id:'bot',display_name:'Bot',persona:'',access:'read',effort:null,backend:{kind:'scripted',lines:['[pass]']}};
    const state=()=>({recovery_seq:1,snapshot:{participants:[bot,{...bot,id:'jigga',display_name:'Jigga'},{...bot,id:'null',display_name:'Null'}],options:{policy:'mention',max_bot_hops:3},transcript:[]},active:['bot'],approvals:[{id:'bot',request:'req-1',action:{kind:'command',title:'Run ls',detail:'ls'}}]});
    window.fixture={calls:[],misses:0,listeners:[],
      mount(style){root.render(React.createElement(ChatPane,{pane:{id:'r1',workspaceId:'w1',kind:'chat',title:'Thread'},cwd:'/tmp/project',agents:[],backend,focused:true,onActivity(){},profiles:[],onProfilesChange(){},disabledProviders:[],chipParts:{tool:true,effort:true,usage:true,style}}));},
      unmount(){root.render(null);},
      emit(event){this.listeners.forEach(fn=>fn('r1',event));},
      count(name){return this.calls.filter(c=>c[0]===name).length;}};
    const log=(name,fn)=>(...args)=>{window.fixture.calls.push([name,...args]);return fn(...args);};
    // The browser preview's service, with the room's lifecycle, reads, decisions and events replaced and logged.
    const backend={...await getBackend(),
      roomCreate:log('roomCreate',async()=>state().snapshot),
      // A room Deck hasn't opened yet reads as the service's own missing-room error.
      roomState:log('roomState',async id=>{if(window.fixture.misses>0){window.fixture.misses--;throw Error('no group chat with id '+id);}return state();}),
      roomClose:log('roomClose',async()=>{}),
      roomDecide:log('roomDecide',async()=>{}),
      roomSteps:async()=>null,
      onRoomEvent:async fn=>{window.fixture.listeners.push(fn);return()=>{};},
      onPtyData:async()=>()=>{},onPtyExit:async()=>()=>{},
    };
    window.setTestSkin=(id)=>{applyAppearance(document.documentElement,BUILTIN_SKINS.find(s=>s.id===id).appearance);}; window.ready=true; document.body.style.height='100vh'; document.getElementById('test-root').style.cssText='height:100vh;display:flex';
  </script></body></html>`;
  // Its own dependency cache, as in bot-settings.test.mjs: parallel Vite servers race on a shared one.
  const server = await createServer({ cacheDir: path.join(temp, 'vite-cache'), server: { port: 0 }, logLevel: 'error', plugins: [{ name: 'chat-attach-test', configureServer(server) { server.middlewares.use('/__chat_attach_test', async (_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(await server.transformIndexHtml('/__chat_attach_test', html)); }); } }] });
  await server.listen();
  const url = `http://localhost:${server.httpServer.address().port}/__chat_attach_test`;
  const main = path.join(temp, 'main.cjs');
  const screenshot = '/tmp/apex-chip-styles.png';
  fs.writeFileSync(main, `
    const {app,BrowserWindow}=require('electron'); const assert=require('node:assert/strict'); const fs=require('node:fs');
    app.whenReady().then(async()=>{
      const win=new BrowserWindow({show:false,width:1200,height:1000,webPreferences:{contextIsolation:true}});
      const run=fn=>win.webContents.executeJavaScript('('+fn.toString()+')()');
      const wait=async fn=>{for(let i=0;i<400;i++){if(await run(fn))return;await new Promise(r=>setTimeout(r,25));}throw Error('Timed out: '+fn);};
      try {
        await win.loadURL(${JSON.stringify(url)}); await wait(()=>window.ready);
        const styles=['classic','dashed','tinted','stamp','stack','mono','ticket','keycap','tab','ledger','terminal','tiles','two-line'];
        await run(()=>{window.gallery=[];window.fixture.mount('classic');});
        await wait(()=>document.querySelector('.chip-name'));
        await run(()=>{const t=document.querySelector('textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(t,'Keep this draft');t.dispatchEvent(new Event('input',{bubbles:true}));});
        const creates=await run(()=>window.fixture.count('roomCreate'));
        for(const style of styles){
          await win.webContents.executeJavaScript('window.fixture.mount('+JSON.stringify(style)+')');
          await wait(()=>document.querySelector('.composer-bots')?.dataset.chipStyle===document.querySelector('.chat')?.dataset.botChipStyle);
          await new Promise(r=>setTimeout(r,50));
          assert.equal(await run(()=>document.querySelector('textarea').value),'Keep this draft',style+' draft');
          assert.equal(await run(()=>window.fixture.count('roomCreate')),creates,style+' must not restart the room');
          assert.equal(await run(()=>document.querySelector('.chip-name').getAttribute('aria-label').includes('Bot')),true,style+' accessible name');
          assert.equal(await run(()=>!!document.querySelector('[aria-label="Add bot"]')),true,style+' add bot');
          assert.equal(await run(()=>!!document.querySelector('[aria-label="Kick Bot"]')),true,style+' kick bot');
          await run(()=>{const r=document.querySelector('.composer-bots').cloneNode(true);r.dataset.fit='full';r.querySelector('.chip').classList.add('to');r.querySelector('.chip').dataset.editing='true';for(const [cls,text] of [['chip-meta chip-queued','2'],['editor-badge','editing']]){const e=document.createElement('span');e.className=cls;e.textContent=text;r.querySelector('.chip-details').append(e);}window.gallery.push({style:r.dataset.chipStyle,row:r.outerHTML});});
          await run(()=>document.querySelector('.chip-name').click());
          assert.equal(await run(()=>document.querySelector('textarea').value.includes('@')),true,style+' mention action');
          await run(()=>{const t=document.querySelector('textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(t,'Keep this draft');t.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('.chip-kick').focus();});
          assert.equal(await run(()=>document.querySelector('.chip-kick').getBoundingClientRect().width>0),true,style+' keyboard remove action');
          await run(()=>document.querySelector('.chip-kick').blur());
          for(const skin of ['classic','smoked','frost','clay']){
            await win.webContents.executeJavaScript('window.setTestSkin('+JSON.stringify(skin)+')');
            const geometry=await run(()=>{const row=document.querySelector('.composer-bots');const css=getComputedStyle(row);return {style:row.dataset.chipStyle,top:css.paddingTop,left:css.paddingLeft};});
            if(style==='tab') assert.equal(geometry.top,'0px',skin+' tabs attach directly below composer');
            if(style==='stack') assert.equal(geometry.left,'12px',skin+' stack leaves room for outlines');
          }
          await run(()=>window.setTestSkin('classic'));
          for(const width of [360,1200]){
            win.setSize(width,1000); await new Promise(r=>setTimeout(r,40));
            assert.equal(await run(()=>{const r=document.querySelector('.chip-name').getBoundingClientRect();return r.width>10&&r.height>10}),true,style+' visible at '+width);
          }
          await run(()=>document.querySelector('.chips-fold').click());
          assert.equal(await run(()=>document.querySelector('.chip-name').getAttribute('aria-label').includes('Bot')),true,style+' folded name');
          await run(()=>document.querySelector('.chips-fold').click());
        }
        win.setContentSize(1600,1500);
        await run(()=>{document.getElementById('test-root').style.display='none';const g=document.createElement('div');g.style.cssText='display:grid;grid-template-columns:1fr 1fr;gap:12px;padding:20px';document.body.append(g);for(const item of window.gallery.slice(1)){const d=document.createElement('section');d.className='thread-chat';d.style.cssText='border:1px solid var(--line);padding:12px;border-radius:8px';const h=document.createElement('h3');h.textContent=item.style;d.append(h);const c=document.createElement('div');c.className='composer-box';c.textContent='Message the room…';c.style.cssText='height:38px;padding:8px;border:1px solid var(--line)';d.append(c);d.insertAdjacentHTML('beforeend',item.row);g.append(d);}});
        await new Promise(r=>setTimeout(r,150));
        fs.writeFileSync(${JSON.stringify(screenshot)},(await win.webContents.capturePage()).toPNG());
        console.log('All 13 styles preserve draft, room, accessible names and bot actions; wide/narrow/folded checks passed. Screenshot: ${screenshot}'); app.exit(0);
      }catch(error){console.error(error.stack);app.exit(1);}
    });
  `);
  try {
    const result = await runElectronScenario(electron, main, temp);
    assert.equal(result.code, 0, result.output);
  } finally { await server.close(); fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});
