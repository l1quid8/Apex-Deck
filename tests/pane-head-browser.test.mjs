import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import electron from 'electron';
import { createServer } from 'vite';
import { runElectronScenario } from './helpers/electron-test.mjs';
import { transform } from 'sucrase';

const appSource = fs.readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const sidePanelEscape = transform(appSource.match(/  useEffect\(\(\) => \{\n    if \(!sidePanelFull\) return;[\s\S]*?\n  \}, \[sidePanelFull\]\);/)[0], { transforms: ['typescript'] }).code;

test('compact heads preserve controls, maximize from the title, marquee, and rename safely', { timeout: 100000 }, async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-head-'));
  const shots = process.env.PANE_HEAD_SHOTS || '';
  if (shots) fs.mkdirSync(shots, { recursive: true });
  const html = `<html><body style="padding:20px"><div id="root"></div><script type="module">
    import React,{useState,useEffect} from 'react';import {createRoot} from 'react-dom/client';import {createPortal} from 'react-dom';
    import {PaneHead,PaneVoicePortal} from '/src/PaneHead.tsx';import {ThreadName} from '/src/ThreadName.tsx';import '/src/styles.css';import '/src/glass-theme.css';import '/src/clay-theme.css';import '/src/voice/voice.css';
    window.renames=[];window.dragStarts=0;window.sidebarRenames=[];window.voiceActions=[];
    function Fixture(){
      const [width,setWidth]=useState(600),[title,setTitle]=useState('A deliberately long thread name for checking the title marquee'),[maximized,setMaximized]=useState(false),[menu,setMenu]=useState(false),[request,setRequest]=useState(0),[countsSlot,setCountsSlot]=useState(null),[voice,setVoice]=useState(false),[host,setHost]=useState('adaptive'),[externalSlot,setExternalSlot]=useState(null);
      window.fixture={setWidth,setTitle,setVoice,setHost};
      const [sidePanelFull,setSidePanelFull]=useState(false);window.setSidePanelFull=setSidePanelFull;window.sidePanelFull=sidePanelFull;
      ${sidePanelEscape}
      useEffect(()=>setCountsSlot(document.querySelector('.pane-head .pane-counts')),[]);
      useEffect(()=>{const key=e=>{if(e.key==='Escape'&&menu){e.preventDefault();e.stopPropagation();setMenu(false);}};document.addEventListener('keydown',key);return()=>document.removeEventListener('keydown',key);},[menu]);
      return React.createElement(React.Fragment,null,
        React.createElement('div',{id:'head-frame',style:{width}},React.createElement(PaneHead,{
          pane:{id:'p1',workspaceId:'w1',kind:'chat',title},workspace:{id:'w1',name:'apex-deck',path:'/repo'},status:'working',attention:undefined,statusText:'Working',server:'http://localhost:3000',host:{id:'remote',name:'Test Mac'},maximized,menuOpen:menu,renameRequest:request,
          projectTitle:'apex-deck on Test Mac · /repo',projectTint:'#a1b2c3',hostTint:'#a1b2c3',
          modStatuses:React.createElement('span',{className:'fixture-mod'},'Mod active'),
          onMaximize(){setMaximized(value=>!value)},onMenu(){setMenu(value=>!value)},onClose(){},onRename(name){window.renames.push(name);setTitle(name)},onDragStart(){window.dragStarts++},onOpenServer(){}
        })),
        countsSlot&&createPortal(React.createElement('span',{className:'thread-counts'},React.createElement('button',null,'2 artifacts')),countsSlot),
        React.createElement('div',{id:'composer',style:{width}},React.createElement(PaneVoicePortal,{countsSlot:host==='adaptive'?countsSlot:host==='external'?externalSlot:null},
          voice&&React.createElement('div',{className:'voice-capsule voice-call-ui',role:'region','aria-label':'Voice call'},
            React.createElement('button',{className:'voice-capsule-body','aria-label':'Call settings'},React.createElement('span',{className:'voice-who'},'An agent with a long name'),React.createElement('span',{className:'voice-status'},'Listening')),
            React.createElement('span',{className:'voice-timer'},'01:20'),
            React.createElement('button',{className:'voice-callbtn','aria-label':'Mute microphone',onClick(){window.voiceActions.push('mute')}},'M'),
            React.createElement('button',{className:'voice-end round','aria-label':'End call',onClick(){window.voiceActions.push('end')}},'E')))),
        React.createElement('div',{id:'external-head',className:'popout-bar',style:{width:600}},React.createElement('span',{ref:setExternalSlot})),
        React.createElement('output',{id:'maximized'},String(maximized)),
        menu&&React.createElement('div',{role:'menu',id:'head-menu'},React.createElement('button',{role:'menuitem',onClick(){setMenu(false);setRequest(value=>value+1)}},'Rename')),
        React.createElement('div',{id:'sidebar',style:{marginTop:40}},React.createElement(ThreadName,{title:'Sidebar name',onRename(name){window.sidebarRenames.push(name)}}))
      );
    }
    createRoot(document.getElementById('root')).render(React.createElement(Fixture));
  </script></body></html>`;
  const server = await createServer({ cacheDir: path.join(temp, 'vite-cache'), server: { port: 0 }, logLevel: 'error', plugins: [{ name: 'pane-head-test', configureServer(server) { server.middlewares.use('/__pane_head_test', async (_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(await server.transformIndexHtml('/__pane_head_test', html)); }); } }] });
  const main = path.join(temp, 'main.cjs');
  try {
    await server.listen();
    fs.writeFileSync(main, `
      const {app,BrowserWindow}=require('electron');const assert=require('node:assert/strict');const fs=require('node:fs');
      app.whenReady().then(async()=>{
        const win=new BrowserWindow({show:false,width:900,height:500,webPreferences:{contextIsolation:true,backgroundThrottling:false}});
        const run=code=>win.webContents.executeJavaScript(code);const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
        const until=async(code)=>{for(let i=0;i<300;i++){if(await run(code))return;await sleep(20)}throw Error('Timed out: '+code)};
        const key=async keyCode=>{win.webContents.sendInputEvent({type:'keyDown',keyCode});win.webContents.sendInputEvent({type:'keyUp',keyCode});await sleep(40)};
        const point=selector=>run("(()=>{const r=document.querySelector("+JSON.stringify(selector)+").getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()");
        const mouse=async(selector,clicks=1)=>{const p=await point(selector);win.webContents.sendInputEvent({type:'mouseMove',...p});for(let clickCount=1;clickCount<=clicks;clickCount++){win.webContents.sendInputEvent({type:'mouseDown',...p,button:'left',clickCount});win.webContents.sendInputEvent({type:'mouseUp',...p,button:'left',clickCount})}await sleep(50)};
        const setWidth=async width=>{await run('window.fixture.setWidth('+width+')');await sleep(100);await run('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')};
        const visible=()=>run("[...document.querySelectorAll('[data-head-part]')].filter(node=>node.getBoundingClientRect().width>0).map(node=>node.dataset.headPart)");
        const animation=()=>run("getComputedStyle(document.querySelector('.pane-head .thread-name-text')).animationName");
        const pointerOff=async()=>{
          // Retire native hover explicitly; a move inside a hidden Windows window
          // can leave its previous hover target active after a menu closes.
          win.webContents.sendInputEvent({type:'mouseLeave',x:-10,y:-10});
          await run('document.activeElement.blur()');
          await until("!document.querySelector('.pane-head').matches(':hover, :focus-within')");
        };
        try{
          await win.loadURL(${JSON.stringify(`http://localhost:${server.httpServer.address().port}/__pane_head_test`)});
          await until("!!document.querySelector('.pane-head')");
          for(const width of [600,190,125]){
            await setWidth(width);
            assert.equal(await run("document.querySelector('.pane-head').getBoundingClientRect().height"),28,'28px at '+width);
            assert.ok(await run("document.querySelector('.pane-head').scrollWidth<=document.querySelector('.pane-head').clientWidth"),'no overflow at '+width);
            if(width===190)assert.deepEqual(await visible(),['dot','title','maximize','menu','close']);
            if(width===125)assert.deepEqual(await visible(),['dot','title','close']);
            if(width===600){assert.ok((await visible()).includes('project'),'room for project at 600px');assert.ok((await visible()).includes('counts'),'portal counts participate in fitting');}
            if(${JSON.stringify(shots)})fs.writeFileSync(${JSON.stringify(shots)}+'/head-'+width+'.png',(await win.webContents.capturePage({x:20,y:20,width,height:28})).toPNG());
          }
          await setWidth(190);
          const starts=await run('window.dragStarts');await mouse('.pane-head .pane-title');
          assert.equal(await run('window.dragStarts'),starts+1,'the title can begin dragging outside the editor');
          await mouse('.pane-head .pane-title',2);
          assert.equal(await run("document.querySelector('#maximized').textContent"),'true');
          assert.equal(await run("!!document.querySelector('.pane-head input')"),false,'double-click does not rename');
          await run('window.setSidePanelFull(true)');await until('window.sidePanelFull');
          await key('Escape');
          assert.equal(await run('window.sidePanelFull'),false,'Escape first restores the full-screen side panel');
          assert.equal(await run("document.querySelector('#maximized').textContent"),'true','the same Escape keeps the pane maximized');
          await key('Escape');assert.equal(await run("document.querySelector('#maximized').textContent"),'false');
          await mouse('.pane-head .pane-title',2);
          await mouse('.pane-head [aria-haspopup=menu]');
          await key('Escape');
          assert.equal(await run("!!document.querySelector('#head-menu')"),false,'menu Escape closes the menu first');
          assert.equal(await run("document.querySelector('#maximized').textContent"),'true','menu Escape keeps full screen');
          await key('Escape');assert.equal(await run("document.querySelector('#maximized').textContent"),'false');
          await pointerOff();
          assert.equal(await animation(),'none');
          win.webContents.sendInputEvent({type:'mouseMove',...await point('.pane-head')});await sleep(450);
          const hoverState=await run("(()=>{const head=document.querySelector('.pane-head'),title=head.querySelector('.pane-title'),text=head.querySelector('.thread-name-text');return {hover:head.matches(':hover'),focus:head.matches(':focus-within'),marquee:title.classList.contains('marquee'),reducedMotion:matchMedia('(prefers-reduced-motion: reduce)').matches,titleWidth:title.clientWidth,textWidth:text.getBoundingClientRect().width}})()");
          assert.notEqual(await animation(),'none','cut-off title marquees on hover: '+JSON.stringify(hoverState));
          await pointerOff();assert.equal(await animation(),'none','leaving resets marquee');
          win.webContents.debugger.attach('1.3');await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
          win.webContents.sendInputEvent({type:'mouseMove',...await point('.pane-head')});await sleep(450);assert.equal(await animation(),'none','reduced motion keeps ellipsis');
          await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[]});win.webContents.debugger.detach();
          await mouse('.pane-head .pane-title',2);
          await mouse('.pane-head [aria-haspopup=menu]');await mouse('#head-menu button');
          await until("!!document.querySelector('.pane-head input')");
          const oldName=await run("document.querySelector('.pane-head input').value");
          assert.deepEqual(await run("(()=>{const input=document.querySelector('.pane-head input');return[input.selectionStart,input.selectionEnd]})()"),[0,oldName.length],'rename selects the old name');
          assert.equal(await run("!!document.querySelector('.pane-head .marquee')"),false,'editing has no marquee');
          const drags=await run('window.dragStarts');await mouse('.pane-head [data-head-part=dot]');assert.equal(await run('window.dragStarts'),drags,'the head cannot drag while editing');
          await run("document.querySelector('.pane-head input').focus()");await key('Escape');
          assert.equal(await run("!!document.querySelector('.pane-head input')"),false);assert.equal(await run("document.querySelector('#maximized').textContent"),'true','editor Escape keeps full screen');
          assert.deepEqual(await run('window.renames'),[],'Escape cancels rename');
          await mouse('.pane-head [aria-haspopup=menu]');await mouse('#head-menu button');await until("!!document.querySelector('.pane-head input')");
          await until("document.activeElement===document.querySelector('.pane-head input') && document.activeElement.selectionStart===0 && document.activeElement.selectionEnd===document.activeElement.value.length");
          win.webContents.insertText('Renamed thread');await until("document.querySelector('.pane-head input').value==='Renamed thread'");await key('Enter');
          assert.deepEqual(await run('window.renames'),['Renamed thread'],'Enter commits once');
          await mouse('#sidebar [role=button]',2);await until("!!document.querySelector('#sidebar input')");
          await until("document.activeElement===document.querySelector('#sidebar input') && document.activeElement.selectionStart===0 && document.activeElement.selectionEnd===document.activeElement.value.length");
          win.webContents.insertText('Sidebar renamed');await until("document.querySelector('#sidebar input').value==='Sidebar renamed'");await key('Enter');assert.deepEqual(await run('window.sidebarRenames'),['Sidebar renamed']);
          await run('window.fixture.setVoice(true)');
          for(const theme of ['classic','glass','clay']){
            await run('document.documentElement.dataset.deckTheme='+JSON.stringify(theme));
            for(const width of [600,350,240,239,190,120]){
              await setWidth(width);
              assert.equal(await run("document.querySelector('.pane-head').getBoundingClientRect().height"),28,'voice keeps a 28px '+theme+' head at '+width);
              assert.ok(await run("document.querySelector('.pane-head').scrollWidth<=document.querySelector('.pane-head').clientWidth"),'voice does not overflow '+theme+' head at '+width);
              assert.ok(await run("document.querySelector('.pane-head-title').getBoundingClientRect().width>=56"),'voice preserves title room at '+width);
              assert.equal(await run("!!document.querySelector('.pane-head .voice-capsule')"),width>=240,'capsule changes location without disappearing at '+width);
              for(const name of ['Mute microphone','End call']){
                assert.equal(await run("(()=>{const button=[...document.querySelectorAll('button')].find(button=>button.getAttribute('aria-label')==="+JSON.stringify(name)+");const r=button.getBoundingClientRect();const holder=button.closest('.pane-head, #composer').getBoundingClientRect();return r.width>0&&r.height>0&&r.top>=holder.top&&r.bottom<=holder.bottom&&r.left>=holder.left&&r.right<=holder.right})()"),true,name+' remains visible without clipping at '+theme+' '+width);
              }
            }
          }
          await run("document.querySelector('.voice-callbtn').focus()");await key('Space');
          await run("document.querySelector('.voice-end').focus()");await key('Space');
          assert.deepEqual(await run('window.voiceActions'),['mute','end'],'narrow fallback controls remain keyboard operable');
          await run("window.fixture.setHost('external')");await until("!!document.querySelector('#external-head .voice-capsule')");
          assert.equal(await run("document.querySelector('#external-head .voice-capsule').getBoundingClientRect().height"),32,'external hosts retain their existing capsule size');
          assert.ok(await run("document.querySelector('#external-head .voice-capsule-body').getBoundingClientRect().width>0"),'external hosts retain call settings');
          await run("window.fixture.setHost('none')");await until("!document.querySelector('.voice-capsule')");
          assert.equal(await run("!!document.querySelector('.pane-voice-fallback')"),false,'hosts without a slot keep omitting the capsule');
          console.log('Pane head browser checks passed');app.exit(0);
        }catch(error){console.error(error.stack);app.exit(1)}
      });
    `);
    const result = await runElectronScenario(electron, main, temp, { timeoutMs: 45000, attempts: 1 });
    assert.equal(result.code, 0, result.output);
  } finally { await server.close(); fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});
