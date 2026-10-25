import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import electron from 'electron';
import { createServer } from 'vite';
import { runElectronScenario } from './helpers/electron-test.mjs';

test('copy tab saves checks, confirms discard and renders stalled and active rows', {timeout:120000}, async () => {
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'apex-copy-tab-dom-'));
  const screenshot=process.env.APEX_COPY_TAB_SCREENSHOT;
  const html=`<html data-deck-theme="clay"><body><main style="width:380px;max-width:100%;margin:16px auto"><h2>Worktrees</h2><div id="root"></div></main><script type="module">
    import React from'react';import{createRoot}from'react-dom/client';import{RightWorktreesTab}from'/src/RightWorktrees.tsx';import'/src/styles.css';import'/src/right-panel.css';import'/src/clay-theme.css';
    const copies=[['Forge','Fix search','needs_you','The project check failed. Its copy is kept for you.'],['Null','Update filters','folding',null],['Jigga','Review labels','reconciling',null]];
    let check='npx tsc --noEmit';window.saves=[];window.removes=[];
    let items=[{path:'/repo',branch:'main',main:true,changes:0},...copies.map(([bot,threadTitle,state,reason],i)=>({path:'/copies/'+bot+'/work',branch:null,locked:true,changes:i+1,copy:{bot,thread:'thread-'+i,threadTitle,state,reason}}))].map(x=>({head:'abcd1234',main:false,locked:false,prunable:false,changes:0,task:false,...x}));
    const backend={worktreeList:async()=>({root:'/repo',items,checkCommand:check}),botCopiesSetCheck:async(root,cmd)=>{window.saves.push([root,cmd]);check=cmd;},worktreeRemove:async(root,target,force)=>{window.removes.push([root,target,force]);if(!force)throw Error('has-changes:confirm');items=items.filter(i=>i.path!==target);}};
    createRoot(document.getElementById('root')).render(React.createElement(RightWorktreesTab,{root:'/repo',backend,visible:true,onMount(){},onOpen(){}}));
  </script></body></html>`;
  const server=await createServer({cacheDir:path.join(temp,'cache'),server:{port:0},logLevel:'error',plugins:[{name:'copy-tab-fixture',configureServer(s){s.middlewares.use('/__copy_tab',async(_req,res)=>{res.setHeader('Content-Type','text/html');res.end(await s.transformIndexHtml('/__copy_tab',html));});}}]});
  try {
    await server.listen();
    const url=`http://localhost:${server.httpServer.address().port}/__copy_tab`;
    const main=path.join(temp,'main.cjs');
    fs.writeFileSync(main,`
      const{app,BrowserWindow}=require('electron');const fs=require('node:fs');const assert=require('node:assert/strict');
      app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,width:440,height:740,webPreferences:{contextIsolation:true,backgroundThrottling:false}});const run=fn=>win.webContents.executeJavaScript('('+fn.toString()+')()');const wait=async fn=>{for(let i=0;i<240;i++){if(await run(fn))return;await new Promise(r=>setTimeout(r,25));}throw Error('Timed out '+fn);};try{
        await win.loadURL(${JSON.stringify(url)});await wait(()=>document.querySelectorAll('.right-worktrees-row').length===4);
        assert.equal(await run(()=>document.querySelector('.right-worktrees-check input').value),'npx tsc --noEmit');
        assert.equal(await run(()=>document.body.innerText.includes('Needs you')),true);
        assert.equal(await run(()=>Array.from(document.querySelectorAll('.is-bot-copy button')).some(b=>['Mount','Remove','Prune'].includes(b.textContent))),false);
        await run(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
        if(${JSON.stringify(screenshot ?? '')}) fs.writeFileSync(${JSON.stringify(screenshot ?? '')},(await win.webContents.capturePage()).toPNG());
        await run(()=>{const i=document.querySelector('.right-worktrees-check input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,'cargo check');i.dispatchEvent(new Event('input',{bubbles:true}));});
        await run(()=>document.querySelector('.right-worktrees-check button').click());await wait(()=>window.saves.length===1);
        assert.deepEqual(await run(()=>window.saves[0]),['/repo','cargo check']);await wait(()=>document.body.innerText.includes('Check saved'));
        await run(()=>{const i=document.querySelector('.right-worktrees-check input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,'');i.dispatchEvent(new Event('input',{bubbles:true}));});
        await run(()=>document.querySelector('.right-worktrees-check button').click());await wait(()=>window.saves.length===2);assert.deepEqual(await run(()=>window.saves[1]),['/repo',null]);await wait(()=>document.body.innerText.includes('Check turned off'));
        await run(()=>{const r=document.querySelector('.is-bot-copy');r.querySelector('summary').click();Array.from(r.querySelectorAll('button')).find(b=>b.textContent==='Discard copy').click();});
        await wait(()=>document.body.innerText.includes('Discard this copy and all its changes?'));assert.equal(await run(()=>document.querySelectorAll('.right-worktrees-row').length),4);
        await run(()=>Array.from(document.querySelector('.is-bot-copy').querySelectorAll('button')).find(b=>b.textContent==='Discard copy').click());
        await wait(()=>document.querySelectorAll('.right-worktrees-row').length===3);assert.equal(await run(()=>window.removes[1][2]),true);
        app.exit(0);
      }catch(e){console.error(e);app.exit(1);}});`);
    const result=await runElectronScenario(electron,main,temp);
    assert.equal(result.code,0,result.output);
  } finally { await server.close();fs.rmSync(temp,{recursive:true,force:true}); }
});
