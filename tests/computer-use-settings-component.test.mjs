import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import electron from 'electron';
import { createServer } from 'vite';
import { runElectronScenario } from './helpers/electron-test.mjs';

// The real settings page against a stand-in host. The host is the only
// authority: every state the page shows comes from a status the host returned.
test('App permissions is one Mac-wide choice that waits for the host, and there is no Stop or Resume', { timeout: 180000 }, async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'computer-use-settings-'));
  const html = `<html><body><div id="root"></div><script type="module">
    import React from 'react'; import {createRoot} from 'react-dom/client';
    import {ComputerUseSettings} from '/src/ComputerUseSettings.tsx';
    const ASK_NOT_SAVED="Ask for each app is on now but couldn't be saved; it may switch back to Skip prompts after a restart.";
    const OFF_NOT_SAVED="Unified Computer Use is off now but that couldn't be saved; it may switch back on after a restart.";
    const f=window.fixture={available:true,enabled:true,skip:false,reason:undefined,calls:[],fail:'none',hold:false,
      status(){return {available:this.available,enabled:this.enabled,skipAppPrompts:this.skip,appPromptsWarning:this.warning,reason:this.reason,accessibilityTrusted:true,listenEventAccess:true,screenCaptureAccess:true};}};
    const backend={demo:false,async call(cmd,args){
      if(cmd==='computer_status')return f.status();
      f.calls.push([cmd,args]);
      if(f.hold)await new Promise(resolve=>f.release=resolve);
      if(cmd==='computer_set_app_prompts'){
        if(f.fail==='refuse')throw Error('Could not save Unified Computer Use settings: disk full.');
        if(f.fail==='askNotSaved'&&!args.skip){f.skip=false;f.warning=ASK_NOT_SAVED;throw Error(ASK_NOT_SAVED+' Could not save Unified Computer Use settings: disk full.');}
        f.skip=args.skip;f.warning=null;
      }
      if(cmd==='computer_set_enabled'){
        if(f.fail==='offNotSaved'&&!args.enabled){f.enabled=false;throw Error(OFF_NOT_SAVED+' Could not save Unified Computer Use settings: disk full.');}
        f.enabled=args.enabled;
      }
      return f.status();}};
    let root;
    window.openSettings=()=>{root=createRoot(document.getElementById('root'));root.render(React.createElement(ComputerUseSettings,{backend}));};
    window.closeSettings=()=>root.unmount();
    window.openSettings();
    window.ready=true;
  </script></body></html>`;
  const server = await createServer({ cacheDir: path.join(temp, 'vite-cache'), server: { host: '127.0.0.1', port: 0 }, logLevel: 'error', plugins: [{ name: 'computer-use-settings-test', configureServer(server) { server.middlewares.use('/__computer_use_test', async (_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(await server.transformIndexHtml('/__computer_use_test', html)); }); } }] });
  await server.listen();
  const url = `http://127.0.0.1:${server.httpServer.address().port}/__computer_use_test`;
  const main = path.join(temp, 'main.cjs');
  fs.writeFileSync(main, `const {app,BrowserWindow}=require('electron');const assert=require('node:assert/strict');
    app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,webPreferences:{nodeIntegration:false,contextIsolation:true,backgroundThrottling:false}});
      win.webContents.on('console-message',(_event,_level,message)=>console.log(message));
      const run=(fn,arg)=>win.webContents.executeJavaScript('('+fn.toString()+')('+JSON.stringify(arg??null)+')');
      const wait=async(fn,label)=>{for(let i=0;i<200;i++){if(await run(fn))return;await new Promise(r=>setTimeout(r,30));}throw Error('Timed out: '+label+'\\n'+await run(()=>document.body.innerText));};
      // What the page shows: which choice is pressed, whether the choices are locked, and the open confirmation.
      const view=()=>run(()=>{
        const group=document.querySelector('[role=group][aria-label="App permissions"]');
        const buttons=[...(group?.querySelectorAll('button')??[])];
        const confirm=document.querySelector('[role=group][aria-label="Confirm skipping app prompts"]');
        return {labels:buttons.map(b=>b.textContent.trim()),pressed:buttons.filter(b=>b.getAttribute('aria-pressed')==='true').map(b=>b.textContent.trim()),
          disabled:buttons.map(b=>b.disabled),confirm:confirm?confirm.innerText:null,
          confirmButtons:confirm?[...confirm.querySelectorAll('button')].map(b=>b.textContent.trim()):[],
          alerts:[...document.querySelectorAll('[role=alert]')].map(a=>a.textContent),
          allButtons:[...document.querySelectorAll('button')].map(b=>b.textContent.trim()),
          strongs:[...document.querySelectorAll('.settings-label strong')].map(s=>s.textContent.trim()),
          enable:document.querySelector('input[aria-label="Enable Unified Computer Use"]')?.closest('.settings-row')?.innerText??'',
          text:document.body.innerText};});
      const press=(scope,name)=>run(([scope,name])=>{const group=document.querySelector('[role=group][aria-label="'+scope+'"]');const button=[...group.querySelectorAll('button')].find(b=>b.textContent.trim()===name);if(!button)throw Error('No button '+name+' in '+scope);button.click();},[scope,name]);
      const refocus=()=>run(()=>{window.dispatchEvent(new Event('focus'));});
      const ASK='Ask for each app',SKIP='Skip prompts for Full-access agents';
      try{await win.loadURL(${JSON.stringify(url)});
        await wait(()=>window.ready&&document.querySelector('[role=group][aria-label="App permissions"] button[aria-pressed=true]'),'page load');
        let v=await view();
        assert.deepEqual(v.labels,[ASK,SKIP]);assert.deepEqual(v.pressed,[ASK],'everyone starts on Ask for each app');
        assert.equal(v.strongs[0],'Enable Unified Computer Use');assert.equal(v.strongs[1],'App permissions','the row sits directly under Enable');
        assert.ok(!v.strongs.includes('Status'),'the Status row is gone');assert.ok(!v.strongs.some(s=>/^Stop/.test(s)),'no Stop row');
        assert.ok(!v.allButtons.some(b=>b==='Stop'||b==='Resume'),'no Stop or Resume button: '+v.allButtons.join(', '));
        assert.doesNotMatch(v.text,/Stopped|Resume|[Uu]ntether/);
        assert.doesNotMatch(v.enable,/skip app prompts/);

        // Choosing Skip only opens the confirmation. Cancel changes nothing.
        await press('App permissions',SKIP);await wait(()=>document.querySelector('[role=group][aria-label="Confirm skipping app prompts"]'),'confirmation opens');
        v=await view();
        assert.match(v.confirm,/Skip app prompts for all Full-access agents on this Mac\\?/);
        assert.match(v.confirm,/[Pp]rotected apps/);assert.match(v.confirm,/password fields/);
        assert.match(v.confirm,/[Ss]topping an agent.s output stops its computer use/);assert.match(v.confirm,/model provider/);
        assert.deepEqual(v.confirmButtons,['Cancel','Skip prompts']);
        assert.deepEqual(v.pressed,[ASK],'Ask stays selected while the confirmation is open');
        assert.deepEqual(await run(()=>window.fixture.calls),[],'nothing is sent before confirming');
        await press('Confirm skipping app prompts','Cancel');await wait(()=>!document.querySelector('[role=group][aria-label="Confirm skipping app prompts"]'),'cancel closes');
        assert.deepEqual((await view()).pressed,[ASK]);assert.deepEqual(await run(()=>window.fixture.calls),[]);

        // Confirming sends it; Ask stays selected until the host answers.
        await run(()=>{window.fixture.hold=true;});
        await press('App permissions',SKIP);await wait(()=>document.querySelector('[role=group][aria-label="Confirm skipping app prompts"]'),'confirmation reopens');
        await press('Confirm skipping app prompts','Skip prompts');
        await wait(()=>window.fixture.calls.length===1&&document.querySelector('[role=group][aria-label="App permissions"] button').disabled,'the change is with the host');
        v=await view();assert.deepEqual(v.pressed,[ASK],'still Ask until the Mac confirms');assert.equal(v.confirm,null);
        await run(()=>{window.fixture.hold=false;window.fixture.release();});
        await wait(()=>document.querySelector('[role=group][aria-label="App permissions"] button[aria-pressed=true]')?.textContent.trim()==='Skip prompts for Full-access agents','host confirmed Skip');
        v=await view();assert.match(v.enable,/Full-access agents skip app prompts\\./,'the On switch says prompts are skipped');
        assert.deepEqual(await run(()=>window.fixture.calls),[['computer_set_app_prompts',{skip:true}]]);

        // Ask is sent at once, with no confirmation.
        await press('App permissions',ASK);
        await wait(()=>document.querySelector('[role=group][aria-label="App permissions"] button[aria-pressed=true]')?.textContent.trim()==='Ask for each app','host confirmed Ask');
        v=await view();assert.equal(v.confirm,null);assert.doesNotMatch(v.enable,/skip app prompts/);
        assert.deepEqual((await run(()=>window.fixture.calls))[1],['computer_set_app_prompts',{skip:false}]);

        // A refused Skip leaves Ask selected and shows the error.
        await run(()=>{window.fixture.fail='refuse';});
        await press('App permissions',SKIP);await wait(()=>document.querySelector('[role=group][aria-label="Confirm skipping app prompts"]'),'confirmation for the refused change');
        await press('Confirm skipping app prompts','Skip prompts');
        await wait(()=>[...document.querySelectorAll('[role=alert]')].some(a=>a.textContent.includes('disk full')),'the refusal is shown');
        v=await view();assert.deepEqual(v.pressed,[ASK],'a failed change leaves Ask selected');assert.equal(v.disabled[0],false,'and the choices work again');

        // Ask took effect on the Mac but could not be saved: the page shows
        // what the Mac is doing now (Ask) and warns it may not survive a restart.
        await run(()=>{window.fixture.fail='none';window.fixture.skip=true;});await refocus();
        await wait(()=>document.querySelector('[role=group][aria-label="App permissions"] button[aria-pressed=true]')?.textContent.trim()==='Skip prompts for Full-access agents','Skip saved before the failure');
        await run(()=>{window.fixture.fail='askNotSaved';});
        await press('App permissions',ASK);
        await wait(()=>[...document.querySelectorAll('[role=alert]')].some(a=>a.textContent.includes('may switch back to Skip prompts after a restart')),'the restart warning is shown');
        await wait(()=>document.querySelector('[role=group][aria-label="App permissions"] button[aria-pressed=true]')?.textContent.trim()==='Ask for each app','Ask is selected from the host');
        v=await view();assert.deepEqual(v.pressed,[ASK]);
        assert.ok(v.alerts.some(a=>a.includes("Ask for each app is on now but couldn't be saved; it may switch back to Skip prompts after a restart.")),v.alerts.join(' | '));
        // Destroy all component state and reopen against the same running host.
        await run(()=>window.closeSettings());
        assert.equal(await run(()=>document.getElementById('root').childElementCount),0);
        await run(()=>window.openSettings());
        await wait(()=>document.querySelector('[role=alert]')?.textContent.includes('after a restart'),'warning after reopening Settings');
        v=await view();assert.deepEqual(v.pressed,[ASK]);assert.ok(v.alerts.some(a=>a.includes('may switch back to Skip prompts after a restart')),'the warning stays after a refresh');

        // An open confirmation never outlives the choice being locked: it must
        // not come back on its own when Unified Computer Use is switched on again.
        await run(()=>{window.fixture.fail='none';window.fixture.enabled=true;window.fixture.skip=false;});await refocus();
        await wait(()=>document.querySelector('[role=group][aria-label="App permissions"] button[aria-pressed=true]')?.textContent.trim()==='Ask for each app'&&!document.querySelector('[role=group][aria-label="App permissions"] button').disabled,'back on Ask');
        await press('App permissions',SKIP);await wait(()=>document.querySelector('[role=group][aria-label="Confirm skipping app prompts"]'),'confirmation before the lock');
        await run(()=>{window.fixture.enabled=false;});await refocus();
        await wait(()=>document.querySelector('[role=group][aria-label="App permissions"] button').disabled&&!document.querySelector('[role=group][aria-label="Confirm skipping app prompts"]'),'locking closes the confirmation');
        await run(()=>{window.fixture.enabled=true;});await refocus();
        await wait(()=>!document.querySelector('[role=group][aria-label="App permissions"] button').disabled,'unlocked again');
        await new Promise(r=>setTimeout(r,150));
        assert.equal((await view()).confirm,null,'the confirmation does not reopen without a click');
        assert.equal((await run(()=>window.fixture.calls)).filter(c=>c[0]==='computer_set_app_prompts'&&c[1].skip).length,2,'and nothing was sent');

        // Off took effect on the Mac but could not be saved: the switch shows
        // Off (what the Mac is doing) with the restart warning.
        await run(()=>{window.fixture.fail='offNotSaved';});
        await run(()=>{document.querySelector('input[aria-label="Enable Unified Computer Use"]').click();});
        await wait(()=>[...document.querySelectorAll('[role=alert]')].some(a=>a.textContent.includes('may switch back on after a restart')),'the Off restart warning is shown');
        await wait(()=>document.querySelector('input[aria-label="Enable Unified Computer Use"]').checked===false,'the switch shows Off from the host');

        // The helper is installed but not answering: the host's reason is shown under Enable.
        await run(()=>{window.fixture.fail='none';window.fixture.enabled=true;window.fixture.reason='Open Unified Computer Use to check permissions.';});await refocus();
        await wait(()=>document.querySelector('input[aria-label="Enable Unified Computer Use"]')?.closest('.settings-row')?.innerText.includes('Open Unified Computer Use to check permissions.'),'the helper reason is under Enable');
        await run(()=>{window.fixture.reason=undefined;});

        // Off: the choice is locked but still shows what is saved.
        await run(()=>{window.fixture.fail='none';window.fixture.enabled=false;window.fixture.skip=true;});await refocus();
        await wait(()=>{const b=[...document.querySelectorAll('[role=group][aria-label="App permissions"] button')];return b.length===2&&b.every(x=>x.disabled)&&b[1].getAttribute('aria-pressed')==='true';},'Off locks the choice and keeps showing Skip');

        // No helper on this host: the reason sits under Enable.
        await run(()=>{window.fixture.available=false;window.fixture.reason='Unified Computer Use is available in the installed macOS app.';});await refocus();
        await wait(()=>document.querySelector('input[aria-label="Enable Unified Computer Use"]')?.closest('.settings-row')?.innerText.includes('available in the installed macOS app'),'the unavailable reason is under Enable');
        console.log('COMPUTER_USE_SETTINGS_OK');win.destroy();app.exit(0);
      }catch(e){console.error(e.stack);win.destroy();app.exit(1);}});
  `);
  try { const result = await runElectronScenario(electron, main, temp, { timeoutMs: 60000 }); assert.equal(result.code, 0, result.output); assert.match(result.output, /COMPUTER_USE_SETTINGS_OK/); }
  finally { await server.close(); fs.rmSync(temp, { recursive: true, force: true }); }
});
