import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import electron from 'electron';
import { createServer } from 'vite';
import { runElectronScenario } from './helpers/electron-test.mjs';

test('multi mode shares the learned single-composer resting height', {timeout:30000},async()=>{
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'deck-dock-rest-'));
  const fixture=`<div id="root"></div><script type="module">
    import React,{useState} from 'react';import{createRoot}from'react-dom/client';import{ComposerDock}from'/src/ComposerDock.tsx';import'/src/styles.css';import'/src/MultiComposer.css';
    function Fixture(){const[multi,setMulti]=useState(false),[height,setHeight]=useState(80);window.fixture={multi:setMulti,height:setHeight};return <ComposerDock target={{paneId:'a',title:'A',project:'Project'}} slotRef={()=>{}} onBorrowed={n=>window.borrowed=n}><div className={'composer'+(multi?' multi-composer':'')} data-room-ready style={{height:multi?height:160,padding:0,boxSizing:'border-box'}}/></ComposerDock>}createRoot(document.getElementById('root')).render(<Fixture/>);
  </script>`;
  const {transform}=await import('sucrase');
  const server=await createServer({cacheDir:path.join(temp,'cache'),server:{port:0},logLevel:'error',plugins:[{name:'dock-rest',configureServer(vite){vite.middlewares.use('/__dock_rest',async(_req,res)=>{res.setHeader('Content-Type','text/html');const script=fixture.match(/<script type="module">([\s\S]*?)<\/script>/)[1];res.end(await vite.transformIndexHtml('/__dock_rest',fixture.replace(script,transform(script,{transforms:['jsx']}).code)));});}}]});
  try {
    await server.listen();const main=path.join(temp,'main.cjs');
    fs.writeFileSync(main,`
      const{app,BrowserWindow}=require('electron'),assert=require('node:assert/strict');
      app.whenReady().then(async()=>{
        const win=new BrowserWindow({show:false,width:1100,height:650,useContentSize:true,enableLargerThanScreen:true,webPreferences:{backgroundThrottling:false}});
        win.setContentSize(1100,650);
        const run=s=>win.webContents.executeJavaScript(s),sleep=n=>new Promise(r=>setTimeout(r,n));
        const until=async(code,what)=>{for(let i=0;i<100;i++){if(await run(code))return;await sleep(20);}assert.fail('timed out: '+what);};
        const state=()=>run('({height:document.querySelector(".composer-dock").getBoundingClientRect().height,borrowed:window.borrowed})');
        try{
          await win.loadURL(${JSON.stringify('http://localhost:'+server.httpServer.address().port+'/__dock_rest')});
          assert.deepEqual(win.getContentSize(),[1100,650]);
          assert.deepEqual(await run('[innerWidth,innerHeight]'),[1100,650]);
          await until('!!window.fixture&&window.borrowed!==undefined','the initial dock measurement');
          const before=await state();assert.equal(before.borrowed,0);
          await run('fixture.multi(true)');
          await until('!!document.querySelector(".multi-composer")&&document.querySelector(".composer-dock").getBoundingClientRect().height==='+before.height,'the short multi composer');
          assert.deepEqual(await state(),before,'short multi mode cannot lower canonical resting height');
          await run('fixture.height(320)');
          await until('window.borrowed>100','the multi draft growth measurement');
          assert.ok((await state()).borrowed>100,'multi draft growth borrows space');
          await run('fixture.multi(false)');
          // ResizeObserver reports after React has restored the single height.
          // Await its callback too; the DOM alone can still have the old report.
          await until('!document.querySelector(".multi-composer")&&window.borrowed===0','the single composer resting measurement');
          assert.deepEqual(await state(),before,'returning to single does not carry a new resting height');
          win.destroy();app.exit(0);
        }catch(e){console.error(e.stack);win.destroy();app.exit(1);}
      });
    `);
    const result=await runElectronScenario(electron,main,temp,{timeoutMs:20000,attempts:1});assert.equal(result.code,0,result.output);
  } finally {await server.close();fs.rmSync(temp,{recursive:true,force:true});}
});
