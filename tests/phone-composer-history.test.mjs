import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import electron from 'electron';
import { createServer } from 'vite';
import { runElectronScenario } from './helpers/electron-test.mjs';

test('phone composer hardware arrows recall local history and preserve native editing', { timeout: 120000 }, async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'phone-composer-history-'));
  // Export the real private component only in this test server; no production test API.
  const html = `<div id="root"></div><script type="module">
    import React, {useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {ThreadView} from '/src/phone/PhoneApp.tsx';
    const message = (text, seq, kind = 'human') => ({text, seq, speaker: {kind, id: 'bot'}, at: 1});
    function Harness() {
      const [draft, setDraft] = useState({text: 'unfinished', files: [{id:'file', name:'keep.txt'}]});
      const [quotes, setQuotes] = useState([{id:'bot',name:'Bot',text:'keep this quote'}]);
      const [context, setContext] = useState({paneId:'room', host:'one'});
      const [messages, setMessages] = useState([message('old prompt',1), message('new prompt',2), message('  ',3), message('bot answer',4,'bot')]);
      window.replaceDraft = text => setDraft(d => ({...d, text}));
      window.switchContext = setContext;
      window.replaceHistory = texts => setMessages(texts.map((text, i) => message(text, i + 1)));
      window.draft = draft;
      return React.createElement(ThreadView, {
        paneId:context.paneId, link:{id:context.host,status:'online'}, messages, draft,
        title:'Test', project:'Project', machine:'Mac', path:'', kind:'mac', started:true,
        callSlot:{live:false,look:'pill',hint:''}, participants:[{id:'bot',display_name:'Bot',look:{seed:1,color:'#777'}}],
        working:{}, cut:{}, approvals:[], meters:{}, pins:[], quotes, onQuotes:setQuotes, queued:[],
        gate:{enabled:true,reason:''}, endRef:{current:null}, runner:null,
        onDraft:window.replaceDraft, onResized() {}, onScrolled() {},
        onSend(){window.sends++; window.replaceDraft('');}
      });
    }
    window.sends=0;
    createRoot(document.getElementById('root')).render(React.createElement(Harness));
  </script>`;
  const server = await createServer({
    cacheDir: path.join(temp, 'cache'), server: {port: 0}, logLevel: 'error',
    plugins: [{
      name: 'phone-history-fixture', enforce: 'pre',
      transform(code, id) { if (id.endsWith('/src/phone/PhoneApp.tsx')) return code + '\nexport {ThreadView};'; },
      configureServer(s) { s.middlewares.use('/__phone_history', async (_req, res) => {
        res.setHeader('Content-Type', 'text/html');
        res.end(await s.transformIndexHtml('/__phone_history', html));
      }); },
    }],
  });
  try {
    await server.listen();
    const main = path.join(temp, 'main.cjs');
    fs.writeFileSync(main, `
      const {app,BrowserWindow}=require('electron'); const assert=require('node:assert/strict');
      app.whenReady().then(async()=>{try {
        const win=new BrowserWindow({show:false,width:430,height:900,webPreferences:{offscreen:true}});
        const run=code=>win.webContents.executeJavaScript(code);
        const frame=()=>run('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
        await win.loadURL('http://localhost:${server.httpServer.address().port}/__phone_history');
        let ready=false; for(let i=0;i<400;i++){if(await run('!!document.querySelector("textarea")')){ready=true;break;}await new Promise(r=>setTimeout(r,25));}
        assert.ok(ready,'phone composer mounted');
        const value=()=>run('document.querySelector("textarea").value');
        const caret=async(start,end=start)=>run('document.querySelector("textarea").focus();document.querySelector("textarea").setSelectionRange('+start+','+end+')');
        const press=async key=>{win.webContents.sendInputEvent({type:'keyDown',keyCode:key});win.webContents.sendInputEvent({type:'keyUp',keyCode:key});await frame();};
        const replace=async text=>{await run('replaceDraft('+JSON.stringify(text)+')');await frame();};
        const history=async texts=>{await run('replaceHistory('+JSON.stringify(texts)+')');await frame();};
        const synthetic=async extra=>{const consumed=await run('(()=>{const e=new KeyboardEvent("keydown",{key:"ArrowUp",bubbles:true,cancelable:true,...'+JSON.stringify(extra)+'});document.querySelector("textarea").dispatchEvent(e);return e.defaultPrevented;})()');await frame();return consumed;};
        await caret(3); await press('Up'); assert.equal(await value(),'new prompt');
        assert.equal(await run('document.querySelector("textarea").selectionStart'),10);
        await press('Up'); assert.equal(await value(),'old prompt');
        await press('Up'); assert.equal(await value(),'old prompt','oldest entry does not wrap');
        await press('Down'); assert.equal(await value(),'new prompt');
        await press('Down'); assert.equal(await value(),'unfinished');
        assert.equal(await run('document.querySelector("textarea").selectionStart'),3,'draft caret is restored');
        assert.equal(await run('window.draft.files[0].name'),'keep.txt','recall preserves attachments');
        assert.equal(await run('document.querySelector(".quote-preview blockquote").textContent'),'keep this quote','recall preserves quotes');
        assert.equal(await run('window.sends'),0,'arrows never send');

        // Native editing guards and newline boundaries.
        await caret(1,4); assert.equal(await synthetic({}),false); assert.equal(await value(),'unfinished');
        await caret(0);
        for(const extra of [{shiftKey:true},{ctrlKey:true},{metaKey:true},{altKey:true},{isComposing:true},{keyCode:229}]) {
          assert.equal(await synthetic(extra),false); assert.equal(await value(),'unfinished');
        }
        await replace('first\\nsecond'); await caret(9); assert.equal(await synthetic({}),false);
        await caret(2); await press('Up'); assert.equal(await value(),'new prompt');
        await press('Down'); assert.equal(await value(),'first\\nsecond');
        await history(['old prompt','line one\\nline two']);
        await replace('draft'); await caret(0); await press('Up'); assert.equal(await value(),'line one\\nline two');
        await caret(0); assert.equal(await synthetic({key:'ArrowDown'}),false,'Down in the first line edits normally');
        await caret(17); await press('Down'); assert.equal(await value(),'draft');

        // Actual typing ends browsing, including when the user types over a recall.
        await press('Up'); await win.webContents.insertText('!'); await frame();
        await press('Down'); assert.equal(await value(),'line one\\nline two!');
        await caret(0); await press('Up'); await press('Down'); assert.equal(await value(),'line one\\nline two!');

        // Host/thread switches discard the saved draft even if the visible text is identical.
        for(const context of [{paneId:'other',host:'one'},{paneId:'other',host:'two'}]) {
          await caret(0); await press('Up'); await run('switchContext('+JSON.stringify(context)+')'); await frame();
          await history(['other conversation']);
          await press('Down'); assert.equal(await value(),'line one\\nline two');
          await caret(0); await press('Up'); assert.equal(await value(),'other conversation');
          await history(['old prompt','line one\\nline two']); await replace('line one\\nline two!');
        }
        await caret(0); await press('Up'); await replace('voice replacement'); await press('Down'); assert.equal(await value(),'voice replacement');

        // Mention suggestions keep arrows, rather than replacing @ text with history.
        await replace('@'); await caret(1); await run('document.querySelector("textarea").dispatchEvent(new Event("select",{bubbles:true}))'); await frame();
        assert.ok(await run('!!document.querySelector(".ph-mentions")'),'mention suggestions are visible');
        assert.equal(await synthetic({}),false); assert.equal(await value(),'@');

        await replace('ready'); await caret(0); await press('Up');
        await run('document.querySelector(".ph-send").click()'); await frame();
        await caret(0); await press('Down'); assert.equal(await value(),'','send clears browsing');
        assert.equal(await run('window.sends'),1);
        await history([]);
        assert.equal(await synthetic({}),false); assert.equal(await value(),'','empty history leaves draft alone');
        win.destroy(); app.exit(0);
      } catch(error) {console.error(error.stack);app.exit(1);}});
    `);
    const result = await runElectronScenario(electron, main, temp);
    assert.equal(result.code, 0, result.output);
  } finally {
    await server.close();
    fs.rmSync(temp, {recursive:true, force:true});
  }
});
