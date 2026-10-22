import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import electron from 'electron';
import { runElectronScenario } from './helpers/electron-test.mjs';

test('short empty thread scrolls welcome copy above the composer', { timeout: 140000 }, async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'thread-landing-fit-'));
  const styles = ['src/styles.css', 'src/landing/landing-texture.css'].map(p => `<link rel="stylesheet" href="${pathToFileURL(path.resolve(p))}">`).join('');
  const html = path.join(temp, 'fixture.html');
  fs.writeFileSync(html, `${styles}<div class="chat thread-chat thread-landing" style="width:680px;height:420px;--composer-h:180px">
    <div class="chat-body"><div class="transcript"><div class="empty">
      <div class="landing-texture-wrap"></div><div class="empty-copy">
      <div class="empty-emblem">Chat</div><span class="eyebrow">A fresh perspective starts here</span>
      <h3 class="ask">What should we work on in <button class="pick-name">apex-deck</button>?</h3>
      <p class="where">On This Mac · /Users/tylercaldwell/Downloads/apex-deck</p>
      <p>Type a message below. Use @name to pick who answers, or @all for everyone.</p>
      <div class="example-rows"><button class="example-row">e.g. @all what would you change first?</button><button class="example-row">e.g. @null review the last commit</button><button class="example-row">e.g. /export markdown</button></div>
    </div></div></div></div><form class="composer" style="height:180px;flex-shrink:0"><textarea aria-label="Message">bottom right pane needs to be fixed</textarea></form></div>`);
  const main = path.join(temp, 'main.cjs');
  fs.writeFileSync(main, `const {app,BrowserWindow}=require('electron');const assert=require('node:assert/strict');
    app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,width:1000,height:1000});try{
      await win.loadFile(${JSON.stringify(html)});
      for(const height of [420,300,800]){
        const result=await win.webContents.executeJavaScript(
          '('+function(height){
            const chat=document.querySelector('.chat'),scroll=document.querySelector('.transcript'),composer=document.querySelector('.composer');
            chat.style.height=height+'px';scroll.scrollTop=scroll.scrollHeight;
            const a=scroll.getBoundingClientRect(),b=composer.getBoundingClientRect(),last=document.querySelector('.example-rows').lastElementChild.getBoundingClientRect();
            return {scrollBottom:a.bottom,composerTop:b.top,lastBottom:last.bottom,scrollTop:scroll.scrollTop,clientHeight:scroll.clientHeight};
          }.toString()+')('+height+')');
        assert.ok(result.scrollBottom<=result.composerTop+1,'scrollport must end above composer: '+JSON.stringify(result));
        assert.ok(result.lastBottom<=result.composerTop+1,'last example must be reachable above composer: '+JSON.stringify(result));
        assert.ok(result.clientHeight>0,'transcript remains scrollable');
      }
      app.exit(0);
    }catch(error){console.error(error.stack);app.exit(1);}});`);
  try { const result = await runElectronScenario(electron, main, temp, { attempts: 1 }); assert.equal(result.code, 0, result.output); }
  finally { fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});
