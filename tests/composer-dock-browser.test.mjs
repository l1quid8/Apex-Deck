import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import electron from 'electron';
import { createServer } from 'vite';
import { transform } from 'sucrase';
import { runElectronScenario } from './helpers/electron-test.mjs';

test('shared dock keeps real thread drafts, caret, sizing and external insertion; opt-out stays inline', { timeout: 200000 }, async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'composer-dock-'));
  const html = `<html><body><div id="test-root"></div><script type="module">
    import React, {useState} from 'react'; import {createRoot} from 'react-dom/client';
    import {ChatPane, INSERT_COMPOSER_EVENT} from '/src/ChatPane.tsx';
    import {ComposerDock} from '/src/ComposerDock.tsx'; import {dockTarget} from '/src/composerTarget.ts';
    import {getBackend} from '/src/backend.ts'; import '/src/styles.css';
    const bot={id:'bot',display_name:'Bot',persona:'',access:'read',effort:null,backend:{kind:'scripted',lines:['[pass]']}};
    const snapshot={participants:[bot],options:{policy:'mention',max_bot_hops:3},transcript:[]};
    window.posts=[];
    const backend={...await getBackend(),roomTargets:async()=>['bot'],roomPostTo:async(...args)=>{window.posts.push(args);},roomState:async()=>({recovery_seq:1,snapshot,active:[],approvals:[]}),roomSteps:async()=>null,onRoomEvent:async()=>()=>{},onPtyData:async()=>()=>{},onPtyExit:async()=>()=>{},roomClose:async()=>{}};
    function Fixture(){
      const [target,setTarget]=useState('a'), [slot,setSlot]=useState(null), [outside,setOutside]=useState(false), [inline,setInline]=useState(false);
      window.fixture={outside,focus:setTarget,pop(){setOutside(true);setTarget('b');},inline(){setInline(true);},insert(id,text){window.dispatchEvent(new CustomEvent(INSERT_COMPOSER_EVENT,{detail:{paneId:id,text}}));}};
      const want=id=>{if(id==='a'&&outside){document.getElementById('notice').textContent='That thread is open in its own window.';return false;}setTarget(id);return true;}; const actual=dockTarget({focused:target,recent:['b','a'],candidates:['a','b'],popped:new Set(outside?['a']:[])});
      return <div id="fixture" style={{height:700,display:'flex',flexDirection:'column'}}><div style={{display:'flex',flex:1,minHeight:0}}>{['a','b'].map(id=><ChatPane key={id} dock={inline?undefined:{target:id===actual,slot}} onWantComposer={inline?undefined:want} pane={{id,workspaceId:'w',kind:'chat',title:id}} cwd='/tmp/project' agents={[]} backend={backend} focused={target===id} onActivity={()=>{}} profiles={[]} onProfilesChange={()=>{}} disabledProviders={[]}/>)}</div>{!inline&&<ComposerDock target={{paneId:actual,title:actual,project:'Project'}} slotRef={setSlot}/>}<span id="notice" /></div>;
    }
    createRoot(document.getElementById('test-root')).render(<Fixture/>); window.ready=true;
  </script></body></html>`;
  const server = await createServer({cacheDir:path.join(temp,'cache'),server:{port:0},logLevel:'error',plugins:[{name:'dock-test',configureServer(server){server.middlewares.use('/__dock',async(_req,res)=>{res.setHeader('Content-Type','text/html');const match=html.match(/<script type="module">([\s\S]*?)<\/script>/); const code=transform(match[1],{transforms:['jsx']});res.end(await server.transformIndexHtml('/__dock',html.replace(match[1],code.code)));});}}]});
  await server.listen();
  const url='http://localhost:'+server.httpServer.address().port+'/__dock';
  const main=path.join(temp,'main.cjs');
  fs.writeFileSync(main, `
    const {app,BrowserWindow}=require('electron'); const assert=require('node:assert/strict');
    app.whenReady().then(async()=>{
      const win=new BrowserWindow({show:false,width:1100,height:900,webPreferences:{contextIsolation:true,backgroundThrottling:false}});
      win.webContents.on('console-message',(_e,...args)=>console.log(...args)); console.log('loading dock');
      const run=fn=>win.webContents.executeJavaScript('('+fn.toString()+')()');
      const wait=async(fn,what)=>{for(let i=0;i<400;i++){if(await run(fn))return;await new Promise(r=>setTimeout(r,25));}throw Error('Timeout '+what+' '+await run(()=>document.body.innerText.slice(-1500)));};
      const type=async text=>{await run(()=>document.querySelector('.composer textarea').focus());await win.webContents.insertText(text);};
      try{
        await win.loadURL(${JSON.stringify(url)});
        await wait(()=>document.querySelector('.composer textarea:not(:disabled)'),'ready');
        assert.equal(await run(()=>document.querySelectorAll('.composer-input').length),1);
        await type('alpha');
        await run(()=>window.fixture.focus('b'));
        await wait(()=>document.querySelector('.composer-dock-target strong')?.textContent==='b','B');
        await type('beta');
        await run(()=>window.fixture.focus('a'));
        await wait(()=>document.querySelector('.composer textarea')?.value==='alpha','A draft');
        assert.deepEqual(await run(()=>{const t=document.querySelector('.composer textarea');return [t.selectionStart,t.selectionEnd];}),[5,5]);
        await type('\\nline two\\nline three');
        const before=await run(()=>{const t=document.querySelector('.composer textarea');t.setSelectionRange(9,12);return [t.value,t.selectionStart,t.selectionEnd,t.scrollTop,t.getBoundingClientRect().height];});
        await run(()=>window.fixture.focus('b'));
        await wait(()=>document.querySelector('.composer textarea')?.value==='beta','B draft');
        win.setSize(900,900);
        await run(()=>window.fixture.focus('a'));
        await wait(()=>document.querySelector('.composer textarea')?.value.startsWith('alpha'),'A multiline');
        const after=await run(()=>{const t=document.querySelector('.composer textarea');return [t.value,t.selectionStart,t.selectionEnd,t.scrollTop,t.getBoundingClientRect().height];});
        assert.deepEqual(after,before);
        await type(Array.from({length:30},(_,i)=>'line '+i).join('\\n'));
        const scrollBefore=await run(()=>{const t=document.querySelector('.composer textarea');t.setSelectionRange(15,20);t.scrollTop=80;return [t.selectionStart,t.selectionEnd,t.scrollTop];});
        await run(()=>window.fixture.focus('b'));
        await wait(()=>document.querySelector('.composer textarea')?.value==='beta','B after long draft');
        await run(()=>window.fixture.focus('a'));
        await wait(()=>document.querySelector('.composer textarea')?.value.includes('line 29'),'long A restored');
        assert.deepEqual(await run(()=>{const t=document.querySelector('.composer textarea');return [t.selectionStart,t.selectionEnd,t.scrollTop];}),scrollBefore);

        await run(()=>window.fixture.insert('b','src/App.tsx'));
        await wait(()=>document.querySelector('.composer textarea')?.value==='beta src/App.tsx','external insertion reveals B');
        assert.equal(await run(()=>document.querySelector('.composer textarea').selectionStart),16);
        await run(()=>window.fixture.pop());
        await wait(()=>window.fixture.outside,'pop committed');
        await run(()=>window.fixture.insert('a','HIDDEN'));
        await wait(()=>document.body.innerText.includes('That thread is open in its own window.'),'popped notice');
        assert.equal(await run(()=>document.querySelector('.composer-dock-target strong').textContent),'b');
        assert.equal(await run(()=>document.querySelectorAll('.composer-input').length),1);
        require('fs').writeFileSync('/tmp/task8-dock.png',(await win.webContents.capturePage()).toPNG());
        await run(()=>window.fixture.inline());
        await wait(()=>document.querySelectorAll('.composer-input').length===2,'inline composers');
        assert.equal(await run(()=>document.querySelector('.composer-dock')),null);
        assert.equal(await run(()=>[...document.querySelectorAll('.composer textarea')].some(t=>t.value.includes('HIDDEN'))),false);
        await run(()=>{const t=document.querySelector('.composer textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(t,'hi');t.dispatchEvent(new Event('input',{bubbles:true}));t.focus();});
        await wait(()=>document.querySelector('.composer textarea')?.value==='hi','inline typing');
        win.webContents.sendInputEvent({type:'keyDown',keyCode:'Enter'});
        win.webContents.sendInputEvent({type:'keyUp',keyCode:'Enter'});
        await wait(()=>window.posts.length===1,'inline post');
        assert.equal(await run(()=>window.posts[0][1]),'hi');
        console.log('Composer dock real ChatPane checks passed');app.exit(0);
      }catch(e){console.error(e.stack);app.exit(1);}
    });
  `);
  try { const result=await runElectronScenario(electron,main,temp); assert.equal(result.code,0,result.output); }
  finally {await server.close();fs.rmSync(temp,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});
