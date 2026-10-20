import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import electron from 'electron';
import { createServer } from 'vite';
import { runElectronScenario } from './helpers/electron-test.mjs';

test('add-project menu escapes sidebar clipping and worktree actions copy the full pathname', { timeout: 200000 }, async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'sidebar-menus-'));
  const html = `<div id="root"></div><script type="module">
    import React from 'react'; import {createRoot} from 'react-dom/client';
    import {WorkspaceHostMenu} from '/src/WorkspaceHostMenu.tsx';
    import {RightWorktreesTab} from '/src/RightWorktrees.tsx';
    import '/src/styles.css'; import '/src/right-panel.css'; import '/src/glass-theme.css'; import '/src/clay-theme.css';
    const h=React.createElement;
    window.fixture={chosen:[],managed:0,copied:[],rejectCopy:false,globalEscapes:0};
    window.addEventListener('keydown',e=>{if(e.key==='Escape')fixture.globalEscapes++;});
    Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{if(fixture.rejectCopy)throw Error('denied');fixture.copied.push(text);}}});
    const items=[
      {path:'/Users/example/Projects/A folder with spaces/日本語/main-repository',branch:'main',main:true},
      {path:'/Users/example/Projects/worktrees/a-very-long-feature-branch-name',branch:'feature/long-name'},
      {path:'/srv/worktrees/missing-task',branch:'task/missing',task:true,prunable:true}
    ].map(w=>({head:'12345678',main:false,locked:false,prunable:false,changes:0,task:false,...w}));
    const backend={hosts:{list:async()=>[{id:'local',name:'This Mac',remote:false},{id:'remote',name:'Apex-Terminal with a very long machine name',remote:true}]},worktreeList:async()=>({root:items[0].path,items})};
    createRoot(document.getElementById('root')).render(h('div',{style:{display:'flex',height:'100%',gap:20}},
      h('aside',{className:'rail',style:{width:180,height:400}},h('div',{className:'rail-sec'},'Projects',h(WorkspaceHostMenu,{backend,choose:async id=>{fixture.chosen.push(id);},manage:()=>{fixture.managed++;}})),h('div',{style:{height:800}},'Project list')),
      h('div',{style:{width:340,height:500}},h(RightWorktreesTab,{root:items[0].path,backend,visible:true,onOpen(){}}))));
  </script>`;
  const server = await createServer({ cacheDir: path.join(temp, 'vite-cache'), server: { port: 0 }, logLevel: 'error', plugins: [{ name: 'sidebar-menus', configureServer(s) { s.middlewares.use('/__sidebar_menus', async (_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(await s.transformIndexHtml('/__sidebar_menus', html)); }); } }] });
  await server.listen();
  const main = path.join(temp, 'main.cjs');
  fs.writeFileSync(main, `
    const {app,BrowserWindow}=require('electron');const assert=require('node:assert/strict');const fs=require('node:fs');
    app.whenReady().then(async()=>{
      const win=new BrowserWindow({show:false,width:900,height:650,webPreferences:{offscreen:true}});
      const run=c=>win.webContents.executeJavaScript(c);
      const frame=()=>run('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
      const open=async()=>{await run('document.querySelector("[data-add-workspace]").click()');await frame();};
      const inside=async note=>{
        const box=await run('(()=>{const m=document.querySelector("[data-machine-menu]"),r=m.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:innerWidth,height:innerHeight,hit:m.contains(document.elementFromPoint(r.left+12,r.top+12)),scroll:m.scrollWidth>m.clientWidth}})()');
        assert.ok(box.left>=8&&box.right<=box.width-8&&box.top>=8&&box.bottom<=box.height-8&&box.hit&&!box.scroll,note+" "+JSON.stringify(box));
      };
      const shot=async name=>{const img=await win.webContents.capturePage();fs.writeFileSync(${JSON.stringify(temp)}+'/'+name+'.png',img.toPNG());};
      try{
        await win.loadURL('http://localhost:${server.httpServer.address().port}/__sidebar_menus');
        for(let i=0;i<300;i++){if(await run('document.querySelectorAll(".right-worktrees-row").length===3'))break;await new Promise(r=>setTimeout(r,20));}
        assert.equal(await run('document.querySelectorAll(".right-worktrees-row").length'),3,'fixture mounted');
        for(const theme of ['flat','glass','clay']){
          await run('document.documentElement.dataset.deckTheme='+JSON.stringify(theme));
          for(const width of [128,180,240,360]){
            await run('document.querySelector(".rail").style.width="'+width+'px"');await open();await inside(theme+' sidebar '+width);
            await run('document.querySelector("[data-host-id=remote]").click()');await frame();
            assert.equal(await run('!!document.querySelector("[data-machine-menu]")'),false,'host selection closes menu');
          }
        }
        assert.equal(await run('fixture.chosen.length'),12,'portalled host buttons stay actionable');
        await run('document.querySelector("[data-add-workspace]").focus()');await open();
        const focusEntered=await run('document.activeElement.dataset.hostId==="local"');
        await run('document.activeElement.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true}))');await frame();
        assert.deepEqual({focusEntered,globalEscapes:await run('fixture.globalEscapes')},{focusEntered:true,globalEscapes:0},'keyboard enters popup and Escape cannot dismiss underlying app panels');
        await run('document.querySelector(".rail").style.width="360px"');await open();
        await run('document.querySelector(".rail").style.width="180px"');await frame();await inside('sidebar resized while open');await shot('project-menu');
        // Moving the scroll container and resizing must keep the popup attached and visible.
        await run('document.querySelector(".rail").scrollTop=10');await frame();await inside('scrolled');
        await run('document.activeElement.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true}))');await frame();
        assert.equal(await run('!!document.querySelector("[data-machine-menu]")'),false,'Escape closes menu');
        assert.equal(await run('document.activeElement.hasAttribute("data-add-workspace")'),true,'Escape restores focus');
        await run('document.querySelector(".rail").scrollTop=0');await open();
        win.setContentSize(300,300);await frame();await inside('small viewport');
        win.setContentSize(900,650);await frame();await inside('resized viewport');
        await run('document.querySelector("[data-machine-menu] p").dispatchEvent(new MouseEvent("mousedown",{bubbles:true}))');await frame();
        assert.equal(await run('!!document.querySelector("[data-machine-menu]")'),true,'click inside portal keeps menu open');
        await run('[...document.querySelectorAll("[data-machine-menu] button")].find(b=>b.textContent.includes("manage servers")).click()');await frame();
        assert.equal(await run('fixture.managed'),1);
        await open();await run('document.body.dispatchEvent(new MouseEvent("mousedown",{bubbles:true}))');await frame();
        assert.equal(await run('!!document.querySelector("[data-machine-menu]")'),false,'outside click closes menu');
        // Main, linked and missing task rows all copy the exact full path, never the shortened label.
        for(let i=0;i<3;i++){
          await run('document.querySelectorAll(".right-worktrees-menu summary")['+i+'].click()');await frame();
          const copied=await run('(()=>{const row=document.querySelectorAll(".right-worktrees-row")['+i+'];const b=[...row.querySelectorAll("button")].find(b=>b.textContent==="Copy pathname");if(!b)return false;b.click();return true;})()');
          assert.equal(copied,true,'Copy pathname is available for row '+i);await frame();
          assert.equal(await run('document.querySelectorAll(".right-worktrees-menu")['+i+'].open'),false,'copy closes menu');
        }
        assert.deepEqual(await run('fixture.copied'),[
          '/Users/example/Projects/A folder with spaces/日本語/main-repository',
          '/Users/example/Projects/worktrees/a-very-long-feature-branch-name',
          '/srv/worktrees/missing-task'
        ]);
        assert.equal(await run('document.querySelector(".right-worktrees [role=status]").textContent'),'Pathname copied');
        await run('fixture.rejectCopy=true;document.querySelector(".right-worktrees-menu summary").click()');await frame();
        await run('[...document.querySelector(".right-worktrees-row").querySelectorAll("button")].find(b=>b.textContent==="Copy pathname").click()');await frame();
        assert.equal(await run('fixture.copied.length'),3,'failed write does not report a copy');
        assert.equal(await run('document.querySelector(".right-worktrees [role=status]").textContent'),'Clipboard unavailable');
        await run('document.querySelectorAll(".right-worktrees-menu summary")[1].click()');await frame();await shot('worktree-copy');
        console.log('Project popup visible and actionable across themes, sizes and scrolling; worktree full-path copy and failure feedback passed');app.exit(0);
      }catch(e){console.error(e.stack);app.exit(1);}
    });
  `);
  try {
    const result = await runElectronScenario(electron, main, temp, { attempts: 1 });
    assert.equal(result.code, 0, result.output);
    if (process.env.APEX_SIDEBAR_MENUS_SCREENSHOTS) {
      fs.mkdirSync(process.env.APEX_SIDEBAR_MENUS_SCREENSHOTS, { recursive: true });
      for (const name of ['project-menu', 'worktree-copy']) fs.copyFileSync(path.join(temp, name+'.png'), path.join(process.env.APEX_SIDEBAR_MENUS_SCREENSHOTS, name+'.png'));
    }
  } finally { await server.close(); fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});
