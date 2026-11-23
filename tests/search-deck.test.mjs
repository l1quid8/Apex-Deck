import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import electron from 'electron';
import { createServer } from 'vite';
import { runElectronScenario } from './helpers/electron-test.mjs';

// The real SearchDeck field in a rail, beside a real ChatPane, against scripted machines.
// SEARCH_DECK_SHOTS=<folder> also saves screenshots of each state.
test('Search Deck keeps focus in the field, opens the chosen duplicate, and outlines that exact message', { timeout: 200000 }, async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'search-deck-'));
  const shots = process.env.SEARCH_DECK_SHOTS ? path.resolve(process.env.SEARCH_DECK_SHOTS) : '';
  const html = `<div id="root"></div><script type="module">
    import React, {useState} from 'react'; import {createRoot} from 'react-dom/client';
    import {SearchDeck} from '/src/SearchDeck.tsx'; import {ChatPane} from '/src/ChatPane.tsx';
    import {getBackend} from '/src/backend.ts';
    import '/src/styles.css'; import '/src/clay-theme.css';
    const h=React.createElement;
    const dup='Try the installer on a clean Mac before signing off.';
    const bot={id:'null',display_name:'Null',persona:'',access:'read',effort:null,backend:{kind:'scripted',lines:['[pass]']}};
    const lines=['Morning. Where are we on the release?','Two checks left.',dup,'Which Mac?','The spare one in the lab.',dup,'On it.','Signing next.','Notarization passed.','Uploading the disk image.','Upload finished.','Release notes are drafted.','Anything else before we ship?','No, that is everything.'];
    const transcript=lines.map((text,seq)=>({seq,text,at:1000+seq,speaker:seq%2?{kind:'bot',id:'null'}:{kind:'human'},originSeq:100+seq}));
    const snapshot={participants:[bot],options:{policy:'mention',max_bot_hops:3},transcript};
    const hit=(kind,title,snippet,ranges,at,target,extra={})=>({kind,title,snippet,ranges,at,project:'/Users/me/apex-deck',roomTitle:null,archived:false,trashed:false,target,...extra});
    const msg=(room,title,seq,text,at,speaker)=>hit('message',title,text,[[text.toLowerCase().indexOf('installer'),text.toLowerCase().indexOf('installer')+9]],at,{type:'message',room,roomKind:'work',seq,originSeq:100+seq,clientMessageId:null,speaker},{roomTitle:title});
    const now=Date.now();
    const all=[hit('thread','Installer QA','Installer QA',[[0,9]],now-3600e3,{type:'room',room:'qa',roomKind:'work'}),
      msg('handoff','Release handoff',5,dup,now-120e3,'Null'),msg('handoff','Release handoff',2,dup,now-7200e3,'You'),
      msg('qa','Installer QA',1,'Open the disk image and run the installer from there.',now-86400e3,'Null'),
      msg('qa','Installer QA',0,'Does the installer need admin rights?',now-90000e3,'You')];
    window.fixture={opened:[],calls:{local:[],vps:[]},asked:[],vpsUp:false};
    const ports={
      local:{supports:c=>c==='search_v1',call:async(cmd,args)=>{fixture.calls.local.push(cmd);if(cmd==='search_open')return{ttlMs:1};if(cmd==='search_cancel')return null;fixture.asked.push(args);
        const hits=all.filter(x=>args.kinds.includes(x.kind)&&x.snippet.toLowerCase().includes(args.query.toLowerCase()));
        return{hits,totals:{thread:{count:hits.filter(x=>x.kind==='thread').length,exact:true},message:{count:hits.filter(x=>x.kind==='message').length,exact:true}},skipped:[],tookMs:1};}},
      vps:{supports:c=>c==='search_v1',call:async cmd=>{fixture.calls.vps.push(cmd);if(!fixture.vpsUp)throw Error('Hetzner timed out');if(cmd==='search_open')return{ttlMs:1};return{hits:[],totals:{},skipped:[],tookMs:1};}},
    };
    const backend={...await getBackend(),roomCreate:async()=>snapshot,roomState:async()=>({recovery_seq:1,snapshot,active:[],approvals:[]}),roomClose:async()=>{},roomSteps:async()=>null,onRoomEvent:async()=>()=>{},onPtyData:async()=>()=>{},onPtyExit:async()=>()=>{},artifactsLoad:async()=>({version:1,artifacts:[]}),artifactsSave:async()=>{}};
    const memory=new Map();const storage={getItem:k=>memory.get(k)??null,setItem:(k,v)=>memory.set(k,v),removeItem:k=>memory.delete(k)};
    function Fixture(){
      const [reveal,setReveal]=useState(null);const [focus,setFocus]=useState(0);
      window.fixture.focusField=()=>setFocus(n=>n+1);
      return h('div',{className:'body',style:{display:'flex',height:'100vh'}},
        h('aside',{className:'rail',style:{width:240}},
          h(SearchDeck,{machines:[{id:'local',name:'MacBook Pro',offline:false},{id:'vps',name:'Hetzner',offline:false}],portOf:id=>ports[id],storage,focusRequest:focus,shortcut:'⌘P',
            settings:q=>q.toLowerCase().startsWith('install')?[{id:'auto-update',label:'Install updates automatically',section:'updates',sectionLabel:'Updates'}]:[],
            onOpen:(place,query)=>{fixture.opened.push(place);if(place.target.type==='message')setReveal({id:String(fixture.opened.length),target:place.target,query});}}),
          h('div',{className:'rail-scroll'},h('div',{className:'rail-sec'},'Projects'),h('button',{id:'elsewhere',type:'button'},'apex-deck'))),
        h('main',{style:{flex:1,minWidth:0}},h('section',{className:'pane',style:{height:'100%'}},h('header',{className:'pane-head'},h('div',{className:'pane-counts'})),
          h(ChatPane,{pane:{id:'handoff',workspaceId:'w',kind:'chat',title:'Release handoff'},cwd:'/tmp/project',agents:[],backend,focused:false,visible:true,reveal,onRevealed:(id,changed)=>{fixture.revealed={id,changed};},onActivity(){},profiles:[],onProfilesChange(){},disabledProviders:[]}))));
    }createRoot(document.getElementById('root')).render(h(Fixture));
  </script>`;
  const server = await createServer({ cacheDir: path.join(temp, 'vite-cache'), server: { port: 0 }, logLevel: 'error', plugins: [{ name: 'search-deck-test', configureServer(server) { server.middlewares.use('/__search_deck', async (_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(await server.transformIndexHtml('/__search_deck', html)); }); } }] });
  await server.listen();
  const main = path.join(temp, 'main.cjs');
  fs.writeFileSync(main, `
    const {app,BrowserWindow}=require('electron');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');
    const shots=${JSON.stringify(shots)};
    app.whenReady().then(async()=>{
      const win=new BrowserWindow({show:false,width:1440,height:900,webPreferences:{offscreen:true}});
      const run=code=>win.webContents.executeJavaScript(code);
      const wait=async code=>{for(let i=0;i<400;i++){if(await run(code))return;await new Promise(r=>setTimeout(r,25));}throw Error('Timed out: '+code);};
      const shot=async name=>{if(!shots)return;await new Promise(r=>setTimeout(r,150));fs.mkdirSync(shots,{recursive:true});fs.writeFileSync(path.join(shots,name+'.png'),(await win.webContents.capturePage()).toPNG());};
      const type=text=>run("(()=>{const f=document.getElementById('search-deck-field');f.focus();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(f,"+JSON.stringify(text)+");f.dispatchEvent(new Event('input',{bubbles:true}));})()");
      const key=name=>run("document.getElementById('search-deck-field').dispatchEvent(new KeyboardEvent('keydown',{key:"+JSON.stringify(name)+",bubbles:true,cancelable:true}))");
      const inField="document.activeElement===document.getElementById('search-deck-field')";
      const rows="[...document.querySelectorAll('.search-deck-row')]";
      const heads="[...document.querySelectorAll('.search-deck-panel section')].map(s=>s.getAttribute('aria-label')).join()";
      try{
        await win.loadURL('http://localhost:${server.httpServer.address().port}/__search_deck');
        await wait("document.querySelector('[data-seq=\\"13\\"]')");
        win.webContents.focus();
        await shot('1-field');

        // Nothing typed: the empty state, no machine asked.
        await run("(()=>{const f=document.getElementById('search-deck-field');f.focus();f.click();})()");
        await wait("document.querySelector('.search-deck-empty')");
        assert.deepEqual(await run('fixture.calls.local'),[]);

        await type('installer');
        await wait(rows+".length===5");
        assert.equal(await run(heads),'Threads,Messages,Settings');
        // Three message rows of four; the rest behind Show all.
        assert.equal(await run("document.querySelector('section[aria-label=Messages] .search-deck-link').textContent"),'Show all 4');
        // Every message row shows the matched word.
        assert.equal(await run("[...document.querySelectorAll('section[aria-label=Messages] .search-deck-row')].every(r=>r.querySelector('mark')?.textContent.toLowerCase()==='installer')"),true);
        // No type word in a row, and the machine is named because there are two.
        assert.match(await run(rows+"[1].querySelector('.search-deck-detail').textContent"),/^apex-deck · Release handoff · Null · MacBook Pro$/);
        // The first hit is preselected; the cursor is in the field.
        assert.equal(await run(rows+".findIndex(r=>r.classList.contains('active'))"),0);
        assert.equal(await run(inField),true);
        // The unreachable machine is named, with Retry.
        await wait("document.querySelector('.search-deck-status')?.textContent.includes('Hetzner is offline · not searched')");
        await shot('2-results');

        // Arrow keys move the highlight and never the cursor.
        await key('ArrowDown');await key('ArrowDown');
        await wait(rows+".findIndex(r=>r.classList.contains('active'))===2");
        assert.equal(await run(inField),true);
        assert.equal(await run("document.getElementById('search-deck-field').getAttribute('aria-activedescendant')"),'search-deck-row-2');
        await key('ArrowUp');await key('ArrowUp');await key('ArrowUp');
        await wait(rows+".findIndex(r=>r.classList.contains('active'))===4");
        await key('ArrowDown');await key('ArrowDown');await key('ArrowDown');

        // Retry asks only the machine that failed.
        const local=await run('fixture.calls.local.length');const vps=await run('fixture.calls.vps.length');
        await run("fixture.vpsUp=true;[...document.querySelectorAll('.search-deck-status .search-deck-link')].find(b=>b.textContent==='Retry').click()");
        await wait("!document.querySelector('.search-deck-status')");
        assert.equal(await run('fixture.calls.local.length'),local);
        assert.ok(await run('fixture.calls.vps.length')>vps);

        // Enter on the second duplicate opens the second duplicate: seq 2, not seq 5.
        await key('Enter');
        await wait("fixture.opened.length===1");
        assert.deepEqual(await run("(({type,room,seq})=>({type,room,seq}))(fixture.opened[0].target)"),{type:'message',room:'handoff',seq:2});
        assert.equal(await run("!!document.querySelector('.search-deck-panel')"),false);
        await wait("document.querySelector('[data-seq=\\"2\\"] .bubble').classList.contains('search-found')");
        assert.equal(await run("document.querySelectorAll('.search-found').length"),1);
        assert.deepEqual(await run('fixture.revealed'),{id:'1',changed:false});
        // It is scrolled into view, not just marked.
        await wait("(()=>{const r=document.querySelector('[data-seq=\\"2\\"]').getBoundingClientRect();return r.top>=56&&r.bottom<=innerHeight-150;})()");
        await shot('3-landed');

        // The shortcut focuses the field; Escape returns the cursor to where it was.
        await run("document.getElementById('elsewhere').focus();fixture.focusField()");
        await wait(inField);
        await wait("document.querySelector('.search-deck-panel')");
        await key('Escape');
        await wait("document.activeElement===document.getElementById('elsewhere')");
        assert.equal(await run("!!document.querySelector('.search-deck-panel')"),false);

        // A chip narrows what is asked and shown.
        await run("(()=>{const f=document.getElementById('search-deck-field');f.focus();f.click();})()");
        await wait("document.querySelector('.search-deck-panel')");
        await run("[...document.querySelectorAll('.search-deck-chips button')].find(b=>b.textContent==='Messages').click()");
        await wait(heads+"==='Messages'");
        assert.deepEqual(await run('fixture.asked.at(-1).kinds'),['message']);
        await run("document.querySelector('section[aria-label=Messages] .search-deck-link').click()");
        await wait(rows+".length===4");
        await run("[...document.querySelectorAll('.search-deck-chips button')].find(b=>b.textContent==='Settings').click()");
        await wait(heads+"==='Settings'");

        // No match says so, in the plan's words.
        await type('zzzz');
        await wait("document.querySelector('.search-deck-empty')?.textContent.includes('No matches for')");
        await shot('4-empty');

        // Recent searches and places come back on an empty field.
        await type('');
        await wait("document.querySelector('.search-deck-words button')?.textContent==='installer'");
        assert.equal(await run(rows+"[0].querySelector('.search-deck-title').textContent"),'Release handoff');
        await shot('5-recents');
        app.exit(0);
      }catch(error){console.error(error);try{console.error('PANEL: '+await run("(document.querySelector('.search-deck-panel')?.innerText??'no panel')+' | value='+document.getElementById('search-deck-field')?.value+' | calls='+JSON.stringify(fixture.calls)"));await shot('failed');}catch{}app.exit(1);}
    });`);
  try {
    const result = await runElectronScenario(electron, main, temp, { timeoutMs: 90000 });
    assert.equal(result.code, 0, result.output);
  } finally { await server.close(); fs.rmSync(temp, { recursive: true, force: true }); }
});
