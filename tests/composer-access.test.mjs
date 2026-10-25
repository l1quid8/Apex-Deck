import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import electron from 'electron';
import { createServer } from 'vite';
import { runElectronScenario } from './helpers/electron-test.mjs';


// Exercise chip metadata and the real quick-menu save path through a busy turn.
test('composer access switches immediately, persists, and marks a busy change until idle', {timeout:200000}, async()=>{
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'composer-access-'));
  const html = `<html><body><div id="test-root"></div><script type="module">
    import React from 'react'; import {createRoot} from 'react-dom/client';
    import {ChatPane} from '/src/ChatPane.tsx'; import {getBackend} from '/src/backend.ts'; import {applyAppearance, BUILTIN_SKINS} from '/src/themes.ts'; import '/src/styles.css'; import '/src/glass-theme.css'; import '/src/clay-theme.css'; import '/src/bot-chip-styles.css';
    const root=createRoot(document.getElementById('test-root'));
    let bot={id:'bot',display_name:'Bot',persona:'',access:'read',effort:null,backend:{kind:'agent',tool:'claude_code',model:'sonnet'}};
    const state=()=>({recovery_seq:1,snapshot:{participants:[bot],options:{policy:'mention',max_bot_hops:3},transcript:[]},active:['bot'],approvals:[{id:'bot',request:'req-1',action:{kind:'command',title:'Run ls',detail:'ls'}}]});
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
      agentModels:async()=>[],
      roomUpdateParticipant:log('roomUpdateParticipant',async(_id,config)=>{if(window.fixture.fail)throw Error('Save failed');bot=config;window.fixture.emit({type:'participant_changed',participant:bot});return bot;}),
      onRoomEvent:async fn=>{window.fixture.listeners.push(fn);return()=>{};},
      onPtyData:async()=>()=>{},onPtyExit:async()=>()=>{},
    };
    window.setTestSkin=(id)=>{applyAppearance(document.documentElement,BUILTIN_SKINS.find(s=>s.id===id).appearance);}; window.ready=true; document.body.style.height='100vh'; document.getElementById('test-root').style.cssText='height:100vh;display:flex';
  </script></body></html>`;

  const server=await createServer({cacheDir:path.join(temp,'vite-cache'),server:{port:0},logLevel:'error',plugins:[{name:'access-test',configureServer(server){server.middlewares.use('/__access_test',async(_req,res)=>{res.setHeader('Content-Type','text/html');res.end(await server.transformIndexHtml('/__access_test',html));});}}]});
  await server.listen();
  const main=path.join(temp,'main.cjs');
  fs.writeFileSync(main, `
    const {app,BrowserWindow}=require('electron');const assert=require('node:assert/strict');const fs=require('node:fs');
    app.whenReady().then(async()=>{
      const win=new BrowserWindow({show:false,width:1200,height:850});
      const run=fn=>win.webContents.executeJavaScript('('+fn.toString()+')()');
      const wait=async fn=>{for(let i=0;i<300;i++){if(await run(fn))return;await new Promise(r=>setTimeout(r,20));}throw Error('Timed out '+fn);};
      try{
        await win.loadURL('http://localhost:${server.httpServer.address().port}/__access_test');
        await wait(()=>window.ready);await run(()=>window.fixture.mount('classic'));
        await wait(()=>document.querySelector('.chip-access')?.textContent==='Read-only');
        await run(()=>document.querySelector('.chip-name').click());
        await wait(()=>document.querySelector('.bot-access button'));
        await run(()=>Array.from(document.querySelectorAll('.bot-access button')).find(b=>b.textContent==='Full').click());
        await wait(()=>document.querySelector('.chip-access')?.textContent.includes('Full'));
        await wait(()=>document.querySelector('.chip-access')?.textContent.includes('after this reply'));
        assert.equal(await run(()=>window.fixture.count('roomUpdateParticipant')),1,'no confirmation step');
        assert.equal(await run(()=>document.querySelector('.bot-access-note').textContent.includes('after this reply')),true);
        const fullStyle=await run(()=>{const c=getComputedStyle(document.querySelector('.chip-access'));return {border:c.borderWidth,background:c.backgroundColor,color:c.color};});
        assert.equal(fullStyle.border,'0px','no nested pill');assert.equal(fullStyle.background,'rgba(0, 0, 0, 0)');
        await run(()=>window.fixture.emit({type:'participant_idle',id:'bot'}));
        await wait(()=>document.querySelector('.chip-access')?.textContent==='Full');
        await run(()=>document.querySelector('.chip-name').click());await run(()=>document.querySelector('.chip-name').click());
        await wait(()=>document.querySelector('.bot-access [aria-checked="true"]')?.textContent==='Full');
        fs.writeFileSync('/tmp/apex-access-v4.png',(await win.webContents.capturePage()).toPNG());
        await run(()=>{window.fixture.fail=true;Array.from(document.querySelectorAll('.bot-access button')).find(b=>b.textContent==='Read-only').click();});
        await wait(()=>document.querySelector('.bot-settings [role="alert"]'));
        assert.equal(await run(()=>document.querySelector('.bot-access [aria-checked="true"]').textContent),'Full','failed save restores saved access');
        assert.equal(await run(()=>document.querySelector('.chip-access').textContent),'Full');
        await run(()=>{window.fixture.fail=false;Array.from(document.querySelectorAll('.bot-access button')).find(b=>b.textContent==='Read-only').click();});
        await wait(()=>document.querySelector('.chip-access')?.textContent==='Read-only');
        assert.equal(await run(()=>getComputedStyle(document.querySelector('.chip-access')).color),fullStyle.color,'all levels use neutral styling');
        await run(()=>document.querySelector('.chip-name').click());
        await run(()=>document.querySelector('.chips-fold').click());
        assert.equal(await run(()=>document.querySelector('.chip-name').getAttribute('aria-label').includes('Access: Read-only')),true,'folded accessible access');
        await run(()=>document.querySelector('.chips-fold').click());
        win.setSize(440,850);await new Promise(r=>setTimeout(r,100));
        assert.equal(await run(()=>document.querySelector('.chip-name').getBoundingClientRect().width>0),true);
        app.exit(0);
      }catch(error){console.error(error.stack);app.exit(1);}
    });
  `);
  try{const result=await runElectronScenario(electron,main,temp);assert.equal(result.code,0,result.output);}
  finally{await server.close();fs.rmSync(temp,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});
