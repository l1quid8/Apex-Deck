import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import electron from 'electron';
import { createServer } from 'vite';
import { runElectronScenario } from './helpers/electron-test.mjs';

test('native phone shell opens Local chat, streams a family-selected turn, persists history and pauses for an empty catalog', { timeout: 200000 }, async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'phone-local-chat-'));
  const server = await createServer({ cacheDir: path.join(temp, 'vite-cache'), server: { port: 0 }, logLevel: 'error' });
  await server.listen();
  const url = `http://localhost:${server.httpServer.address().port}/phone.html`;
  const main = path.join(temp, 'main.cjs');
  fs.writeFileSync(main, `
const {app,BrowserWindow}=require('electron');const assert=require('node:assert/strict');
app.whenReady().then(async()=>{try{
 const win=new BrowserWindow({show:false,width:402,height:874,webPreferences:{backgroundThrottling:false}});
 const run=(fn)=>win.webContents.executeJavaScript('('+fn.toString()+')()');
 const wait=async(fn)=>{for(let i=0;i<400;i++){if(await run(fn))return;await new Promise(r=>setTimeout(r,50));}throw Error('Timed out: '+fn);};
 await win.loadURL(${JSON.stringify(url)});
 await wait(()=>document.querySelector('[aria-label="Settings"]'));
 await run(()=>document.querySelector('[aria-label="Settings"]').click());
 await wait(()=>Array.from(document.querySelectorAll('button')).some(b=>b.textContent.includes('Local chat')));
 await run(()=>Array.from(document.querySelectorAll('button')).find(b=>b.textContent.includes('Local chat')).click());
 await wait(()=>document.querySelector('[aria-label="Local chat setup link"]'));
 await run(()=>{localStorage.setItem('apex-deck.ios.gateway-config.v1',JSON.stringify({baseUrl:'http://gateway.test',apiKey:'apx_sk_fixture',hostLabel:'Fixture host',keySuffix:'…ure'}));localStorage.setItem('apex-deck.ios.thread-history.v1','[]');});
 await win.reload();await wait(()=>document.querySelector('[aria-label="Settings"]'));
 await run(()=>{window.originalFetch=window.fetch;window.emptyModels=false;window.sentModel='';window.fetch=async(input,options)=>{const url=String(input);if(url==='http://gateway.test/v1/models')return new Response(JSON.stringify({data:window.emptyModels?[]:[{id:'codex/fixture'}]}),{headers:{'Content-Type':'application/json'}});if(url==='http://gateway.test/v1/chat/completions'){window.sentModel=JSON.parse(options.body).model;return new Response('data: '+JSON.stringify({choices:[{delta:{content:'PHONE_LOCAL_STREAM_OK'}}]})+'\\n\\ndata: [DONE]\\n\\n',{headers:{'Content-Type':'text/event-stream'}});}return window.originalFetch(input,options);};document.querySelector('[aria-label="Sections"] button:nth-child(3)').click();});
 await wait(()=>document.querySelector('[aria-label="New local chat session"]'));
 await run(()=>document.querySelector('[aria-label="New local chat session"]').click());
 await wait(()=>document.querySelector('[aria-label="Message local chat"]')&&!document.querySelector('[aria-label="Message local chat"]').disabled);
 await run(()=>{const t=document.querySelector('[aria-label="Message local chat"]');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(t,'@codex Phone test');t.dispatchEvent(new Event('input',{bubbles:true}));});
 await wait(()=>!document.querySelector('[aria-label="Send local chat message"]').disabled);
 await run(()=>document.querySelector('[aria-label="Send local chat message"]').click());
 await wait(()=>document.body.textContent.includes('PHONE_LOCAL_STREAM_OK'));
 assert.equal(await run(()=>window.sentModel),'codex/fixture');
 await run(()=>document.querySelector('[aria-label="Back to Threads"]').click());
 await wait(()=>Array.from(document.querySelectorAll('button')).some(b=>b.textContent.includes('Phone test')));
 assert.equal(await run(()=>JSON.parse(localStorage.getItem('apex-deck.ios.thread-history.v1'))[0].messages.at(-1).content),'PHONE_LOCAL_STREAM_OK');
 await run(()=>{window.emptyModels=true;Array.from(document.querySelectorAll('button')).find(b=>b.textContent.includes('Phone test')).click();});
 await wait(()=>document.body.textContent.includes('No models for this key'));
 assert.equal(await run(()=>document.querySelector('[aria-label="Send local chat message"]').disabled),true);
 assert.equal(await run(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
 app.exit(0);
}catch(error){console.error(error.stack);app.exit(1);}});
`);
  try { const result = await runElectronScenario(electron, main, temp, { attempts: 1 }); assert.equal(result.code, 0, result.output); }
  finally { await server.close(); fs.rmSync(temp,{recursive:true,force:true,maxRetries:5,retryDelay:100}); }
});
