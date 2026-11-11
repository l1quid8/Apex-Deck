import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import electron from 'electron';
import { createServer } from 'vite';
import { runElectronScenario } from './helpers/electron-test.mjs';
import * as agentEdit from '../src/phone/agentEdit.ts';

test('draft agents keep explicit picks and never replace an empty or deleted selection with the default', () => {
  assert.equal(typeof agentEdit.draftAgents, 'function', 'draft roster resolver exists');
  const profiles = [{id:'null'}, {id:'jigga'}];
  assert.deepEqual(agentEdit.draftAgents(profiles), [profiles[0]]);
  assert.deepEqual(agentEdit.draftAgents(profiles, ['jigga','null']), [profiles[1],profiles[0]]);
  assert.deepEqual(agentEdit.draftAgents(profiles, []), []);
  assert.deepEqual(agentEdit.draftAgents(profiles, ['deleted']), []);
  assert.deepEqual(agentEdit.draftAgents(profiles, ['jigga','jigga']), [profiles[1]]);
});

// Exercise PhoneApp's draft creation branch with a stand-in host, through the same room-open and
// session-save boundary as the first Send. No model is started by this fixture.
test('the first Send creates the room with the chosen agents and an empty selection creates nothing', async () => {
  const { transform } = createRequire(import.meta.url)('sucrase');
  const source = fs.readFileSync(new URL('../src/phone/PhoneApp.tsx', import.meta.url), 'utf8');
  const start = source.indexOf('      if (viewingPending && pending) {', source.indexOf('  async function send()'));
  const end = source.indexOf('      } else if (pane && room?.id !== pane.id)', start);
  assert.ok(start >= 0 && end > start);
  const code = transform(source.slice(start, end) + '\n}', { transforms: ['typescript'] }).code;
  const create = new Function('env', `with(env){return (async()=>{${code}})()}`);
  for (const picked of [['jigga'], ['jigga', 'null'], []]) {
    const profiles = [{id:'null'}, {id:'jigga'}];
    const opened = [];
    const env = {
      viewingPending:true, pending:{id:'draft',workspaceId:'ws',agents:picked},
      pendingAgents:agentEdit.draftAgents(profiles,picked), pendingRoomIds:{current:{}},
      pane:null, participants:[], transcriptLength:0, host:{backend:{},machine:{id:'mac'}},
      NEW_THREAD:{}, openPath:'/project', pendingDraftPlans:{}, movedRef:{current:{}},
      draft:{text:'hello',files:[]}, saved:{panes:[]}, drafts:{draft:{text:'hello',files:[]}},
      async loadRoomState(_backend,id,agents) { opened.push(agents); return {snapshot:{participants:agents,transcript:[]}}; },
      async setPlanBeforeContinuation(_id,_enabled,_set,save) { await save(); },
      async saveSession(update) { env.saved=update(env.saved); },
      toPerson:config=>config, threadKey:(pane,host)=>`${host}:${pane.id}`,
      setDrafts:update=>{env.drafts=update(env.drafts);}, tldrOf:()=>false,
      setPending:value=>{env.nextPending=value;}, setPendingDraftPlans:()=>{},
      setOpenHost:()=>{}, setOpenId:id=>{env.openId=id;},
      setNotice:text=>{env.notice=text;}, setMenu:value=>{env.menu=value;},
    };
    await create(env);
    assert.deepEqual(opened.map(agents=>agents.map(agent=>agent.id)), picked.length ? [picked] : []);
    if (picked.length) {
      assert.equal(env.saved.panes.length,1);
      assert.equal(env.nextPending,null);
      assert.equal(env.drafts[`mac:${env.openId}`].text,'hello');
      assert.equal(env.drafts.draft,undefined);
    } else {
      assert.equal(env.saved.panes.length,0);
      assert.equal(env.pending.id,'draft');
      assert.equal(env.menu.kind,'draft-bots');
    }
  }
});

test('a new Work thread can open agent selection before its first message, including with no agents', { timeout: 120000 }, async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'phone-draft-agents-'));
  const html = `<div id="root"></div><script type="module">
    import React from 'react';
    import {createRoot} from 'react-dom/client';
    import {ThreadView} from '/src/phone/PhoneApp.tsx';
    window.opens = 0;
    window.render = participants => createRoot(document.getElementById('root')).render(React.createElement(ThreadView, {
      paneId:'draft', link:{id:'mac',status:'online'}, messages:[], draft:{text:'hello',files:[]},
      title:'New thread', project:'Project', machine:'Mac', path:'', kind:'mac', started:false, draftThread:true,
      callSlot:{live:false,look:'pill',hint:''}, participants, crewShut:false,
      working:{}, cut:{}, approvals:[], meters:{}, pins:[], quotes:[], queued:[],
      gate:{enabled:true,reason:''}, endRef:{current:null}, runner:null,
      swipe:{next:null,previous:null,position:''}, onSwipe(){},
      steps:null, pictures:{read:async()=>new ArrayBuffer(0),blocked:null},
      onDraft(){}, onResized(){}, onScrolled(){}, places:new Map(), onBots(){window.opens++;}
    }));
    window.render([]);
  </script>`;
  const server = await createServer({ cacheDir:path.join(temp,'cache'), server:{port:0}, logLevel:'error', plugins:[{
    name:'phone-draft-agents-fixture', enforce:'pre',
    transform(code,id) { if(id.endsWith('/src/phone/PhoneApp.tsx')) return code+'\nexport {ThreadView};'; },
    configureServer(s) { s.middlewares.use('/__draft_agents', async (_req,res) => {
      res.setHeader('Content-Type','text/html'); res.end(await s.transformIndexHtml('/__draft_agents',html));
    }); }
  }] });
  try {
    await server.listen();
    const main = path.join(temp,'main.cjs');
    fs.writeFileSync(main, `
      const {app,BrowserWindow}=require('electron'); const assert=require('node:assert/strict');
      app.whenReady().then(async()=>{try {
        const win=new BrowserWindow({show:false,width:393,height:852,webPreferences:{offscreen:true}});
        const run=code=>win.webContents.executeJavaScript(code);
        await win.loadURL('http://localhost:${server.httpServer.address().port}/__draft_agents');
        for(let i=0;i<400;i++){if(await run('!!document.querySelector("textarea")'))break;await new Promise(r=>setTimeout(r,25));}
        assert.equal(await run('!!document.querySelector(".ph-crew-add")'),true,'draft has an agent picker before any room exists');
        assert.equal(await run('document.querySelector(".ph-crew-add").closest("[inert]") === null'),true,'draft picker is usable');
        await run('document.querySelector(".ph-crew-add").click()');
        assert.equal(await run('window.opens'),1,'tap opens agent selection');
        win.destroy(); app.exit(0);
      }catch(error){console.error(error.stack);app.exit(1);}});
    `);
    const result = await runElectronScenario(electron,main,temp,{attempts:1});
    assert.equal(result.code,0,result.output);
  } finally { await server.close(); fs.rmSync(temp,{recursive:true,force:true}); }
});
