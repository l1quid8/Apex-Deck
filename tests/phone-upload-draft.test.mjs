import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import electron from 'electron';
import { createServer } from 'vite';
import { runElectronScenario } from './helpers/electron-test.mjs';

test('phone send retains text and selected file after oversized upload, then retries on the same link', {timeout:200000}, async()=>{
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'phone-upload-draft-'));
  const html=`<div id="root"></div><script type="module">
    import React from 'react'; import {createRoot} from 'react-dom/client';
    import {PhoneApp} from '/src/phone/PhoneApp.tsx'; import {machinesKey} from '/src/phoneRules.ts';
    const bot={id:'bot',display_name:'Bot',persona:'',access:'read',effort:null,backend:{kind:'scripted',lines:['[pass]']}};
    const session={version:1,workspaces:[{id:'w',name:'Project',path:'/tmp/project'}],panes:[{id:'r',workspaceId:'w',kind:'chat',title:'Upload test',activeAt:Date.now()}],profiles:[bot],activeWorkspace:'w',focusedPane:'r',section:'threads',layout:'top'};
    window.fixture={calls:[],opens:0,closes:0};
    window.WebSocket=class {
      listeners={}; constructor(){window.fixture.opens++;setTimeout(()=>this.emit('open',{}),0);}
      addEventListener(name,fn){(this.listeners[name]??=[]).push(fn);}
      emit(name,event){for(const fn of this.listeners[name]??[])fn(event);}
      close(){window.fixture.closes++;this.emit('close',{});}
      send(line){const frame=JSON.parse(line);window.fixture.calls.push(frame);let ok=null;
        switch(frame.cmd){
          case 'hello':ok={protocol:1,host_id:'h',boot_id:'b',last_seq:0,resumed:false,max_frame_bytes:8*1024*1024};break;
          case 'session_load':ok=session;break;
          case 'room_state':ok={snapshot:{participants:[bot],options:{policy:'mention',max_bot_hops:0},transcript:[],pins:[],usage:{},changes:[]},active:[],approvals:[],questions:[]};break;
          case 'room_targets':ok=['bot'];break;
          case 'save_attachment':ok='/tmp/'+frame.args.name;break;
          case 'library_list':case 'personal_list':case 'monitor_list':case 'agents_detect':case 'agent_models':case 'room_bot_models':ok=[];break;
        }
        setTimeout(()=>this.emit('message',{data:JSON.stringify({id:frame.id,ok})}),0);
      }
    };
    localStorage.clear();sessionStorage.clear();
    localStorage.setItem(machinesKey(),JSON.stringify([{id:'local',name:'Test Mac',kind:'mac',url:'ws://fixture',token:'token'}]));
    localStorage.setItem('apex-deck.phone.session.v1',JSON.stringify(session));
    sessionStorage.setItem('apex-deck.phone.drafts.v1',JSON.stringify({r:'keep this draft'}));
    // Preserve the real picker callbacks without opening a native file dialog.
    const click=HTMLInputElement.prototype.click;HTMLInputElement.prototype.click=function(){if(this.type!=='file')click.call(this);};
    createRoot(document.getElementById('root')).render(React.createElement(PhoneApp));
  </script>`;
  const server=await createServer({cacheDir:path.join(temp,'vite-cache'),server:{port:0},logLevel:'error',plugins:[{name:'phone-upload-draft',configureServer(server){server.middlewares.use('/__phone_upload',async(_req,res)=>{res.setHeader('Content-Type','text/html');res.end(await server.transformIndexHtml('/__phone_upload',html));});}}]});
  await server.listen();const url=`http://localhost:${server.httpServer.address().port}/__phone_upload`;
  const main=path.join(temp,'main.cjs');
  fs.writeFileSync(main,`
    const {app,BrowserWindow}=require('electron');const assert=require('node:assert/strict');
    app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,width:430,height:900,webPreferences:{contextIsolation:true,backgroundThrottling:false}});
      win.webContents.on('console-message',(_e,...args)=>console.log(...args));
      const run=fn=>win.webContents.executeJavaScript('('+fn.toString()+')()');
      const wait=async fn=>{for(let i=0;i<800;i++){if(await run(fn))return;await new Promise(r=>setTimeout(r,20));}throw Error('Timed out '+fn+' '+await run(()=>document.body.innerText.slice(0,1500)+' '+JSON.stringify(window.fixture)));};
      const pick=async(size,name)=>{
        await run(()=>document.querySelector('.ph-add').click());await wait(()=>document.querySelector('.ph-composer-panel'));
        await run(()=>Array.from(document.querySelectorAll('.ph-composer-row')).find(b=>b.textContent.includes('Files')).click());
        await win.webContents.executeJavaScript('(()=>{const input=Array.from(document.querySelectorAll("input[type=file]")).find(i=>!i.accept&&!i.capture);const data=new DataTransfer();data.items.add(new File([new Uint8Array('+size+')],'+JSON.stringify(name)+',{type:"text/plain"}));Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"files").set.call(input,data.files);input.dispatchEvent(new Event("change",{bubbles:true}));})()');
        await wait(()=>document.querySelector('.ph-composer-attachment'));
        await run(()=>document.querySelector('.ph-composer-close').click());
      };
      try{await win.loadURL(${JSON.stringify(url)});await wait(()=>document.querySelector('.ph-tl-thread'));await run(()=>document.querySelector('.ph-tl-thread').click());await wait(()=>document.querySelector('.ph-send:not(:disabled)'));
        await pick(6*1024*1024,'large.txt');await run(()=>document.querySelector('.ph-send').click());await wait(()=>document.body.textContent.includes('too large'));
        assert.equal(await run(()=>document.querySelector('textarea').value),'keep this draft');
        assert.equal(await run(()=>window.fixture.calls.filter(c=>c.cmd==='save_attachment').length),0,'oversized file never reaches socket');
        assert.equal(await run(()=>window.fixture.closes),0,'rejection does not close link');
        await run(()=>document.querySelector('.ph-add').click());await wait(()=>document.querySelector('.ph-composer-attachment'));
        assert.equal(await run(()=>document.querySelector('.ph-composer-attachment').textContent.includes('large.txt')),true,'selected file retained');
        await run(()=>document.querySelector('.ph-composer-attachment button').click());await run(()=>document.querySelector('.ph-composer-close').click());
        await pick(4,'small.txt');await run(()=>document.querySelector('.ph-send').click());await wait(()=>window.fixture.calls.some(c=>c.cmd==='room_post_to'));
        await wait(()=>document.querySelector('textarea').value==='');
        assert.equal(await run(()=>window.fixture.calls.filter(c=>c.cmd==='save_attachment').length),1,'smaller upload reaches host');
        assert.equal(await run(()=>window.fixture.opens),1,'retry uses the same connection');
        assert.equal(await run(()=>document.querySelector('.ph-add').getAttribute('aria-label').includes('attached')),false,'successful send clears attachment');
        app.exit(0);
      }catch(error){console.error(error.stack);app.exit(1);}
    });
  `);
  try{const result=await runElectronScenario(electron,main,temp);assert.equal(result.code,0,result.output);}
  finally{await server.close();fs.rmSync(temp,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});
