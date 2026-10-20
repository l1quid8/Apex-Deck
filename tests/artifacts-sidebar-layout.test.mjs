import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import electron from 'electron';
import { createServer } from 'vite';
import { runElectronScenario } from './helpers/electron-test.mjs';

test('docked Artifacts fills the sidebar and popout across Clay and Glass sizes', { timeout: 200000 }, async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'artifacts-sidebar-'));
  const shots = '/tmp/apex-artifacts-review';
  fs.mkdirSync(shots, { recursive: true });
  const html = `<div id="root"></div><script type="module">
    import React, { useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import { ArtifactsPanel, DEFAULT_VIEW } from '/src/ArtifactsPanel.tsx';
    import { RightPanel } from '/src/RightPanel.tsx';
    import { defaultPanel, openTab } from '/src/rightPanelModel.ts';
    import '/src/styles.css'; import '/src/glass-theme.css'; import '/src/clay-theme.css'; import '/src/popout.css';
    const h = React.createElement;
    const file = {version:1,artifacts:[{id:'a',kind:'html',title:'Layout fixture',versions:[1,2].map(n=>({n,source:'<h1>Version '+n+'</h1>',by:null,seq:null,at:0}))}]};
    function Fixture() {
      const [view,setView] = useState(DEFAULT_VIEW);
      const [state,setState] = useState(openTab(defaultPanel(),'artifacts',1));
      const [pop,setPop] = useState(false);
      window.fixture = { setPop, setState, state };
      const artifact = h(ArtifactsPanel,{file,view:{...view,full:state.full},onView:next=>{setState(s=>({...s,full:next.full}));setView(next)},onClose:()=>setState(s=>({...s,active:'details'})),overlay:false,docked:true,nameOf:()=>'',colorOf:()=>'',onOpenLink:()=>{},backend:{},problem:''});
      const main = h('div',{className:'popout-chat-main'},h('div',{className:'chat-body'},'Transcript'),h('div',{className:'composer'},'Composer'));
      return pop ? h('div',{className:'popout',style:{height:'100vh'}},h('header',{className:'popout-bar'},'Popout fixture'),h('div',{className:'popout-body'},h('div',{className:'popout-chat-row'},main,h('div',{className:'right-artifacts-slot popout-artifacts docked'},artifact))))
      : h('div',{style:{display:'flex',height:'100vh'}},main,h('aside',{style:{width:440,flex:'none',minHeight:0}},h(RightPanel,{state,onChange:setState,onClose:()=>{},onFull:full=>setState(s=>({...s,full})),bodies:{artifacts:()=>h('div',{className:'right-artifacts-slot'},artifact),details:()=>h('div',null,'Details')}})));
    }
    createRoot(document.getElementById('root')).render(h(Fixture));
  </script>`;
  const server = await createServer({ server:{port:0}, logLevel:'error', plugins:[{name:'artifacts-layout',configureServer(s){s.middlewares.use('/__artifacts_layout',async(_req,res)=>{res.setHeader('Content-Type','text/html');res.end(await s.transformIndexHtml('/__artifacts_layout',html));});}}] });
  await server.listen();
  const main = path.join(temp, 'main.cjs');
  fs.writeFileSync(main, `
    const {app,BrowserWindow}=require('electron'); const assert=require('node:assert/strict'); const fs=require('node:fs');
    app.whenReady().then(async()=>{
      const win=new BrowserWindow({show:false,webPreferences:{offscreen:true}});
      win.webContents.on("console-message",(_event,...args)=>console.log("renderer",...args));
      const run=code=>win.webContents.executeJavaScript(code);
      const frame=()=>run('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
      try {
        await win.loadURL('http://localhost:${server.httpServer.address().port}/__artifacts_layout');
        for(let i=0;i<300;i++){if(await run('!!window.fixture'))break;await new Promise(r=>setTimeout(r,20));}
        assert.equal(await run('!!window.fixture'),true,'React fixture mounted');
        for(const theme of ['clay-dark','clay-light','glass']) for(const width of [1200,1900]) {
          win.setContentSize(width,850);
          await run("document.documentElement.dataset.deckTheme="+JSON.stringify(theme.startsWith('clay')?'clay':'glass')+";document.documentElement.dataset.deckLight="+JSON.stringify(String(theme==='clay-light')));
          await frame();
          const geometry=await run("(()=>{const r=s=>document.querySelector(s).getBoundingClientRect().toJSON();return {panel:r('.artifacts-panel'),slot:r('.right-artifacts-slot'),body:r('.right-panel-body:not([hidden])'),chat:r('.popout-chat-main')}})()");
          assert.ok(Math.abs(geometry.panel.bottom-geometry.body.bottom)<2,JSON.stringify(geometry));
          assert.ok(Math.abs(geometry.panel.top-geometry.body.top)<2,JSON.stringify(geometry));
          await run("fixture.setState(s=>({...s,active:'details'}))"); await frame();
          assert.equal(await run("document.querySelector('.popout-chat-main').getBoundingClientRect().width"),geometry.chat.width);
          await run("fixture.setState(s=>({...s,active:'artifacts'}))"); await frame();
          fs.writeFileSync('${shots}/'+theme+'-'+width+'.png',(await win.webContents.capturePage()).toPNG());
        }
        for(const label of ['Source','Changes','Preview']) {
          await run("[...document.querySelectorAll('.artifacts-tabs button')].find(b=>b.textContent==="+JSON.stringify(label)+").click()");await frame();
          assert.equal(await run("document.querySelector('.artifacts-tabs [aria-selected=true]').textContent"),label);
        }
        await run("document.querySelector('[aria-label=\\"Older version\\"]').click()"); await frame();
        assert.equal(await run("document.querySelector('.artifacts-version').textContent"),'v1');
        await run("document.querySelector('[aria-label=\\"Newer version\\"]').click()"); await frame();
        assert.equal(await run("document.querySelector('.artifacts-version').textContent"),'v2');
        await run('fixture.setPop(true)'); win.setContentSize(760,560); await frame();
        const pop=await run("(()=>{const p=document.querySelector('.artifacts-panel').getBoundingClientRect();const c=document.querySelector('.composer').getBoundingClientRect();return {bottom:p.bottom,composer:c.bottom}})()");
        assert.ok(Math.abs(pop.bottom-pop.composer)<2,JSON.stringify(pop));
        await run("document.querySelector('.popout-artifacts').className='right-artifacts-slot popout-artifacts overlay'");await frame();
        assert.equal(await run("getComputedStyle(document.querySelector('.popout-artifacts')).position"),'absolute');
        fs.writeFileSync('${shots}/popout-760.png',(await win.webContents.capturePage()).toPNG());
        console.log('Six theme/size layouts, tab width, version/view controls, and full-height popout passed'); app.exit(0);
      }catch(e){console.error(e.stack);app.exit(1);}
    });
  `);
  try { const result = await runElectronScenario(electron,main,temp); assert.equal(result.code,0,result.output); }
  finally { await server.close(); fs.rmSync(temp,{recursive:true,force:true,maxRetries:5,retryDelay:100}); }
});
