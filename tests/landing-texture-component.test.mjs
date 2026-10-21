import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import electron from 'electron';
import { createServer } from 'vite';
import { runElectronScenario } from './helpers/electron-test.mjs';

test('rain receives surface clicks after mounting in a hidden thread', { timeout: 90000 }, async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'landing-click-host-'));
  const html = `<div id="root" style="display:none"></div><script type="module">
    import React from 'react'; import {createRoot} from 'react-dom/client';
    import {LandingTexture} from '/src/landing/LandingTexture.tsx';
    import {DEFAULT_LANDING_TEXTURE} from '/src/settings.ts';
    const h=React.createElement, root=createRoot(document.getElementById('root'));
    window.renderers=[]; window.unmount=()=>root.unmount();
    root.render(h('div',null,
      h('div',{className:'chat-body',style:{position:'relative',width:400,height:400}},
        h('div',{className:'empty',style:{marginLeft:100,paddingTop:100,width:100,height:100}},
          h(LandingTexture,{settings:DEFAULT_LANDING_TEXTURE}),
          h('button',{id:'hero',onPointerDown:e=>e.stopPropagation()},'Add bots'))),
      h('div',{className:'agents-empty',style:{width:400,height:100}},h(LandingTexture,{settings:DEFAULT_LANDING_TEXTURE}))));
  </script>`;
  const server = await createServer({ logLevel:'error', server:{port:0}, plugins:[{
    name:'landing-pointer-fixture', enforce:'pre',
    load(id) {
      if (id.endsWith('/src/landing/renderer.ts')) return `
        export function createLandingRenderer(canvas) {
          const r={canvas,taps:[],destroyed:false,resize(){},setSettings(){},pointerMove(){},
            pointerDown(x,y){this.taps.push({x,y})},pointerLeave(){},drawStatic(){},start(){},destroy(){this.destroyed=true}};
          window.renderers.push(r); return r;
        }`;
    },
    configureServer(s) { s.middlewares.use('/__landing_click',async(_req,res)=>{
      res.setHeader('Content-Type','text/html'); res.end(await s.transformIndexHtml('/__landing_click',html));
    }); },
  }] });
  await server.listen();
  const main = path.join(temp,'main.cjs');
  fs.writeFileSync(main, `
    const {app,BrowserWindow}=require('electron'), assert=require('node:assert/strict');
    app.whenReady().then(async()=>{
      const win=new BrowserWindow({show:false,width:800,height:700,webPreferences:{offscreen:true}});
      const run=code=>win.webContents.executeJavaScript(code);
      try {
        await win.loadURL('http://localhost:${server.httpServer.address().port}/__landing_click');
        for(let i=0;i<200;i++){if(await run('window.renderers?.length===2'))break;await new Promise(r=>setTimeout(r,20));}
        assert.equal(await run('window.renderers.length'),2,'both hidden textures mounted');
        assert.equal(await run("document.querySelector('.landing-texture-wrap').offsetParent"),null,'fixture starts hidden');
        await run("document.getElementById('root').style.display='block'");
        await run('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
        await run("var body=document.querySelector('.chat-body');var rect=body.getBoundingClientRect();document.elementFromPoint(rect.left+20,rect.top+20).dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0,clientX:rect.left+20,clientY:rect.top+20}));");
        assert.deepEqual(await run('renderers[0].taps'),[{x:20,y:20}],'blank rain area must pulse after reveal');
        await run("document.getElementById('hero').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0,clientX:rect.left+110,clientY:rect.top+110}))");
        assert.equal(await run('renderers[0].taps.length'),2,'capture survives stopped bubbling');
        await run("body.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:2}))");
        assert.equal(await run('renderers[0].taps.length'),2,'right click does not pulse');
        await run("document.querySelector('.agents-empty').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0}))");
        assert.equal(await run('renderers[1].taps.length'),1,'agents surface still responds');
        assert.equal(await run('renderers[0].taps.length'),2,'agents click stays out of thread');
        await run("unmount();body.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0}))");
        assert.equal(await run('renderers[0].taps.length'),2,'unmount removes listeners');
        assert.equal(await run('renderers.every(r=>r.destroyed)'),true);
        console.log('Hidden mount, reveal, capture, right click, agents isolation and cleanup passed'); app.exit(0);
      } catch(e) { console.error(e.stack); app.exit(1); }
    });
  `);
  try {
    const result = await runElectronScenario(electron,main,temp,{attempts:1});
    assert.equal(result.code,0,result.output);
  } finally {
    await server.close(); fs.rmSync(temp,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  }
});
