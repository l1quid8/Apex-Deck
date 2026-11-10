import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import electron from 'electron';
import { createServer } from 'vite';
import { runElectronScenario } from './helpers/electron-test.mjs';
import { transform } from 'sucrase';

const require = createRequire(import.meta.url);
const source = fs.readFileSync(new URL('../src/LayoutPicker.tsx', import.meta.url), 'utf8');
const compiled = transform(source, { transforms: ['typescript', 'jsx', 'imports'], jsxRuntime: 'automatic', production: true }).code;
const exports = {};
new Function('require', 'exports', compiled)(require, exports);
const { LayoutPicker } = exports;
const appSource = fs.readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
// Exercise App's actual selection callback, including its zoom and focus rules.
const arrange = transform(appSource.match(/  const arrange = \(mode: PaneLayoutMode\) => \{[\s\S]*?\n  \};/)[0], { transforms: ['typescript'] }).code;

test('the pane layout menu exposes all five choices with Vertical checked', () => {
  const html = renderToStaticMarkup(React.createElement(LayoutPicker, { value: 'vertical', disabled: false, onSelect() {} }));
  const choices = [...html.matchAll(/<button\b[^>]*role="menuitemradio"[^>]*>[\s\S]*?<\/button>/g)].map(match => match[0]);
  assert.equal(choices.length, 5);
  assert.deepEqual(choices.map(choice => choice.match(/<strong>(.*?)<\/strong>/)[1]), ['Horizontal', 'Vertical', 'Even grid', 'Focus left', 'Focus right']);
  assert.deepEqual(choices.map(choice => choice.match(/<small>(.*?)<\/small>/)[1]), ['Wide rows, scroll down', 'Tall columns, scroll sideways', 'Give every pane equal space', 'One tall pane on the left', 'One tall pane on the right']);
  assert.deepEqual(choices.map(choice => choice.match(/aria-checked="(.*?)"/)[1]), ['false', 'true', 'false', 'false', 'false']);
  assert.match(html, /aria-label="Pane layout: Vertical"/);
  assert.ok(choices.every(choice => !choice.includes('aria-haspopup')), 'every choice is a direct selection');
  for (const [index, count] of [[0, 3], [1, 3], [2, 4], [3, 3], [4, 3]]) {
    assert.equal([...choices[index].matchAll(/<i>/g)].length, count);
  }
});

