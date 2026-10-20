import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import electron from 'electron';
import { createServer } from 'vite';
import { runElectronScenario } from './helpers/electron-test.mjs';

test('tab strip stays fitted through renames and resizes; bubble, menu and name line stay inside the panel', { timeout: 200000 }, async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'right-panel-fit-'));
  const html = `<div id="root"></div><script type="module">
    import React, { useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import { RightPanel } from '/src/RightPanel.tsx';
    import { defaultPanel, openTab } from '/src/rightPanelModel.ts';
    import '/src/styles.css';
    const h = React.createElement;
    function Fixture() {
      let start = { ...defaultPanel(), open: true };
      for (const kind of ['worktrees', 'artifacts']) start = openTab(start, kind, 1);
      start = openTab(start, 'browser', 1, 'https://github.com/x');
      const [state, setState] = useState(start);
      const [width, setWidth] = useState(260);
      window.fixture = {
        setWidth,
        setUrl: (url) => setState((s) => ({ ...s, tabs: s.tabs.map((t) => t.kind === 'browser' ? { ...t, url } : t) })),
        pick: (kind) => setState((s) => ({ ...s, active: s.tabs.find((t) => t.kind === kind).id })),
      };
      return h('div', { style: { width, height: 300, marginLeft: 40 } }, h(RightPanel, { state, onChange: setState, onClose() {}, onFull() {}, bodies: {} }));
    }
    createRoot(document.getElementById('root')).render(h(Fixture));
  </script>`;
  const server = await createServer({ server: { port: 0 }, logLevel: 'error', plugins: [{ name: 'right-panel-fit', configureServer(s) { s.middlewares.use('/__right_panel_fit', async (_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(await s.transformIndexHtml('/__right_panel_fit', html)); }); } }] });
  await server.listen();
  const main = path.join(temp, 'main.cjs');
  fs.writeFileSync(main, `
    const {app,BrowserWindow}=require('electron'); const assert=require('node:assert/strict');
    app.whenReady().then(async()=>{
      const win=new BrowserWindow({show:false,width:900,height:420,webPreferences:{offscreen:true}});
      const run=code=>win.webContents.executeJavaScript(code);
      const frame=()=>run('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
      const strip=()=>run("(()=>{const p=document.querySelector('.right-panel'),s=p.querySelector('.right-panel-tabs'),c=p.querySelector('.right-panel-ctl').getBoundingClientRect(),r=s.getBoundingClientRect();return {width:p.clientWidth,fit:p.dataset.fit,spill:s.scrollWidth>s.clientWidth,controls:c.width>0&&c.right<=r.right+0.5,clipped:[...p.querySelectorAll('.right-panel-tab:not([hidden]) button')].filter(b=>b.scrollWidth>b.clientWidth+1).length}})()");
      const fitted=async(note)=>{const s=await strip();assert.ok(!s.spill&&s.controls&&s.clipped===0,note+' '+JSON.stringify(s));return s;};
      try {
        await win.loadURL('http://localhost:${server.httpServer.address().port}/__right_panel_fit');
        for(let i=0;i<300;i++){if(await run('!!window.fixture'))break;await new Promise(r=>setTimeout(r,20));}
        assert.equal(await run('!!window.fixture'),true,'React fixture mounted');
        await frame();
        // A name that changes while every tab is an icon must still be measured at its real width.
        assert.equal((await fitted('narrow')).fit,'icons');
        await run("fixture.setUrl('https://news.ycombinator.com/item')"); await frame();
        await fitted('renamed while narrow');
        for(const w of [400,540,640,760]){ await run('fixture.setWidth('+w+')'); await frame(); await frame(); await fitted('widened to '+w); }
        // The icon name bubble stays inside the panel, even for the first tab at the narrowest width.
        await run('fixture.setWidth(260)'); await frame(); await frame();
        await run("document.querySelector('.right-panel-tab button').dispatchEvent(new PointerEvent('pointerover',{bubbles:true}))"); await frame();
        const tip=await run("(()=>{const p=document.querySelector('.right-panel').getBoundingClientRect(),t=document.querySelector('.right-panel-tip').getBoundingClientRect();return {p:[p.left,p.right],t:[t.left,t.right]}})()");
        assert.ok(tip.t[0]>=tip.p[0]&&tip.t[1]<=tip.p[1],'bubble inside panel '+JSON.stringify(tip));
        await run("document.querySelector('.right-panel-tab button').dispatchEvent(new PointerEvent('pointerout',{bubbles:true}))");
        // A long unbroken host name wraps in the menu and name line instead of widening them.
        await run("fixture.setUrl('https://"+'a'.repeat(63)+'.'+'b'.repeat(40)+".example.com/');fixture.pick('browser')"); await frame();
        await fitted('long host');
        await run("document.querySelector('[aria-label=\\"Sidebar options\\"]').click()"); await frame();
        const menu=await run("(()=>{const p=document.querySelector('.right-panel'),m=document.querySelector('.right-panel-menu'),n=p.querySelector('.right-panel-name'),a=p.getBoundingClientRect(),b=m.getBoundingClientRect();return {inside:b.left>=a.left&&b.right<=a.right,menuScroll:m.scrollWidth>m.clientWidth,nameScroll:n.scrollWidth>n.clientWidth,pageScroll:document.documentElement.scrollWidth>document.documentElement.clientWidth}})()");
        assert.deepEqual(menu,{inside:true,menuScroll:false,nameScroll:false,pageScroll:false});
        console.log('Fit through rename + resize, bubble clamp and long-name wrap passed'); app.exit(0);
      }catch(e){console.error(e.stack);app.exit(1);}
    });
  `);
  try { const result = await runElectronScenario(electron, main, temp); assert.equal(result.code, 0, result.output); }
  finally { await server.close(); fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});
