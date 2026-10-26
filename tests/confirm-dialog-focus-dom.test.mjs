import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import electron from 'electron';
import { createServer } from 'vite';
import { runElectronScenario } from './helpers/electron-test.mjs';

// Quit asks about unsaved edits, then about running agents, in one dialog: confirming
// the first swaps in the second without closing it. The second must start on Cancel,
// or a second Enter lands on "Quit and end them".
test('each question asked in turn starts with Cancel focused', {timeout:120000}, async () => {
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'apex-confirm-focus-dom-'));
  const html=`<html><body><button id="opener">Quit</button><div id="root"></div><script type="module">
    import React from'react';import{createRoot}from'react-dom/client';import{ConfirmDialog}from'/src/ConfirmDialog.tsx';
    window.quit=false;
    function Harness(){
      const[question,setQuestion]=React.useState(null);
      // The same chain App's askInTurn builds for Quit and Restart to update.
      const askInTurn=([next,...later],go)=>{if(next)setQuestion({...next,onConfirm:()=>askInTurn(later,go)});else go();};
      window.ask=()=>askInTurn([
        {title:'Discard unsaved changes to notes.md?',body:'Your edits are lost.',action:'Discard'},
        {title:'Quit and end running agents?',body:'Forge is still working.',action:'Quit and end them'},
      ],()=>{window.quit=true;});
      return question?React.createElement(ConfirmDialog,{question,onCancel:()=>setQuestion(null)}):null;
    }
    createRoot(document.getElementById('root')).render(React.createElement(Harness));
  </script></body></html>`;
  const server=await createServer({cacheDir:path.join(temp,'cache'),server:{port:0},logLevel:'error',plugins:[{name:'confirm-focus-fixture',configureServer(s){s.middlewares.use('/__confirm_focus',async(_req,res)=>{res.setHeader('Content-Type','text/html');res.end(await s.transformIndexHtml('/__confirm_focus',html));});}}]});
  try {
    await server.listen();
    const url=`http://localhost:${server.httpServer.address().port}/__confirm_focus`;
    const main=path.join(temp,'main.cjs');
    fs.writeFileSync(main,`
      const{app,BrowserWindow}=require('electron');const assert=require('node:assert/strict');
      app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,width:480,height:400,webPreferences:{contextIsolation:true,backgroundThrottling:false}});const run=fn=>win.webContents.executeJavaScript('('+fn.toString()+')()');const wait=async fn=>{for(let i=0;i<240;i++){if(await run(fn))return;await new Promise(r=>setTimeout(r,25));}throw Error('Timed out '+fn);};try{
        await win.loadURL(${JSON.stringify(url)});await wait(()=>typeof window.ask==='function');
        await run(()=>{document.getElementById('opener').focus();window.ask();});
        await wait(()=>document.body.innerText.includes('Discard unsaved changes to notes.md?'));
        assert.equal(await run(()=>document.activeElement.textContent),'Cancel');
        // A mouse click on Discard: the button takes focus, then confirms.
        await run(()=>{const discard=Array.from(document.querySelectorAll('.confirm button')).find(b=>b.textContent==='Discard');discard.focus();discard.click();});
        await wait(()=>document.body.innerText.includes('Quit and end running agents?'));
        assert.equal(await run(()=>document.activeElement.textContent),'Cancel','the second question starts on Cancel');
        // Enter presses whichever button has focus.
        await run(()=>document.activeElement.click());
        await wait(()=>!document.querySelector('.confirm'));
        assert.equal(await run(()=>window.quit),false,'a second Enter cancels instead of quitting');
        assert.equal(await run(()=>document.activeElement.id),'opener','focus goes back to what opened the questions');
        app.exit(0);
      }catch(e){console.error(e);app.exit(1);}});`);
    const result=await runElectronScenario(electron,main,temp);
    assert.equal(result.code,0,result.output);
  } finally { await server.close();fs.rmSync(temp,{recursive:true,force:true}); }
});
