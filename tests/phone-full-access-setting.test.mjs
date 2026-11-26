import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import electron from 'electron';
import { createServer } from 'vite';
import { runElectronScenario } from './helpers/electron-test.mjs';

test('phone Full is one setting, without a separate approval block or prompt', {timeout:120000}, async () => {
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'phone-full-setting-'));
  let html;
  const server=await createServer({cacheDir:path.join(temp,'cache'),logLevel:'error',server:{port:0},plugins:[{
    name:'expose-real-bot-sheet-for-test',enforce:'pre',
    configureServer(server){server.middlewares.use('/full-setting-fixture',async (_req,res)=>{res.setHeader('Content-Type','text/html');res.end(await server.transformIndexHtml('/full-setting-fixture',html));});},
    transform(code,id){if(id.endsWith('/src/phone/PhoneApp.tsx')) return code.replace('function BotSheet(props:', 'export function BotSheet(props:');}
  }]});
  html=`<html><body><div id="root"></div><script type="module">
    import React from 'react';import {createRoot} from 'react-dom/client';
    import {BotSheet} from '/src/phone/PhoneApp.tsx';import '/src/phone/phone.css';
    const root=createRoot(document.getElementById('root'));
    const f=window.fixture={saves:[],prompts:0,restarts:0};
    window.confirm=()=>{f.prompts++;throw Error('Unexpected second confirmation');};
    let config={id:'null',display_name:'Null',access:'ask',backend:{kind:'agent',tool:'codex'}};
    function render(){root.render(React.createElement(BotSheet,{
      who:{id:'null',display_name:'Null',look:{seed:'null',color:'#9955dd'}},config,reported:[],apiModels:[],
      status:'Ready',statusWarn:false,working:false,asking:false,meters:[],shared:'',tokens:'',resets:null,offline:'',
      onSave:async change=>{f.saves.push(change);config={...config,...change};render();},
      onApplyAccess:async()=>{f.restarts++;},onMention(){},onStop(){},onClose(){}
    }));}render();
  </script></body></html>`;
  try{
    await server.listen();
    const main=path.join(temp,'main.cjs');
    fs.writeFileSync(main,`
      const {app,BrowserWindow}=require('electron');const assert=require('node:assert/strict');
      app.whenReady().then(async()=>{try{
        const win=new BrowserWindow({show:false,width:393,height:852});
        win.webContents.on('console-message',(_event,_level,message)=>console.log(message));
        const run=fn=>win.webContents.executeJavaScript('('+fn.toString()+')()');
        const wait=async fn=>{for(let i=0;i<400;i++){if(await run(fn))return;await new Promise(r=>setTimeout(r,25));}throw Error('Timed out '+fn);};
        await win.loadURL('http://localhost:${server.httpServer.address().port}/full-setting-fixture');
        await wait(()=>!!document.querySelector('[aria-label="Access"]'));
        await run(()=>[...document.querySelectorAll('[aria-label="Access"] button')].find(b=>b.textContent==='Full').click());
        await wait(()=>window.fixture.saves.length===1&&document.querySelector('[aria-label="Access"] [aria-checked=true]')?.textContent==='Full');
        assert.deepEqual(await run(()=>window.fixture.saves),[{access:'full'}]);
        assert.equal(await run(()=>window.fixture.prompts),0);
        assert.equal(await run(()=>!!document.querySelector('.agent-full-access')),false);
        assert.equal(await run(()=>/Confirm Full access|Revoke Full access approval|Full access confirmed/.test(document.body.textContent)),false);
        // Existing Full remains usable without a second save, prompt, or restart.
        await run(()=>[...document.querySelectorAll('[aria-label="Access"] button')].find(b=>b.textContent==='Full').click());
        assert.equal(await run(()=>window.fixture.saves.length),1);
        assert.equal(await run(()=>window.fixture.restarts),0);
        await run(()=>[...document.querySelectorAll('[aria-label="Access"] button')].find(b=>b.textContent==='Read-only').click());
        await wait(()=>window.fixture.saves.length===2);
        assert.equal(await run(()=>window.fixture.saves[1].access),'read');
        assert.equal(await run(()=>window.fixture.prompts),0);
        win.destroy();app.exit(0);
      }catch(error){console.error(error.stack);app.exit(1);}});
    `);
    const result=await runElectronScenario(electron,main,temp,{attempts:1});
    assert.equal(result.code,0,result.output);
  }finally{await server.close();fs.rmSync(temp,{recursive:true,force:true});}
});
