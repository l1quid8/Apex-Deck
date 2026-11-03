import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import electron from 'electron';
import { createServer } from 'vite';
import { runElectronScenario } from './helpers/electron-test.mjs';

test('real assistant textarea recalls and restores through native arrow events', { timeout: 120000 }, async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-history-ui-'));
  const html = `<div id="root"></div><script type="module">
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { ApexAgentAll } from '/src/ApexAgentAll.tsx';
    import { setAssistantComposerField } from '/src/assistantComposerDrafts.ts';
    window.replaceDraft = value => setAssistantComposerField('keyboard-history', 'text', value);
    const messages = ['old prompt', 'new prompt'].map((text, i) => ({id: String(i), role: 'human', at: i + 1, text, evidence: []}));
    createRoot(document.getElementById('root')).render(React.createElement(ApexAgentAll, {
      draftKey: 'keyboard-history', workspaces: [{id: 'one', name: 'One'}],
      monitors: [{ workspaceId: 'one', messages, findings: [], paused: false }],
      onReply: async () => {}, onMutate: async () => {}, onSetUp() {}, onClose() {}
    }));
  </script>`;
  const server = await createServer({ cacheDir: path.join(temp, 'cache'), server: { port: 0 }, logLevel: 'error', plugins: [{ name: 'history-ui-test', configureServer(s) { s.middlewares.use('/__history_ui', async (_q, res) => { res.setHeader('Content-Type', 'text/html'); res.end(await s.transformIndexHtml('/__history_ui', html)); }); } }] });
  try {
    await server.listen();
    const main = path.join(temp, 'main.cjs');
    fs.writeFileSync(main, `const {app,BrowserWindow}=require('electron');const assert=require('node:assert/strict');
      app.whenReady().then(async()=>{try{
        const win=new BrowserWindow({show:false,webPreferences:{offscreen:true}});
        const run=code=>win.webContents.executeJavaScript(code);
        const frame=()=>run('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
        await win.loadURL('http://localhost:${server.httpServer.address().port}/__history_ui');
        let ready=false;for(let i=0;i<400;i++){if(await run('!!document.querySelector("textarea")')){ready=true;break;}await new Promise(r=>setTimeout(r,25));}assert.ok(ready,'composer mounted');
        const value=()=>run('document.querySelector("textarea").value');
        const press=async key=>{win.webContents.sendInputEvent({type:'keyDown',keyCode:key});win.webContents.sendInputEvent({type:'keyUp',keyCode:key});await frame();};
        await run('replaceDraft("unfinished");');await frame();
        await run('document.querySelector("textarea").focus();document.querySelector("textarea").setSelectionRange(3,3)');
        await press('Up');assert.equal(await value(),'new prompt');
        assert.equal(await run('document.querySelector("textarea").selectionStart'),10);
        await press('Up');assert.equal(await value(),'old prompt');
        await press('Up');assert.equal(await value(),'old prompt');
        await press('Down');assert.equal(await value(),'new prompt');
        await press('Down');assert.equal(await value(),'unfinished');
        assert.equal(await run('document.querySelector("textarea").selectionStart'),3);
        await press('Up');assert.equal(await value(),'new prompt');
        await run('replaceDraft("new prompt")');await frame();
        await press('Down');assert.equal(await value(),'new prompt','same-text external write resets browsing');
        await run('replaceDraft("first\\\\nsecond")');await frame();
        await run('document.querySelector("textarea").setSelectionRange(9,9)');await press('Up');assert.equal(await value(),'first\\nsecond','second line keeps caret movement');
        win.destroy();app.exit(0);
      }catch(error){console.error(error);app.exit(1);}});`);
    const result = await runElectronScenario(electron, main, temp);
    assert.equal(result.code, 0, result.output);
  } finally {
    await server.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
