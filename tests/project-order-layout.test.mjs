import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import electron from 'electron';
import { createServer } from 'vite';
import { runElectronScenario } from './helpers/electron-test.mjs';

test('projects group by host; drag and keyboard order survives reload and rejects cross-host drops', { timeout: 200000 }, async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'project-order-'));
  const html = `<div id="root"></div><script type="module">
    import React,{useState,useEffect} from 'react';import {createRoot} from 'react-dom/client';
    import {ProjectSidebar} from '/src/Sidebar.tsx';
    import {reorderProject} from '/src/sidebarModel.ts';import {normalizeWorkspaces} from '/src/hostSession.ts';
    import '/src/styles.css';import '/src/clay-theme.css';
    document.documentElement.dataset.deckTheme='clay';
    const initial=[{id:'a',name:'Remote A',path:'/a',hostId:'at',collapsed:true},{id:'l',name:'Local',path:'/l',collapsed:true},{id:'b',name:'Remote B',path:'/b',hostId:'at',collapsed:true},{id:'m',name:'Local two',path:'/m',collapsed:true},{id:'gone',name:'Disconnected project',path:'/gone',hostId:'missing',collapsed:true}];
    const noop=()=>{};
    window.drag=(from,to,after)=>{const s=document.querySelector('[data-workspace="'+from+'"]'),t=document.querySelector('[data-workspace="'+to+'"]').closest('.ws-row'),r=t.getBoundingClientRect(),dt=new DataTransfer();s.dispatchEvent(new DragEvent('dragstart',{bubbles:true,cancelable:true,dataTransfer:dt}));t.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:dt,clientY:r.top+r.height*(after?0.8:0.2)}));t.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:dt}));s.dispatchEvent(new DragEvent('dragend',{bubbles:true,dataTransfer:dt}));};
    function Fixture(){
      const [workspaces,setWorkspaces]=useState(()=>normalizeWorkspaces(JSON.parse(localStorage.getItem('order-test')||JSON.stringify(initial))));
      useEffect(()=>{localStorage.setItem('order-test',JSON.stringify(workspaces));},[workspaces]);
      window.fixture={workspaces,setWorkspaces};
      return React.createElement(ProjectSidebar,{backend:{},section:'threads',panes:[],workspaces,deleting:new Set(),activeWorkspace:'l',focusedPane:null,hosts:[{id:'local',name:'This Mac',remote:false},{id:'at',name:'Apex-Terminal with a long host name',remote:true}],attention:{},threadStatus:{},statusOf:()=> 'idle',programOf:()=>'',paneRename:{},workspaceRename:{},paneMenu:()=>[],projectMenu:()=>[],onOpenPane:noop,onTogglePin:noop,onRenamePane:noop,onRenameWorkspace:noop,onProjectClick:noop,onProjectPin:noop,onNewIn:noop,onAddWorkspace:async()=>{},onManageHosts:noop,appearanceOpen:false,settingsOpen:false,onOpenAppearance:noop,onOpenSettings:noop,onRestore:noop,onReorderProject:(source,target,after)=>setWorkspaces(w=>reorderProject(w,source,target,after)),style:{width:260,height:'100vh'}});
    }createRoot(document.getElementById('root')).render(React.createElement(Fixture));
  </script>`;
  const server = await createServer({ cacheDir: path.join(temp,'vite-cache'), server:{port:0},logLevel:'error', plugins:[{name:'project-order',configureServer(s){s.middlewares.use('/__project_order',async(_req,res)=>{res.setHeader('Content-Type','text/html');res.end(await s.transformIndexHtml('/__project_order',html));});}}] });
  await server.listen();
  const main = path.join(temp,'main.cjs');
  fs.writeFileSync(main, `
    const {app,BrowserWindow}=require('electron');const assert=require('node:assert/strict');
    app.whenReady().then(async()=>{
      const win=new BrowserWindow({show:false,width:800,height:800,webPreferences:{offscreen:true}});
      const run=c=>win.webContents.executeJavaScript(c);
      const frame=()=>run('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
      const ready=async()=>{for(let i=0;i<300;i++){if(await run('!!window.fixture&&!!document.querySelector(".ws-name")'))return;await new Promise(r=>setTimeout(r,20));}throw Error('Fixture did not mount');};
      const groups=()=>run('[...document.querySelectorAll("[data-project-host]")].map(g=>[g.dataset.projectHost,[...g.querySelectorAll("[data-workspace]")].map(r=>r.dataset.workspace)])');
      const drag=async(from,to,after=false)=>{await run('drag('+[from,to,after].map(v=>JSON.stringify(v)).join(',')+')');await frame();};
      try{
        await win.loadURL('http://localhost:${server.httpServer.address().port}/__project_order');await ready();await frame();
        assert.deepEqual(await groups(),[['local',['l','m']],['at',['a','b']],['missing',['gone']]]);
        await run("document.querySelector('[data-project-host=at] button.project-host-toggle').click()");await frame();
        assert.deepEqual((await groups())[1],['at',[]]);
        await run("document.querySelector('[data-project-host=at] button.project-host-toggle').click()");await frame();
        await drag('b','a');assert.deepEqual((await groups())[1],['at',['b','a']]);
        await drag('b','l');assert.deepEqual(await groups(),[['local',['l','m']],['at',['b','a']],['missing',['gone']]]);
        await drag('b','a',true);assert.deepEqual((await groups())[1],['at',['a','b']]);
        await run("document.querySelector('[data-workspace=b]').focus();document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowUp',altKey:true,bubbles:true,cancelable:true}))");await frame();
        assert.deepEqual((await groups())[1],['at',['b','a']]);
        assert.equal(await run('document.activeElement.dataset.workspace'),'b','keyboard focus stays with moved project');
        await run("document.querySelector('[aria-label=\\"More for Remote B\\"]').click()");await frame();
        await run("[...document.querySelectorAll('[role=menuitem]')].find(b=>b.textContent.includes('Move down')).click()");await frame();
        assert.deepEqual((await groups())[1],['at',['a','b']]);
        await drag('b','a');
        await win.webContents.reload();await ready();await frame();
        assert.deepEqual((await groups())[1],['at',['b','a']],'saved order reloads');
        for(const width of [180,220,300]){
          await run('document.querySelector(".rail").style.width="'+width+'px"');await frame();
          assert.equal(await run('document.querySelector(".rail").scrollWidth>document.querySelector(".rail").clientWidth'),false,'no rail overflow at '+width);
        }
        const image=await win.webContents.capturePage();require('node:fs').writeFileSync('${temp}/sidebar.png',image.toPNG());
        console.log('Host grouping, collapse, before/after drag, cross-host rejection, keyboard/menu movement and reload passed');app.exit(0);
      }catch(e){console.error(e.stack);app.exit(1);}
    });
  `);
  try {
    const result=await runElectronScenario(electron,main,temp);assert.equal(result.code,0,result.output);
    if (process.env.APEX_PROJECT_ORDER_SCREENSHOT) fs.copyFileSync(path.join(temp,'sidebar.png'),process.env.APEX_PROJECT_ORDER_SCREENSHOT);
  }
  finally { await server.close();fs.rmSync(temp,{recursive:true,force:true,maxRetries:5,retryDelay:100}); }
});
