import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import electron from 'electron';
import { createServer } from 'vite';
import { runElectronScenario } from './helpers/electron-test.mjs';

test('phone assistant fits narrow and keyboard viewports with reachable message actions and one send', {timeout:120000}, async () => {
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'phone-assistant-layout-'));
  const html=`<html><meta name="viewport" content="width=device-width,initial-scale=1"><body><div id="root"></div><script type="module">
    import React from 'react';import {createRoot} from 'react-dom/client';
    import {setAssistantComposerField} from '/src/assistantComposerDrafts.ts';import '/src/styles.css';import {ApexAgentAll} from '/src/ApexAgentAll.tsx';import '/src/phone/phone.css';
    const f=window.fixture={sent:[],reactions:[],phone:true};f.setPlan=()=>setAssistantComposerField('layout-test','planOn',true);
    const personal={name:'Alfred',hostName:'MacBook Pro with a long destination name',offline:false,
      assistant:{id:'a',name:'Alfred',hostId:'mac',revision:1,allowedFolders:[],tasks:[],messages:[
        {id:'m1',role:'human',kind:'message',at:Date.now()-60000,text:'Check these changes for me.'},
        {id:'m2',role:'assistant',kind:'message',at:Date.now(),text:'I’ll check the changes and let you know what needs attention. All existing actions remain available.'}]},
      send:async text=>{f.sent.push(text)},decide:async()=>{},cancel:async()=>{}};
    const root=createRoot(document.getElementById('root'));
    f.render=()=>root.render(React.createElement('div',{className:f.phone?'ph-app':''},React.createElement('div',{className:'apex-agent-backdrop'},React.createElement(ApexAgentAll,{phone:f.phone,draftKey:'layout-test',taskContext:f.taskContext,workspaces:[],monitors:[],personal,onReply:async()=>{},onMutate:async()=>{},onSetUp(){},onClose(){},onReact:async(...args)=>f.reactions.push(args),saveAttachment:async(_lane,name)=>'/attachments/'+name}))));
    f.render();
  </script></body></html>`;
  const server=await createServer({cacheDir:path.join(temp,'cache'),logLevel:'error',server:{port:0},plugins:[{name:'assistant-layout-fixture',configureServer(server){server.middlewares.use('/assistant-layout',async(_req,res)=>{res.setHeader('Content-Type','text/html');res.end(await server.transformIndexHtml('/assistant-layout',html));});}}]});
  try {
    await server.listen();
    const main=path.join(temp,'main.cjs');
    fs.writeFileSync(main,`
      const {app,BrowserWindow}=require('electron');const assert=require('node:assert/strict');const fs=require('node:fs');
      app.whenReady().then(async()=>{try{
        const win=new BrowserWindow({show:false,width:393,height:852});
        const run=fn=>win.webContents.executeJavaScript('('+fn.toString()+')()');
        const wait=async fn=>{for(let i=0;i<400;i++){if(await run(fn))return;await new Promise(r=>setTimeout(r,25));}throw Error('Timed out '+fn);};
        await win.loadURL('http://localhost:${server.httpServer.address().port}/assistant-layout');
        await wait(()=>!!document.querySelector('.assistant-phone-send'));
        const geometry=()=>{
          const nodes=[...document.querySelectorAll('.composer-box,.composer-field,textarea,.tldr-pill,.assistant-phone-send,.compact-actions,.apex-agent-reaction-options')].filter(e=>e.getClientRects().length);
          return nodes.map(e=>({name:e.className,left:e.getBoundingClientRect().left,right:e.getBoundingClientRect().right,width:e.getBoundingClientRect().width}));
        };
        for(const [width,height] of [[320,640],[393,852],[430,932],[393,430]]){
          win.setContentSize(width,height);await new Promise(r=>setTimeout(r,150));
          for(const r of await run(geometry)){assert.ok(r.left>=-1&&r.right<=width+1,JSON.stringify({width,r}));}
          const box=await run(()=>{const r=document.querySelector('.apex-agent-all-composer').getBoundingClientRect();return {bottom:r.bottom,height:r.height}});
          assert.ok(box.bottom<=height+1,JSON.stringify(box));assert.ok(box.height<180,JSON.stringify(box));
        }
        assert.equal(await run(()=>document.querySelectorAll('.apex-agent-all-composer button[type=submit]').length),1);
        assert.equal(await run(()=>document.querySelector('.assistant-phone-send').disabled),true);
        assert.equal(await run(()=>[...document.querySelectorAll('.compact-actions .copy')].filter(e=>e.getClientRects().length).length),0);
        await run(()=>document.querySelectorAll('.action-disclosure')[1].click());
        await wait(()=>!!document.querySelector('.compact-actions .copy'));
        assert.equal(await run(()=>[...document.querySelectorAll('.compact-actions [aria-label="Read aloud"]')].filter(e=>e.getClientRects().length).length),1);
        await run(()=>{window.fixture.readButton=document.querySelector('.compact-actions.expanded .read-aloud');document.querySelector('[aria-label="Hide message actions"]').click()});
        await wait(()=>!document.querySelector('.compact-actions.expanded'));
        assert.equal(await run(()=>window.fixture.readButton.isConnected),true,'collapsing must not unmount active read-aloud playback');
        await run(()=>document.querySelectorAll('.action-disclosure')[1].click());
        await wait(()=>!!document.querySelector('.compact-actions.expanded'));
        assert.equal(await run(()=>window.fixture.readButton===document.querySelector('.compact-actions.expanded .read-aloud')),true);

        win.setContentSize(320,640);await new Promise(r=>setTimeout(r,150));
        await run(()=>document.querySelector('.compact-actions [aria-label="Add reaction"]').click());
        await wait(()=>!!document.querySelector('.apex-agent-reaction-options'));
        for(const r of await run(geometry))assert.ok(r.left>=-1&&r.right<=321,JSON.stringify(r));
        await run(()=>document.querySelector('[aria-label="React 👍"]').click());
        await wait(()=>window.fixture.reactions.length===1);
        await run(()=>document.querySelector('.compact-actions.expanded [aria-label="Reply to this message"]').click());
        await wait(()=>!!document.querySelector('.apex-agent-reply-quote'));
        await run(()=>document.querySelector('[aria-label="TL;DR mode"]').click());
        assert.equal(await run(()=>document.querySelector('[aria-label="TL;DR mode"]').getAttribute('aria-pressed')),'true');
        await run(()=>{const input=document.querySelector('textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'Please review this');input.dispatchEvent(new Event('input',{bubbles:true}));});
        await wait(()=>!document.querySelector('.assistant-phone-send').disabled);
        await run(()=>document.querySelector('.assistant-phone-send').click());
        await wait(()=>window.fixture.sent.length===1);
        assert.match(await run(()=>window.fixture.sent[0]),/Please review this/);
        await run(()=>{const input=document.querySelector('input[type=file]');const files=new DataTransfer();files.items.add(new File(['example'],'long-attachment-name-for-small-phones.txt',{type:'text/plain'}));input.files=files.files;input.dispatchEvent(new Event('change',{bubbles:true}));});
        await wait(()=>!!document.querySelector('.attachment')&&!document.querySelector('.assistant-phone-send').disabled);
        for(const r of await run(geometry))assert.ok(r.left>=-1&&r.right<=321,JSON.stringify(r));
        await run(()=>document.querySelector('.attachment-remove').click());
        await run(()=>{window.fixture.taskContext={id:'t',project:'A very long project name for this compact screen',label:'Check the long destination and task reply layout',send:async text=>window.fixture.sent.push(text)};window.fixture.render();window.fixture.setPlan();});
        await wait(()=>!!document.querySelector('.plan-chip')&&!!document.querySelector('.assistant-composer-heading'));
        for(const r of await run(geometry))assert.ok(r.left>=-1&&r.right<=321,JSON.stringify(r));
        assert.ok(await run(()=>document.documentElement.scrollWidth<=innerWidth));
        await run(()=>{window.fixture.taskContext=null;window.fixture.render();document.querySelector('.plan-chip').click();document.querySelector('[aria-label="Hide message actions"]').click();});
        win.setContentSize(393,852);await new Promise(r=>setTimeout(r,150));
        fs.writeFileSync('/tmp/apex-ios-assistant-layout.png',(await win.webContents.capturePage()).toPNG());
        await run(()=>{window.fixture.phone=false;window.fixture.render()});
        win.setContentSize(1100,850);
        await wait(()=>!!document.querySelector('.apex-agent-all-send'));
        assert.equal(await run(()=>document.querySelectorAll('.assistant-phone-send').length),0);
        assert.equal(await run(()=>document.querySelectorAll('.compact-actions').length),0);
        assert.ok(await run(()=>document.querySelectorAll('.message-primary-actions .copy').length)>0);
        win.destroy();app.exit(0);
      }catch(error){console.error(error.stack);app.exit(1);}});
    `);
    const result=await runElectronScenario(electron,main,temp,{attempts:1});
    assert.equal(result.code,0,result.output);
  }finally{await server.close();fs.rmSync(temp,{recursive:true,force:true});}
});
