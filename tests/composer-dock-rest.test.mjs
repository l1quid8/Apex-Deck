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
    fs.writeFileSync(main,`const{app,BrowserWindow}=require('electron'),assert=require('node:assert/strict');app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,width:1100,height:650,enableLargerThanScreen:true,webPreferences:{backgroundThrottling:false}});const run=s=>win.webContents.executeJavaScript(s),sleep=n=>new Promise(r=>setTimeout(r,n));try{await win.loadURL(${JSON.stringify('http://localhost:'+server.httpServer.address().port+'/__dock_rest')});for(let i=0;i<100&&await run('!window.fixture||window.borrowed===undefined');i++)await sleep(20);const state=()=>run('({height:document.querySelector(".composer-dock").getBoundingClientRect().height,borrowed:window.borrowed})');const before=await state();assert.equal(before.borrowed,0);await run('fixture.multi(true)');await sleep(150);assert.deepEqual(await state(),before,'short multi mode cannot lower canonical resting height');await run('fixture.height(320)');await sleep(150);assert.ok((await state()).borrowed>100,'multi draft growth borrows space');await run('fixture.multi(false)');await sleep(150);assert.deepEqual(await state(),before,'returning to single does not carry a new resting height');win.destroy();app.exit(0);}catch(e){console.error(e.stack);win.destroy();app.exit(1);}});`);
    const result=await runElectronScenario(electron,main,temp,{timeoutMs:20000,attempts:1});assert.equal(result.code,0,result.output);
  } finally {await server.close();fs.rmSync(temp,{recursive:true,force:true});}
});