test('the layout menu follows keyboard selection, dismissal, and focus conventions', { timeout: 100000 }, async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'layout-picker-'));
  const html = `<html><body><button id="before">Before</button><div id="root" style="position:absolute;top:20px;right:20px"></div><button id="after">After</button><script type="module">
    import React, {useState} from 'react'; import {createRoot} from 'react-dom/client';
    import {LayoutPicker} from '/src/LayoutPicker.tsx'; import '/src/styles.css';
    window.selections=[];
    function Fixture(){
      const [arrangement,setArrangement]=useState({mode:'vertical',order:['p0','p1'],zoom:1,focusShare:0.58}); const [disabled,setDisabled]=useState(false);
      const value=arrangement.mode,focusedPane='p0',setMaximized=()=>{};
      ${arrange}
      window.setDisabled=setDisabled;
      window.zoomIn=()=>setArrangement(current=>({...current,zoom:current.zoom+1}));window.arrangement=arrangement;
      return React.createElement(LayoutPicker,{value,disabled,onSelect(mode){window.selections.push(mode);arrange(mode);}});
    }
    createRoot(document.getElementById('root')).render(React.createElement(Fixture));
  </script></body></html>`;
  const server = await createServer({ cacheDir: path.join(temp, 'vite-cache'), server: { port: 0 }, logLevel: 'error', plugins: [{ name: 'layout-picker-test', configureServer(server) { server.middlewares.use('/__layout_picker_test', async (_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(await server.transformIndexHtml('/__layout_picker_test', html)); }); } }] });
  const main = path.join(temp, 'main.cjs');
  try {
    await server.listen();
    const url = `http://localhost:${server.httpServer.address().port}/__layout_picker_test`;
    fs.writeFileSync(main, `
      const {app,BrowserWindow}=require('electron'); const assert=require('node:assert/strict'); const fs=require('node:fs');
      app.whenReady().then(async()=>{
        const win=new BrowserWindow({show:false,width:600,height:600,enableLargerThanScreen:true,webPreferences:{contextIsolation:true,backgroundThrottling:false}});
        const run=code=>win.webContents.executeJavaScript(code);
        const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
        const until=async(code)=>{for(let i=0;i<300;i++){if(await run(code))return;await sleep(20);}throw Error('Timed out: '+code);};
        const key=async(keyCode,modifiers=[])=>{win.webContents.sendInputEvent({type:'keyDown',keyCode,modifiers});win.webContents.sendInputEvent({type:'keyUp',keyCode,modifiers});await sleep(30);};
        const active=()=>run("document.activeElement.querySelector('strong')?.textContent ?? document.activeElement.id ?? ''");
        const expanded=()=>run("document.querySelector('.layout-picker-trigger').getAttribute('aria-expanded')");
        const trigger=()=>run("document.querySelector('.layout-picker-trigger').focus()");
        try {
          await win.loadURL(${JSON.stringify(url)});
          await until("!!document.querySelector('.layout-picker-trigger')");
          assert.equal(await expanded(),'false');
          assert.equal(await run("document.querySelector('[role=menu]')?.getBoundingClientRect().height ?? 0"),0,'closed menu occupies no space');
          await trigger(); await key('Down');
          assert.equal(await expanded(),'true'); assert.equal(await active(),'Horizontal');
          if(${JSON.stringify(process.env.PANE_LAYOUT_SHOTS || '')}){
            const dir=${JSON.stringify(process.env.PANE_LAYOUT_SHOTS || '')};fs.mkdirSync(dir,{recursive:true});
            for(const [width,height] of [[1512,945],[1100,650]]){
              win.setContentSize(width,height);await run('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
              assert.equal(await run('(()=>{const r=document.querySelector("[role=menu]").getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.bottom<=innerHeight})()'),true,'menu stays inside '+width+'x'+height);
              fs.writeFileSync(dir+'/picker-'+width+'x'+height+'.png',(await win.webContents.capturePage()).toPNG());
            }
            win.setContentSize(600,600);
          }
          await key('Up'); assert.equal(await active(),'Focus right','ArrowUp wraps');
          await key('Down'); assert.equal(await active(),'Horizontal','ArrowDown wraps');
          await key('End'); assert.equal(await active(),'Focus right');
          await key('Home'); assert.equal(await active(),'Horizontal');
          await key('F'); assert.equal(await active(),'Focus left','typeahead finds a matching choice');
          await key('F'); assert.equal(await active(),'Focus right','repeated letter cycles matches');
          await key('Enter');
          assert.equal(await expanded(),'false');
          assert.equal(await run("document.activeElement.classList.contains('layout-picker-trigger')"),true);
          assert.deepEqual(await run('window.selections'),['right']);
          assert.equal(await run("document.querySelector('.layout-picker-trigger').getAttribute('aria-label')"),'Pane layout: Focus right');
          await key('Up'); assert.equal(await active(),'Focus right');
          await key('Home'); await key('Space');
          assert.deepEqual(await run('window.selections'),['right','horizontal']);
          await run("document.querySelector('.layout-picker-trigger').click()");
          await until("document.activeElement.getAttribute('role')==='menuitemradio'");
          assert.equal(await active(),'Horizontal','pointer opening focuses the selected choice');
          await key('Down'); await key('Escape');
          assert.equal(await expanded(),'false');
          assert.equal(await run("document.activeElement.classList.contains('layout-picker-trigger')"),true);
          assert.deepEqual(await run('window.selections'),['right','horizontal'],'Escape never selects');
          await key('Down');
          await until("document.activeElement.getAttribute('role')==='menuitemradio'");
          await key('Tab');
          await until("document.querySelector('.layout-picker-trigger').getAttribute('aria-expanded')==='false' && document.activeElement.id==='after'");
          assert.equal(await expanded(),'false'); assert.equal(await active(),'after','Tab moves beyond the menu');
          await trigger(); await key('Down');
          await until("document.activeElement.getAttribute('role')==='menuitemradio'");
          await key('Tab',['shift']);
          await until("document.querySelector('.layout-picker-trigger').getAttribute('aria-expanded')==='false' && document.activeElement.classList.contains('layout-picker-trigger')");
          assert.equal(await expanded(),'false');
          assert.equal(await run("document.activeElement.classList.contains('layout-picker-trigger')"),true,'Shift+Tab returns to the trigger');
          await key('Down');
          await run("document.querySelector('#after').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}))");
          assert.equal(await expanded(),'false','outside pointer closes');
          await run("document.querySelector('.layout-picker-trigger').click()");
          await run("[...document.querySelectorAll('[role=menuitemradio]')].find(node=>node.textContent.includes('Even grid')).click()");
          await run('window.zoomIn()');await until('window.arrangement.zoom===2');
          await run("document.querySelector('.layout-picker-trigger').click()");
          await run("[...document.querySelectorAll('[role=menuitemradio]')].find(node=>node.textContent.includes('Even grid')).click()");
          assert.equal(await run('window.arrangement.zoom'),2,'picking the current layout preserves its zoom');
          await trigger(); await key('Down'); await run('window.setDisabled(true)');
          await until("document.querySelector('.layout-picker-trigger').disabled");
          assert.equal(await expanded(),'false','disabling closes the menu');
          assert.equal(await run("document.querySelector('[role=menu]').getBoundingClientRect().height"),0);
          await run("document.querySelector('.layout-picker-trigger').click()");
          assert.equal(await expanded(),'false','disabled trigger cannot open');
          console.log('Layout picker keyboard checks passed');app.exit(0);
        }catch(error){console.error(error.stack);app.exit(1);}
      });
    `);
    const result = await runElectronScenario(electron, main, temp, { timeoutMs: 40000, attempts: 1 });
    assert.equal(result.code, 0, result.output);
  } finally { await server.close(); fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});
