import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import electron from 'electron';
import { createServer } from 'vite';
import { runElectronScenario } from './helpers/electron-test.mjs';

test('Inline Git card toggles and moves between replies, clears top-bar scope, and preserves guarded actions', {timeout:120000}, async()=>{
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'apex-git-menu-dom-'));
  const html=`<html data-deck-theme="clay"><body><div id="root"></div><script type="module">
    import React,{useState} from 'react';import{createRoot}from'react-dom/client';import{GitChangesMenu}from'/src/GitChangesMenu.tsx';import{ChangedFilesStrip}from'/src/ChangedFilesStrip.tsx';import'/src/styles.css';import'/src/clay-theme.css';
    let live={root:'/repo',head:'abc',tree:'tree',branch:'feat/default-voice',target:'main',targetHead:'base',ahead:2,behind:0,checksPassed:false,clean:false,files:[{path:'AgentVoicePicker.tsx',added:78,removed:1,patch:'diff --git a/AgentVoicePicker.tsx b/AgentVoicePicker.tsx\\n+ saveVoice();',stagedOnly:false},{path:'agentPreferences.ts',added:24,removed:1,patch:'+ preferences',stagedOnly:false},{path:'voiceSelection.test.ts',added:32,removed:0,patch:'+ test',stagedOnly:false}]};
    const backend={call:async(cmd,args)=>{if(cmd==='room_git_status')return live;window.actions.push(args.action);if(args.action.kind==='commit')live={...live,files:[],head:'new',tree:'new-tree',ahead:3,clean:true};if(args.action.kind==='checks')live={...live,checksPassed:true};return{state:live,message:'Fixture action succeeded'};}};window.actions=[];
    function Harness(){const[request,setRequest]=useState(null);const[seq,setSeq]=useState(null);const[target,setTarget]=useState(null);const close=React.useCallback(()=>{setRequest(null);setSeq(null);},[]);function open(n,paths){if(seq===n&&request&&paths!==null){close();return;}setSeq(n);setRequest(r=>({paths,nonce:(r?.nonce??0)+1}));}return React.createElement(React.Fragment,null,React.createElement('div',{style:{display:'flex',justifyContent:'end',padding:'8px',height:'48px',overflow:'hidden'}},React.createElement(GitChangesMenu,{backend,room:'fixture',cwd:'/repo',active:true,ready:true,revision:0,request,target,canOpen:true,onOpen(){open(2,null);},onClose:close,onReview(){window.reviewed=true;},onChanged(){}})),...[1,2].map(n=>React.createElement('article',{key:n,id:'reply-'+n,style:{margin:'10px',padding:'8px',border:'1px solid gray',minWidth:0}},React.createElement('p',null,'Reply '+n),React.createElement(ChangedFilesStrip,{files:[{path:n===1?'/repo/AgentVoicePicker.tsx':'/repo/agentPreferences.ts',added:24,removed:1}],expanded:seq===n&&!!request,onOpenTurn(){open(n,[n===1?'/repo/AgentVoicePicker.tsx':'/repo/agentPreferences.ts']);}}),seq===n&&React.createElement('div',{className:'git-changes-slot',ref:setTarget}))));}createRoot(document.getElementById('root')).render(React.createElement(Harness));
  </script></body></html>`;
  const server=await createServer({cacheDir:path.join(temp,'cache'),server:{port:0},logLevel:'error',plugins:[{name:'git-menu-fixture',configureServer(s){s.middlewares.use('/__git_menu',async(_req,res)=>{res.setHeader('Content-Type','text/html');res.end(await s.transformIndexHtml('/__git_menu',html));});}}]});
  await server.listen();
  const url=`http://localhost:${server.httpServer.address().port}/__git_menu`;
  const main=path.join(temp,'main.cjs');
  fs.writeFileSync(main,`
    const{app,BrowserWindow}=require('electron');const assert=require('node:assert/strict');
    app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,width:360,height:500,webPreferences:{contextIsolation:true,backgroundThrottling:false}});const run=fn=>win.webContents.executeJavaScript('('+fn.toString()+')()');const wait=async fn=>{for(let i=0;i<200;i++){if(await run(fn))return;await new Promise(r=>setTimeout(r,25));}throw Error('Timed out: '+fn+' '+await run(()=>document.body.innerText));};try{
      await win.loadURL(${JSON.stringify(url)});await wait(()=>document.querySelector('.git-changes-trigger')?.getAttribute('aria-label')==='Changes · 3');
      await run(()=>document.querySelector('.turn-files-strip').click());await wait(()=>document.querySelector('.git-file-row input')?.checked);
      assert.deepEqual(await run(()=>Array.from(document.querySelectorAll('.git-file-row input')).map(i=>i.checked)),[true],'only the scoped file is listed');
      assert.equal(await run(()=>document.querySelectorAll('.git-file-entry.is-unselected').length),0,'unselected files stay collapsed by default');
      assert.equal(await run(()=>document.querySelector('.git-unselected-toggle').textContent),'▶ 2 unselected files','the collapsed group names how many files it hides');
      assert.equal(await run(()=>!!document.querySelector('#reply-1 .git-changes-slot .git-changes-menu')),true,'card is inside clicked reply');
      assert.equal(await run(()=>{const r=document.querySelector('.git-changes-menu').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth;}),true,'card fits narrow reply without horizontal overflow');
      await run(()=>document.querySelector('#reply-1 .turn-files-strip').click());await wait(()=>!document.querySelector('.git-changes-menu'));
      await run(()=>document.querySelector('#reply-1 .turn-files-strip').click());await wait(()=>document.querySelector('#reply-1 .git-changes-menu'));
      await run(()=>document.querySelector('.git-changes-trigger').click());await wait(()=>document.querySelector('#reply-2 .git-changes-menu'));
      await wait(()=>document.querySelectorAll('.git-turn-mark').length===0);
      assert.deepEqual(await run(()=>Array.from(document.querySelectorAll('.git-file-row input')).map(i=>i.checked)),[true,true,true],'top-bar moves an open scoped card to latest reply and clears scope');
      await run(()=>document.querySelector('#reply-1 .turn-files-strip').click());await wait(()=>document.querySelector('#reply-1 .git-changes-menu'));
      await run(()=>document.querySelector('#reply-2 .turn-files-strip').click());await wait(()=>document.querySelector('#reply-2 .git-changes-menu'));
      assert.equal(await run(()=>document.querySelectorAll('.git-changes-menu').length),1);
      assert.deepEqual(await run(()=>Array.from(document.querySelectorAll('.git-file-row input')).map(i=>i.checked)),[true],'only the newly scoped file is listed');
      await run(()=>document.querySelector('.git-unselected-toggle').click());await wait(()=>document.querySelectorAll('.git-file-row input').length===3);
      assert.deepEqual(await run(()=>Array.from(document.querySelectorAll('.git-file-row input')).map(i=>i.checked)),[true,false,false],'expanding reveals the unselected files unchecked');
      await run(()=>document.body.click());assert.equal(await run(()=>!!document.querySelector('.git-changes-menu')),true,'clicking elsewhere leaves the inline card open');
      await run(()=>document.querySelector('.git-file-name').click());await wait(()=>document.querySelector('.git-file-patch'));assert.match(await run(()=>document.querySelector('.git-file-patch').textContent),/preferences/);
      const image=await win.webContents.capturePage();require('node:fs').writeFileSync('/tmp/apex-git-menu-ui.png',image.toPNG());
      await run(()=>window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})));await wait(()=>!document.querySelector('.git-changes-menu'));assert.equal(await run(()=>document.activeElement.classList.contains('turn-files-strip')),true);
      await run(()=>document.querySelector('.git-changes-trigger').click());await wait(()=>document.querySelector('#reply-2 .git-changes-menu'));
      await wait(()=>document.querySelectorAll('.git-turn-mark').length===0);
      assert.deepEqual(await run(()=>Array.from(document.querySelectorAll('.git-file-row input')).map(i=>i.checked)),[true,true,true]);
      await run(()=>document.querySelector('[aria-label="Close changes"]').click());await wait(()=>!document.querySelector('.git-changes-menu'));
      assert.equal(await run(()=>document.activeElement.classList.contains('git-changes-trigger')),true,'close restores focus to the opener');
      await run(()=>document.querySelector('#reply-1 .turn-files-strip').click());await wait(()=>document.querySelector('#reply-1 .git-changes-menu'));
      await run(()=>{const input=document.querySelector('.git-commit-row input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'Save default voice');input.dispatchEvent(new Event('input',{bubbles:true}));});await wait(()=>!document.querySelector('.git-commit-row button').disabled);
      await run(()=>document.querySelector('.git-commit-row').requestSubmit());await wait(()=>window.actions.length===1);assert.deepEqual(await run(()=>window.actions[0].paths),['AgentVoicePicker.tsx']);await wait(()=>!document.querySelector('.git-commit-row'));
      assert.equal(await run(()=>Array.from(document.querySelectorAll('.git-branch-actions button')).find(b=>b.textContent==='Merge').disabled),true);
      await run(()=>document.querySelector('.git-step-rail button').click());await wait(()=>Array.from(document.querySelectorAll('.git-branch-actions button')).find(b=>b.textContent==='Merge').disabled===false);
      await run(()=>Array.from(document.querySelectorAll('.git-branch-actions button')).find(b=>b.textContent==='Merge').click());await wait(()=>document.querySelector('.git-confirm'));assert.equal(await run(()=>window.actions.length),2,'merge waits for explicit confirmation');
      console.log('Git menu DOM flow passed');app.exit(0);
    }catch(e){console.error(e.stack);app.exit(1);}});`);
  try{const result=await runElectronScenario(electron,main,temp,{timeoutMs:45000});assert.equal(result.code,0,result.output);}finally{await server.close();fs.rmSync(temp,{recursive:true,force:true});}
});
