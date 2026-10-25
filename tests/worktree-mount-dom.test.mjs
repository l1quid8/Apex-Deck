import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import electron from 'electron';
import { createServer } from 'vite';
import { runElectronScenario } from './helpers/electron-test.mjs';

test('Mount queues, cancels, follows the original chat across focus changes and protects the live checkout', {timeout:120000}, async()=>{
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'apex-mount-dom-'));
  const html=`<html data-deck-theme="clay"><body><div id="root"></div><script type="module">
    import React,{useState}from'react';import{createRoot}from'react-dom/client';import{RightWorktreesTab}from'/src/RightWorktrees.tsx';import{useWorktreeMount}from'/src/useWorktreeMount.ts';import{chatFolder}from'/src/worktreeMount.ts';import'/src/styles.css';import'/src/right-panel.css';import'/src/clay-theme.css';
    const items=[{path:'/repo',branch:'main',main:true},{path:'/tree',branch:'feat/mount',changes:2},{path:'/missing',branch:'old',prunable:true}].map(x=>({head:'abc',locked:false,prunable:false,changes:0,task:false,...x}));window.actions=[];const folders={a:'/repo',b:'/repo'};const route={worktreeList:async()=>({root:'/repo',items}),call:async(cmd,args)=>{window.actions.push([cmd,args]);folders[args.id]=args.cwd;return{cwd:args.cwd};},roomCreate:async(id)=>{window.actions.push(['room_create',id]);return{};},roomState:async(id)=>({cwd:folders[id]})};
    function Harness(){const[panes,setPanes]=useState([{id:'a',workspaceId:'project',kind:'chat'},{id:'b',workspaceId:'project',kind:'chat'}]);const[busy,setBusy]=useState(true);const[focus,setFocus]=useState('a');const[error,setError]=useState('');const status={a:{busy,replying:busy?['Null']:[],waiting:[]},b:{busy:false,replying:[],waiting:[]}};const mounts=useWorktreeMount({panes,workspaces:[{id:'project',path:'/repo'}],status,options:{policy:'mention'},setFolder:(id,cwd)=>setPanes(all=>all.map(p=>p.id===id?{...p,mount:cwd}:p)),error:setError});const pane=panes.find(p=>p.id===focus);return React.createElement(React.Fragment,null,React.createElement('h2',null,'Worktrees'),React.createElement('button',{id:'start',onClick:()=>setBusy(true)},'Start turn'),React.createElement('button',{id:'close-chat',onClick:()=>setPanes(all=>all.map(p=>p.id===focus?{...p,closed:true}:p))},'Close chat'),React.createElement('button',{id:'finish',onClick:()=>setBusy(false)},'Finish turn'),React.createElement('button',{id:'focus',onClick:()=>setFocus(f=>f==='a'?'b':'a')},'Switch chat'),React.createElement('p',{id:'folder'},focus+': '+chatFolder(pane,{path:'/repo'})),React.createElement('p',{role:'alert'},error),React.createElement(RightWorktreesTab,{root:'/repo',backend:route,visible:true,mounted:chatFolder(pane,{path:'/repo'}),pendingMount:mounts.pending[focus]?.path,busyTurn:status[focus].busy,onMount:path=>mounts.request(pane,path,route),onCancelMount:()=>mounts.cancel(focus),onOpen(){}}));}createRoot(document.getElementById('root')).render(React.createElement(Harness));
  </script></body></html>`;
  const server=await createServer({cacheDir:path.join(temp,'cache'),server:{port:0},logLevel:'error',plugins:[{name:'mount-fixture',configureServer(s){s.middlewares.use('/__mount',async(_req,res)=>{res.setHeader('Content-Type','text/html');res.end(await s.transformIndexHtml('/__mount',html));});}}]});await server.listen();
  const url=`http://localhost:${server.httpServer.address().port}/__mount`;const main=path.join(temp,'main.cjs');
  fs.writeFileSync(main,`
    const{app,BrowserWindow}=require('electron');const assert=require('node:assert/strict');app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,width:650,height:500,webPreferences:{contextIsolation:true,backgroundThrottling:false}});const run=fn=>win.webContents.executeJavaScript('('+fn.toString()+')()');const wait=async fn=>{for(let i=0;i<200;i++){if(await run(fn))return;await new Promise(r=>setTimeout(r,25));}throw Error('Timed out '+fn+' '+await run(()=>document.body.innerText));};try{
    await win.loadURL(${JSON.stringify(url)});await wait(()=>document.querySelectorAll('.right-worktrees-row').length===3);
    assert.equal(await run(()=>Array.from(document.querySelectorAll('.right-worktrees-row'))[2].innerText.includes('Mount')),false,'missing folder cannot mount');
    await run(()=>{const row=document.querySelectorAll('.right-worktrees-row')[1];row.querySelector('summary').click();Array.from(row.querySelectorAll('button')).find(b=>b.textContent==='Mount after this turn').click();});await wait(()=>document.body.innerText.includes('After this turn'));
    assert.equal(await run(()=>window.actions.length),0,'busy room does not switch');
    await run(()=>Array.from(document.querySelectorAll('.right-worktrees-row')[1].querySelectorAll('button')).find(b=>b.textContent==='Cancel').click());await wait(()=>!document.body.innerText.includes('After this turn'));
    await run(()=>{const row=document.querySelectorAll('.right-worktrees-row')[1];row.querySelector('summary').click();Array.from(row.querySelectorAll('button')).find(b=>b.textContent==='Mount after this turn').click();});await wait(()=>document.body.innerText.includes('After this turn'));
    await run(()=>document.getElementById('focus').click());await wait(()=>document.getElementById('folder').textContent==='b: /repo');await run(()=>document.getElementById('finish').click());await wait(()=>window.actions.some(a=>a[0]==='room_mount'));
    assert.deepEqual(await run(()=>window.actions.find(a=>a[0]==='room_mount')[1]),{id:'a',cwd:'/tree'},'request remains attached to original chat');assert.equal(await run(()=>document.getElementById('folder').textContent),'b: /repo');
    await run(()=>document.getElementById('focus').click());await wait(()=>document.getElementById('folder').textContent==='a: /tree');
    assert.equal(await run(()=>{const row=document.querySelectorAll('.right-worktrees-row')[1];return Array.from(row.querySelectorAll('button')).filter(b=>['✓ Mounted','Remove','Prune'].includes(b.textContent)).every(b=>b.disabled);}),true);
    await run(()=>document.getElementById('start').click());
    await run(()=>{const row=document.querySelectorAll('.right-worktrees-row')[0];row.querySelector('summary').click();Array.from(row.querySelectorAll('button')).find(b=>b.textContent==='Mount after this turn').click();});await wait(()=>document.body.innerText.includes('After this turn'));
    await run(()=>document.getElementById('close-chat').click());await run(()=>document.getElementById('finish').click());
    await new Promise(r=>setTimeout(r,1000));
    assert.equal(await run(()=>document.getElementById('folder').textContent),'a: /tree','closing a chat cancels a queued switch');
    const image=await win.webContents.capturePage();require('node:fs').writeFileSync('/tmp/apex-worktree-mount-ui.png',image.toPNG());console.log('Mount DOM flow passed');app.exit(0);
    }catch(e){console.error(e.stack);app.exit(1);}});`);
  try{const result=await runElectronScenario(electron,main,temp,{timeoutMs:45000});assert.equal(result.code,0,result.output);}finally{await server.close();fs.rmSync(temp,{recursive:true,force:true});}
});
