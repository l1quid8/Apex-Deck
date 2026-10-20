import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import electron from 'electron';
import { createServer } from 'vite';
import { runElectronScenario } from './helpers/electron-test.mjs';

// Exercise the real ChatPane portal, rather than only a panel-shaped layout fixture.
test('Artifacts follows the selected thread, preserves each view, and stays out of the transcript', { timeout: 200000 }, async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'artifacts-portal-'));
  const html = `<div id="root"></div><script type="module">
    import React, {useState} from 'react'; import {createRoot} from 'react-dom/client';
    import {ChatPane} from '/src/ChatPane.tsx'; import {RightPanel} from '/src/RightPanel.tsx';
    import {getBackend} from '/src/backend.ts';
    import {defaultPanel,openTab,closeTab,closePanel,setFull} from '/src/rightPanelModel.ts';
    import '/src/styles.css'; import '/src/clay-theme.css';
    const h=React.createElement;
    const bot={id:'bot',display_name:'Bot',persona:'',access:'read',effort:null,backend:{kind:'scripted',lines:['[pass]']}};
    const snapshot={participants:[bot],options:{policy:'mention',max_bot_hops:3},transcript:[]};
    window.service={title:'Artifact ',saves:[],listeners:[]};
    const backend={...await getBackend(),roomCreate:async()=>snapshot,roomState:async()=>({recovery_seq:1,snapshot,active:[],approvals:[]}),roomClose:async()=>{},roomSteps:async()=>null,onRoomEvent:async fn=>{service.listeners.push(fn);return()=>{service.listeners=service.listeners.filter(f=>f!==fn);}},onPtyData:async()=>()=>{},onPtyExit:async()=>()=>{},
      artifactsLoad:async id=>({version:1,artifacts:[{id,kind:'html',title:service.title+id,versions:[1,2].map(n=>({n,source:'<h1>'+id+' version '+n+'</h1>',by:null,seq:null,at:0}))}]}),artifactsSave:async(...args)=>{service.saves.push(args);}};
    function Fixture(){
      const [follow,setFollow]=useState(false);const [target,setTarget]=useState('one');const [slot,setSlot]=useState(null);const [panel,setPanel]=useState(defaultPanel());
      const host={slot,target,open:panel.open&&panel.active==='artifacts',full:panel.full,overlay:false,free:!panel.open||panel.active==='artifacts',show:()=>setPanel(p=>openTab({...p,open:true},'artifacts',1)),close:()=>setPanel(p=>closeTab(p,'artifacts')),setFull:full=>setPanel(p=>setFull(p,full))};
      window.fixture={setTarget,setFollow,panel,reopen:()=>setPanel(p=>({...p,open:true}))};
      return h('div',{style:{display:'flex',height:'100vh'}},h('main',{style:{flex:1,minWidth:0}},['one','two'].map(id=>h('section',{key:id,className:'pane',hidden:id!==target,style:{height:'100%'}},h('header',{className:'pane-head'},h('div',{className:'pane-counts'})),h(ChatPane,{pane:{id,workspaceId:'w',kind:'chat',title:id},cwd:'/tmp/project',agents:[],backend,focused:id===target,visible:id===target,artifactsHost:host,followArtifacts:follow,onActivity(){},profiles:[],onProfilesChange(){},disabledProviders:[]})))),
        h('aside',{hidden:!panel.open,style:{width:440,minHeight:0,flex:'none'}},h(RightPanel,{state:panel,onChange:setPanel,onClose:()=>setPanel(closePanel),onFull:host.setFull,bodies:{artifacts:()=>h('div',{ref:setSlot,className:'right-artifacts-slot'})}})));
    }createRoot(document.getElementById('root')).render(h(Fixture));
  </script>`;
  const server = await createServer({cacheDir:path.join(temp,'vite-cache'),server:{port:0},logLevel:'error',plugins:[{name:'artifacts-portal-test',configureServer(server){server.middlewares.use('/__artifacts_portal',async(_req,res)=>{res.setHeader('Content-Type','text/html');res.end(await server.transformIndexHtml('/__artifacts_portal',html));});}}]});
  await server.listen();
  const main=path.join(temp,'main.cjs');
  fs.writeFileSync(main, `
    const {app,BrowserWindow}=require('electron');const assert=require('node:assert/strict');
    app.whenReady().then(async()=>{
      const win=new BrowserWindow({show:false,width:1200,height:850,webPreferences:{offscreen:true}});
      const run=code=>win.webContents.executeJavaScript(code);
      const frame=()=>run('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
      const wait=async code=>{for(let i=0;i<400;i++){if(await run(code))return;await new Promise(r=>setTimeout(r,25));}throw Error('Timed out: '+code);};
      try{
        await win.loadURL('http://localhost:${server.httpServer.address().port}/__artifacts_portal');
        await wait("document.querySelector('.pane:not([hidden]) button[title=Artifacts]')");
        await run("document.querySelector('.pane:not([hidden]) button[title=Artifacts]').click()");
        await wait("document.querySelector('.right-artifacts-slot .artifacts-title')?.textContent.includes('one')");
        assert.equal(await run("document.querySelectorAll('.chat-body .artifacts-panel').length"),0,'hosted artifacts never occupy the transcript');
        assert.equal(await run("document.querySelectorAll('.artifacts-panel').length"),1,'only the targeted thread portals');
        await run("document.querySelector('[aria-label=\\"Older version\\"]').click()");await frame();await run("[...document.querySelectorAll('.artifacts-tabs button')].find(b=>b.textContent==='Source').click()");await frame();
        await run("fixture.setTarget('two')");await wait("document.querySelector('.artifacts-title')?.textContent.includes('two')");
        assert.equal(await run("document.querySelector('.artifacts-version').textContent"),'v2');
        await run("fixture.setTarget('one')");await wait("document.querySelector('.artifacts-title')?.textContent.includes('one')");
        assert.equal(await run("document.querySelector('.artifacts-version').textContent"),'v1','each thread keeps its version');
        assert.equal(await run("document.querySelector('.artifacts-tabs [aria-selected=true]').textContent"),'Source','each thread keeps its view');
        const saved=await run('JSON.stringify(fixture.panel.tabs)');
        await run("document.querySelector('[aria-label=\\"Hide side panel\\"]').click()");await frame();
        assert.equal(await run('fixture.panel.open'),false);
        assert.equal(await run('JSON.stringify(fixture.panel.tabs)'),saved,'sidebar x preserves tabs');
        assert.equal(await run("document.querySelectorAll('.artifacts-panel').length"),0);
        await run('fixture.reopen()');await wait("document.querySelector('.artifacts-title')?.textContent.includes('one')");
        await run("document.querySelector('[aria-label=\\"Full window\\"]').click()");await frame();assert.equal(await run('fixture.panel.full'),true,'artifact maximize expands host');
        await run("document.querySelector('[aria-label=\\"Back to the thread\\"]').click()");await frame();assert.equal(await run('fixture.panel.full'),false);
        await run("document.querySelector('[aria-label=\\"Remove selected tool\\"]').click()");await frame();
        assert.equal(await run("fixture.panel.tabs.some(t=>t.kind==='artifacts')"),false,'minus removes selected artifacts tab');
        await run("document.querySelector('[aria-label=\\"Add a tab\\"]').click()");await frame();
        await run("[...document.querySelectorAll('[role=menuitem]')].find(b=>b.textContent==='Artifacts').click()");await wait("document.querySelector('.artifacts-title')?.textContent.includes('one')");
        await run("fixture.setFollow(true)");await frame();
        await run("service.title='Updated ';service.listeners.forEach(fn=>fn('one',{type:'message_added',message:{seq:7,speaker:{kind:'bot',id:'bot'},text:[String.fromCharCode(96).repeat(3)+'html','<h1>Incoming artifact</h1>',String.fromCharCode(96).repeat(3)].join(String.fromCharCode(10)),at:1},recovery_seq:2}))");
        await frame();
        assert.equal(await run('service.saves.length'),0,'standalone observer never overwrites the owner artifact file');
        await wait("document.querySelector('.artifacts-title')?.textContent.includes('Updated one')");
        console.log('Real ChatPane portal, thread switching, version/view retention, maximize, and + - x passed');app.exit(0);
      }catch(e){console.error(e.stack);app.exit(1);}
    });
  `);
  try{const result=await runElectronScenario(electron,main,temp);assert.equal(result.code,0,result.output);}
  finally{await server.close();fs.rmSync(temp,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});
