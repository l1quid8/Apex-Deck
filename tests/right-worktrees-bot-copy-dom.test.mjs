import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import electron from 'electron';
import { createServer } from 'vite';
import { runElectronScenario } from './helpers/electron-test.mjs';

test('copy tab has no check setup, confirms discard and renders stalled and active rows', {timeout:120000}, async () => {
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'apex-copy-tab-dom-'));
  const screenshot=process.env.APEX_COPY_TAB_SCREENSHOT;
  const html=`<html data-deck-theme="clay"><body><main style="width:380px;max-width:100%;margin:16px auto"><h2>Worktrees</h2><div id="root"></div></main><script type="module">
    import React from'react';import{createRoot}from'react-dom/client';import{RightWorktreesTab}from'/src/RightWorktrees.tsx';import'/src/styles.css';import'/src/right-panel.css';import'/src/clay-theme.css';
    const copies=[['Forge','Fix search','needs_you','project check failed'],['Null','Update filters','folding',null],['Jigga','Review labels','reconciling',null]];
    window.saves=[];window.removes=[];window.opened=[];
    let items=[{path:'/repo',branch:'main',main:true,changes:0},...copies.map(([bot,threadTitle,state,reason],i)=>({path:'/copies/'+bot+'/work',branch:null,locked:true,changes:i+1,copy:{bot,thread:'thread-'+i,threadTitle,state,reason}}))].map(x=>({head:'abcd1234',main:false,locked:false,prunable:false,changes:0,task:false,...x}));
    const backend={worktreeList:async()=>({root:'/repo',items,checkCommand:'npx tsc --noEmit'}),botCopiesSetCheck:async(root,cmd)=>{window.saves.push([root,cmd]);},worktreeRemove:async(root,target,force)=>{window.removes.push([root,target,force]);if(!force)throw Error('has-changes:confirm');items=items.filter(i=>i.path!==target);}};
    createRoot(document.getElementById('root')).render(React.createElement(RightWorktreesTab,{root:'/repo',backend,visible:true,onMount(){},onOpen(p){window.opened.push(p);}}));
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
        // The check setup is gone: no field, no label, no status, and no save call.
        assert.equal(await run(()=>document.querySelector('.right-worktrees-check')),null);
        assert.equal(await run(()=>document.body.innerText.includes('Check after each fold-back')),false);
        assert.equal(await run(()=>document.querySelectorAll('.right-worktrees input').length),0);
        assert.equal(await run(()=>window.saves.length),0);
        // Retained copy: Needs you, its reason and its path, plus Fixing a clash while repair runs.
        await wait(()=>document.body.innerText.includes('Needs you')&&document.body.innerText.includes('project check failed'));
        assert.equal(await run(()=>document.body.innerText.includes('Fixing a clash')),true);
        assert.equal(await run(()=>document.body.innerText.includes('/copies/Forge/work')),true);
        assert.equal(await run(()=>Array.from(document.querySelectorAll('.is-bot-copy button')).some(b=>['Mount','Remove','Prune'].includes(b.textContent))),false);
        await run(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
        if(${JSON.stringify(screenshot ?? '')}) fs.writeFileSync(${JSON.stringify(screenshot ?? '')},(await win.webContents.capturePage()).toPNG());
        // The ⋯ menu keeps exactly the three approved actions for a stalled copy.
        await run(()=>document.querySelector('.is-bot-copy summary').click());
        assert.deepEqual(await run(()=>Array.from(document.querySelector('.is-bot-copy .right-worktrees-menu-items').querySelectorAll('button')).map(b=>b.textContent)),['Open folder','Copy pathname','Discard copy']);
        await run(()=>Array.from(document.querySelector('.is-bot-copy .right-worktrees-menu-items').querySelectorAll('button')).find(b=>b.textContent==='Open folder').click());
        assert.deepEqual(await run(()=>window.opened),['/copies/Forge/work']);
        // Discard asks first; Cancel keeps the row; confirming discards it.
        await run(()=>document.querySelector('.is-bot-copy summary').click());
        await run(()=>Array.from(document.querySelector('.is-bot-copy').querySelectorAll('button')).find(b=>b.textContent==='Discard copy').click());
        await wait(()=>document.body.innerText.includes('Discard this copy and all its changes?'));
        assert.equal(await run(()=>document.querySelectorAll('.right-worktrees-row').length),4);
        await run(()=>Array.from(document.querySelector('.is-bot-copy').querySelectorAll('button')).find(b=>b.textContent==='Cancel').click());
        await wait(()=>!document.body.innerText.includes('Discard this copy and all its changes?'));
        assert.equal(await run(()=>document.querySelectorAll('.right-worktrees-row').length),4);
        assert.deepEqual(await run(()=>window.removes),[['/repo','/copies/Forge/work',false]]);
        await run(()=>document.querySelector('.is-bot-copy summary').click());
        await run(()=>Array.from(document.querySelector('.is-bot-copy').querySelectorAll('button')).find(b=>b.textContent==='Discard copy').click());
        await wait(()=>document.body.innerText.includes('Discard this copy and all its changes?'));
        await run(()=>Array.from(document.querySelector('.is-bot-copy').querySelectorAll('button')).find(b=>b.textContent==='Discard copy').click());
        await wait(()=>document.querySelectorAll('.right-worktrees-row').length===3);
        assert.deepEqual(await run(()=>window.removes.at(-1)),['/repo','/copies/Forge/work',true]);
        assert.equal(await run(()=>window.removes.filter(r=>r[2]).length),1);
        app.exit(0);
      }catch(e){console.error(e);app.exit(1);}});`);
    const result=await runElectronScenario(electron,main,temp);
    assert.equal(result.code,0,result.output);
  } finally { await server.close();fs.rmSync(temp,{recursive:true,force:true}); }
});
