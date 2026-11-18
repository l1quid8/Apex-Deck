import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import electron from 'electron';
import { createServer } from 'vite';
import { runElectronScenario } from './helpers/electron-test.mjs';

test('assistant actions fit a narrow context row above the scrolling transcript', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'assistant-header-'));
  const html = `<div id="root"></div><script type="module">
    import React from 'react';
    import {createRoot} from 'react-dom/client';
    import '/src/styles.css';
    import '/src/apex-agent-panel.css';
    import '/src/assistant-tasks.css';
    import {AssistantWorkspace} from '/src/AssistantWorkspace.tsx';
    const h = React.createElement;
    const lane = {name:'Alfred', hostName:'local', problem:'Workspace alert',
      currentThread:{title:'A long context title '.repeat(30)}};
    const chat = h('section', {className:'apex-agent assistant-conversation apex-agent-all'},
      h('div',{className:'apex-agent-error'},'Chat alert'),
      h('div',{className:'apex-agent-tabpanel'},
        h('div',{className:'assistant-chat-transcript',style:{height:2000}},'First message')));
    createRoot(document.querySelector('#root')).render(h(AssistantWorkspace,
      {lane,section:'chat',onNavigate(){},chat}));
    window.measure = width => {
      const ws = document.querySelector('.assistant-workspace');
      Object.assign(ws.style,{width:width+'px',height:'480px'});
      const rect = sel => ws.querySelector(sel).getBoundingClientRect();
      const row = rect('header'), label = ws.querySelector('.assistant-context-label');
      const phone = ws.querySelector('.assistant-strip-phone')?.getBoundingClientRect();
      const menu = rect('summary'), panel = ws.querySelector('.apex-agent-tabpanel');
      ws.querySelector('details').open = true;
      const popup = rect('[role=menu]');
      panel.scrollTop = 200;
      return {width:row.width, menuWidth:menu.width, menuHeight:menu.height,
        callFits: !phone || (phone.width===28 && phone.height===28 && phone.right<=menu.left
          && label.getBoundingClientRect().right<=phone.left),
        menuFits:menu.right<=row.right && popup.right<=row.right && popup.left>=row.left,
        menuClickable:ws.querySelector('[role=menu]').contains(document.elementFromPoint(popup.left+12,popup.top+12)),
        shortened:label.scrollWidth>label.clientWidth,
        alertsFit:rect('.assistant-workspace-problem').top>=row.bottom
          && rect('.apex-agent-error').top>=rect('.assistant-workspace-problem').bottom,
        transcriptFits:panel.getBoundingClientRect().top>=rect('.apex-agent-error').bottom,
        scrolled:panel.scrollTop>0 && row.top===rect('header').top};
    };
  </script>`;
  const server = await createServer({cacheDir:path.join(temp,'vite'),server:{port:0}, logLevel:'error',
    plugins:[{name:'assistant-header',configureServer(s){
      s.middlewares.use('/__header',async(_req,res)=>{
        res.setHeader('Content-Type','text/html');
        res.end(await s.transformIndexHtml('/__header',html));
      });
    }}]});
  try {
    await server.listen();
    const main = path.join(temp,'main.cjs');
    fs.writeFileSync(main,`const {app,BrowserWindow}=require('electron');
      const assert=require('node:assert/strict');
      app.whenReady().then(async()=>{
        const win=new BrowserWindow({show:false});
        await win.loadURL('http://localhost:${server.httpServer.address().port}/__header');
        const run=code=>win.webContents.executeJavaScript(code);
        await run("new Promise(resolve=>{function check(){document.querySelector('summary')?resolve():requestAnimationFrame(check)}check()})");
        for(const width of [640,240,320]){
          const state=await run('measure('+width+')');
          assert.deepEqual(state,{width,menuWidth:28,menuHeight:28,callFits:true,menuFits:true,
            menuClickable:true,shortened:true,alertsFit:true,transcriptFits:true,scrolled:true});
        }
        app.exit(0);
      }).catch(error=>{console.error(error);app.exit(1)});`);
    const result = await runElectronScenario(electron,main,temp,{attempts:1});
    assert.equal(result.code,0,result.output);
  } finally {
    await server.close();
    fs.rmSync(temp,{recursive:true,force:true});
  }
});
