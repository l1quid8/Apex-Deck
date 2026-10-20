import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import electron from 'electron';
import { createServer } from 'vite';
import { runElectronScenario } from './helpers/electron-test.mjs';

// The real ChatPane in two Chromium windows, as Deck and a pop-out run it, each with its own
// event hub and an in-memory service. The pop-out attaches: it may read, approve and follow
// events, but it never creates or closes the room the Deck window owns.
test('a popped-out chat waits for Deck, approves for both windows, and never closes the room', { timeout: 200000 }, async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-attach-'));
  const html = `<html><body><div id="test-root"></div><script type="module">
    import React from 'react'; import {createRoot} from 'react-dom/client';
    import {ChatPane} from '/src/ChatPane.tsx'; import {getBackend} from '/src/backend.ts'; import '/src/styles.css';
    const root=createRoot(document.getElementById('test-root'));
    const bot={id:'bot',display_name:'Bot',persona:'',access:'read',effort:null,backend:{kind:'scripted',lines:['[pass]']}};
    const state=()=>({recovery_seq:1,snapshot:{participants:[bot],options:{policy:'mention',max_bot_hops:3},transcript:[]},active:['bot'],approvals:[{id:'bot',request:'req-1',action:{kind:'command',title:'Run ls',detail:'ls'}}]});
    window.fixture={calls:[],misses:0,listeners:[],
      mount(attach){root.render(React.createElement(ChatPane,{pane:{id:'r1',workspaceId:'w1',kind:'chat',title:'Thread'},cwd:'/tmp/project',agents:[],backend,focused:true,onActivity(){},profiles:[],onProfilesChange(){},disabledProviders:[],attach}));},
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
    window.ready=true;
  </script></body></html>`;
  // Its own dependency cache, as in bot-settings.test.mjs: parallel Vite servers race on a shared one.
  const server = await createServer({ cacheDir: path.join(temp, 'vite-cache'), server: { port: 0 }, logLevel: 'error', plugins: [{ name: 'chat-attach-test', configureServer(server) { server.middlewares.use('/__chat_attach_test', async (_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(await server.transformIndexHtml('/__chat_attach_test', html)); }); } }] });
  await server.listen();
  const url = `http://localhost:${server.httpServer.address().port}/__chat_attach_test`;
  const main = path.join(temp, 'main.cjs');
  fs.writeFileSync(main, `
    const {app,BrowserWindow}=require('electron'); const assert=require('node:assert/strict');
    app.whenReady().then(async()=>{
      const open=async name=>{
        const win=new BrowserWindow({show:false,width:1000,height:800,webPreferences:{contextIsolation:true}});
        win.webContents.on('console-message',(_e,...args)=>console.log(name,...args));
        await win.loadURL(${JSON.stringify(url)}); return win;
      };
      const run=(win,fn)=>win.webContents.executeJavaScript('('+fn.toString()+')()');
      const wait=async(win,fn,what)=>{for(let i=0;i<800;i++){if(await run(win,fn))return;await new Promise(r=>setTimeout(r,25));}throw Error('Timed out: '+what+' '+JSON.stringify(await run(win,()=>({calls:window.fixture?.calls,body:document.body.innerText.slice(0,800)}))));};
      try {
        const deck=await open('deck'); const popout=await open('popout');
        await wait(deck,()=>window.ready,'deck page'); await wait(popout,()=>window.ready,'pop-out page');
        // The Deck window owns the room.
        await run(deck,()=>window.fixture.mount(false));
        await wait(deck,()=>document.querySelector('.approval [data-answer="once"]:not([disabled])'),'Deck approval card');
        assert.ok(await run(deck,()=>window.fixture.count('roomCreate'))>=1,'Deck opens the room');
        // The pop-out reads before Deck has the room, as after a service restart: it waits and
        // reads again on its own, with no reconnect, and never creates the room.
        await run(popout,()=>{window.fixture.misses=2;window.fixture.mount(true);});
        await wait(popout,()=>document.querySelector('textarea')?.placeholder==='Waiting for Deck…','waiting placeholder');
        await wait(popout,()=>document.querySelector('.approval [data-answer="once"]:not([disabled])'),'pop-out approval card after two misses');
        assert.equal(await run(popout,()=>window.fixture.count('roomState')),3,'two misses, then the read that worked');
        assert.equal(await run(popout,()=>window.fixture.count('roomCreate')),0,'the pop-out never creates the room');
        assert.equal(await run(popout,()=>document.body.innerText.includes('Could not load the chat')),false,'waiting adds no error notices');
        // Approve in the pop-out. The service resolves it for every window watching the room.
        await run(popout,()=>document.querySelector('.approval [data-answer="once"]').click());
        await wait(popout,()=>window.fixture.count('roomDecide')===1,'decision sent');
        assert.deepEqual(await run(popout,()=>window.fixture.calls.find(c=>c[0]==='roomDecide')),['roomDecide','r1','req-1',true,false]);
        const resolved={type:'approval_resolved',id:'bot',request:'req-1',approved:true,recovery_seq:2};
        for(const win of [deck,popout]) await win.webContents.executeJavaScript('window.fixture.emit('+JSON.stringify(resolved)+')');
        await wait(deck,()=>!document.querySelector('.approval[data-request="req-1"]'),'card resolved in Deck');
        await wait(popout,()=>!document.querySelector('.approval[data-request="req-1"]'),'card resolved in the pop-out');
        // Closing the pop-out's view leaves the room open, and Deck's chat stays usable.
        await run(popout,()=>window.fixture.unmount());
        await new Promise(r=>setTimeout(r,300));
        assert.equal(await run(popout,()=>window.fixture.count('roomClose')),0,'the pop-out never closes the room');
        assert.equal(await run(deck,()=>document.querySelector('textarea')?.disabled),false,'Deck chat still ready');
        // Control: the Deck window's own view does close its room when it goes away.
        await run(deck,()=>window.fixture.unmount());
        await wait(deck,()=>window.fixture.count('roomClose')===1,'Deck closes its own room');
        console.log('Chat attach Chromium checks passed'); app.exit(0);
      }catch(error){console.error(error.stack);app.exit(1);}
    });
  `);
  try {
    const result = await runElectronScenario(electron, main, temp);
    assert.equal(result.code, 0, result.output);
  } finally { await server.close(); fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});
