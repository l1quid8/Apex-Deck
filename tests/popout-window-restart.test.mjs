import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import electron from 'electron';
import { runElectronScenario } from './helpers/electron-test.mjs';

test('native external windows reopen after process exit with fresh snapshots and saved placement', { timeout: 60000 }, async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-window-restart-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const desktop = fileURLToPath(new URL('../desktop/', import.meta.url));
  const source = fs.readFileSync(path.join(desktop, 'main.mjs'), 'utf8');
  const production = source.slice(source.indexOf('const popoutWindows = new Map();'), source.indexOf('\n/**\n * Whether no Tauri'));
  assert.ok(production.includes("handle('popout:restore'"));
  const blank = path.join(temp, 'blank.html');
  fs.writeFileSync(blank, '<p>External window fixture</p>');
  for (const phase of ['save', 'restore']) {
    const main = path.join(temp, `${phase}.cjs`);
    fs.writeFileSync(main, `
      const {app,BrowserWindow,screen,dialog,ipcMain}=require('electron');
      const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
      const assert=require('node:assert/strict'),{runInNewContext}=require('node:vm');
      app.setPath('userData',${JSON.stringify(path.join(temp, 'saved-profile'))});
      ipcMain.on('apex:tauriStorage', event => { event.returnValue = null; });
      ipcMain.on('apex:smoke', event => { event.returnValue = true; });
      app.whenReady().then(async()=>{try {
        const {PopoutLayoutStore,fitPopoutBounds,trackPopoutWindow}=await import(${JSON.stringify(pathToFileURL(path.join(desktop, 'popoutLayout.mjs')).href)});
        const {assistantFloatBounds,movedAssistantFloatBounds}=await import(${JSON.stringify(pathToFileURL(path.join(desktop, 'assistantFloatLayout.mjs')).href)});
        const {dockedBrowser}=await import(${JSON.stringify(pathToFileURL(path.join(desktop, 'browser.mjs')).href)});
        const gate={confirmed:false},callbacks=new Map();
        const owner={win:new BrowserWindow({show:false}),role:'deck'};
        const windows=new Map([[owner.win.id,owner]]);
        const api=runInNewContext(${JSON.stringify(production + '\n({windows:popoutWindows,snapshots:popoutSnapshots,store:popoutLayout});')},{
          app,BrowserWindow,screen,dialog,fs,path,crypto,process,dockedBrowser,sites:()=>({}),gate,windows,
          PopoutLayoutStore,fitPopoutBounds,trackPopoutWindow,assistantFloatBounds,movedAssistantFloatBounds,
          here:${JSON.stringify(desktop)},smoke:true,devUrl:${JSON.stringify(pathToFileURL(blank).href)},
          UI_ORIGINS:new Set(['file://']),originOf:()=> 'file://',openExternally:()=>{},
          handle:(channel,fn)=>callbacks.set(channel,fn),
        });
        const phase=${JSON.stringify(phase)};
        const available={panes:['thread'],tabs:['files']};
        const expected=path.join(app.getPath('userData'),'expected.json');
        const wait=async fn=>{for(let i=0;i<150;i++){if(fn())return;await new Promise(r=>setTimeout(r,20));}throw Error('native placement did not settle');};
        const open=async(kind,id,title)=>{
          const {token}=await callbacks.get('popout:open')(owner,{kind,id,title,chatConfig:{workspaceName:title}});
          const entry=[...api.windows.values()].find(e=>e.token===token);
          await new Promise(resolve=>entry.win.webContents.isLoading()?entry.win.webContents.once('did-finish-load',resolve):resolve());
          return entry;
        };
        if(phase==='save'){
          assert.deepEqual(JSON.parse(JSON.stringify(await callbacks.get('popout:restore')(owner,available))),[]);
          const thread=await open('pane','thread','Original title');
          const files=await open('tab','files','Files');
          // The renderer tracks one assistant float. Switching assistants must
          // close the former view, never leave an untracked window taking sends.
          const first=await open('assistant','assistant-a','Assistant A');
          const again=await callbacks.get('popout:open')(owner,{kind:'assistant',id:'assistant-a',title:'Assistant A'});
          assert.equal(again.token,first.token,'same assistant reuses its live view');
          const second=await open('assistant','assistant-b','Assistant B');
          assert.ok(first.win.isDestroyed(),'opening B closes A before its handle is replaced');
          assert.equal([...api.windows.values()].filter(e=>e.floatId).length,1,'only the tracked assistant view survives');
          assert.ok(!thread.win.isDestroyed() && !files.win.isDestroyed(),'ordinary pop-outs stay open');
          assert.ok(!api.snapshots.has(first.token),'old assistant snapshot is removed');
          const before=second.win.getBounds();
          await callbacks.get('popout:assistant-layout')(owner,second.token,'minimized');
          assert.equal(second.win.getBounds().width,76,'native avatar-only window is genuinely compact');
          assert.equal(second.win.getBounds().height,76);
          await wait(()=>api.store.get('assistant','assistant-b')?.bounds.width===76);
          assert.equal(api.store.get('assistant','assistant-b').bounds.width,76,'compact placement is saved without re-inflating it');
          const stranger={win:new BrowserWindow({show:false}),role:'deck'};
          const compact=second.win.getBounds();
          await callbacks.get('popout:assistant-layout')(stranger,second.token,'chat');
          assert.deepEqual(second.win.getBounds(),compact,'another owner cannot resize this assistant');
          await assert.rejects(()=>callbacks.get('popout:snapshot')(stranger,second.token));
          await callbacks.get('popout:assistant-move')(owner,second.token,{dx:90000,dy:0});
          assert.deepEqual(second.win.getBounds(),compact,'unbounded renderer movement is rejected');
          await callbacks.get('popout:assistant-layout')(owner,second.token,'pill');
          assert.equal(second.win.getBounds().x+second.win.getBounds().width,before.x+before.width,'one shared right anchor');
          await callbacks.get('popout:assistant-visibility')(owner,second.token,false);
          assert.equal(second.win.isVisible(),false);
          assert.ok(api.windows.has(second.win.id)&&api.snapshots.has(second.token),'Hide retains the live owner/token instead of closing the lane');
          await callbacks.get('popout:assistant-visibility')(owner,second.token,true);
          assert.equal(second.win.isVisible(),true);
          stranger.win.destroy();
          await callbacks.get('popout:close')(owner,second.token);
          // Placement remains saved for reopening an assistant, independently
          // of the ordinary pane/tab restart fixture below.
          api.store.remove('assistant','assistant-a');
          api.store.remove('assistant','assistant-b');
          const a=screen.getPrimaryDisplay().workArea;
          thread.win.setBounds({x:a.x+40,y:a.y+50,width:600,height:400});
          files.win.setBounds({x:a.x+100,y:a.y+120,width:650,height:430});
          await wait(()=>JSON.stringify(api.store.get('pane','thread').bounds)===JSON.stringify(thread.win.getNormalBounds()) && JSON.stringify(api.store.get('tab','files').bounds)===JSON.stringify(files.win.getNormalBounds()));
          files.win.maximize();
          await wait(()=>files.win.isMaximized() && api.store.get('tab','files').maximized);
          fs.writeFileSync(expected,JSON.stringify(api.store.list()));
          // This is the app.exit path: no orderly window-close event is needed.
          gate.confirmed=true;
          app.exit(0);
        }else{
          const wanted=fs.readFileSync(expected,'utf8');
          assert.equal(JSON.stringify(api.store.list()),wanted,'a new Electron process reads the saved layout');
          const restore=await callbacks.get('popout:restore')(owner,available);
          assert.deepEqual(JSON.parse(JSON.stringify(restore)),[{kind:'pane',id:'thread'},{kind:'tab',id:'files'}]);
          assert.deepEqual(JSON.parse(JSON.stringify(await callbacks.get('popout:restore')(owner,available))),[],'restoration is claimed once');
          const thread=await open('pane','thread','Current title');
          const files=await open('tab','files','Files');
          await wait(()=>files.win.isMaximized());
          for(const entry of [thread,files]){
            const snapshot=api.snapshots.get(entry.token);
            const saved=JSON.parse(wanted).find(r=>r.id===snapshot.id);
            assert.deepEqual(entry.win.getNormalBounds(),saved.bounds);
          }
          assert.equal(api.snapshots.get(thread.token).title,'Current title','snapshot rebuilt from current state');
          await callbacks.get('popout:close')(owner,thread.token);
          await wait(()=>!api.store.get('pane','thread'));
          assert.equal(api.store.list().length,1,'Return to Deck clears only that window');
          gate.confirmed=true;
          app.exit(0);
        }
      } catch(error){console.error(error);app.exit(1);}});
    `);
    const result = await runElectronScenario(electron, main, path.join(temp, phase), { timeoutMs: 25000, attempts: 1 });
    assert.equal(result.code, 0, `${phase}: ${result.output}`);
  }
});
