// Packaged gate runner. Loaded only by a temporary, instrumented app entry;
// the production main entry never imports this module or grants test capability.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow, powerMonitor, webContents } from 'electron';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function runSmoke(win, { generatedUIManager, sidecar } = {}) {
  const data = process.env.APEX_DECK_DATA_DIR;
  const output = process.env.APEX_GENERATED_OUTPUT;
  const phase = process.env.APEX_GENERATED_PHASE || 'lifecycle';
  fs.mkdirSync(output, { recursive: true });
  const evidence = { packaged: app.isPackaged, versions: { electron: process.versions.electron, chromium: process.versions.chrome }, phase, checks: [], processes: [], passed: false };
  const page = code => win.webContents.executeJavaScript(`(async()=>{${code}})()`, true);
  const until = async (name, check, timeout = 15000) => {
    const deadline = Date.now() + timeout;
    let last;
    while (Date.now() < deadline) {
      try { const result = await check(); if (result) return result; } catch (error) { last = error.message; }
      await delay(50);
    }
    throw Error(`Timed out: ${name}${last ? `: ${last}` : ''}`);
  };
  const step = async (name, check) => { await check(); evidence.checks.push({ name, passed: true }); console.log(`generated lifecycle: PASS ${name}`); };
  const windows = () => BrowserWindow.getAllWindows().filter(window => !window.isDestroyed());
  const generated = () => webContents.getAllWebContents().filter(contents => !contents.isDestroyed() && contents.getURL().startsWith('https://generated-ui.invalid/'));
  const gone = async () => {
    await until('generated contents disposed', () => generated().length === 0, 10000);
    for (const record of evidence.processes.filter(record => !record.checked)) {
      await until(`generated PID ${record.pid} exited`, () => { try { process.kill(record.pid, 0); return false; } catch (error) { return error.code === 'ESRCH'; } }, 10000);
      record.checked = true;
    }
    assert.equal(win.webContents.getOSProcessId(), evidence.chatPid);
    assert.equal(await page('return Boolean(__deck.backend && document.querySelector(".composer textarea"));'), true);
    await page('await __deck.backend.roomState("generated-smoke"); return true;');
  };
  // Deck refuses sends until the host is fully connected again, as after a reload's resync.
  const ready = () => until('real Deck connected', () => page('return Boolean(window.__deck && !document.querySelector(".loading") && __deck.backend.host?.connection.get().status.kind==="connected");'));
  // One listener per page: a second subscription would record every event twice.
  const installObserver = () => page('window.__generatedOff?.(); window.__generatedEvents=[]; window.__generatedOff=window.apexDeck.generatedUI.onEvent(event=>__generatedEvents.push(event)); return true;');
  const button = text => page(`const card=[...document.querySelectorAll('.generated-answer')].at(-1); const b=[...card.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)}); if(!b||b.disabled)throw Error('Unavailable ${text}');b.click();return true;`);
  const bringIntoView = async () => {
    await page('document.querySelectorAll(".generated-slot").item(document.querySelectorAll(".generated-slot").length-1)?.scrollIntoView({block:"center"});return true;');
    await delay(200);
  };
  const start = async () => {
    app.focus({steal:true});win.show();win.focus();
    await until('owner visible and focused',()=>page('return document.visibilityState==="visible" && document.hasFocus();'));
    await bringIntoView();
    evidence.lastStartGeometry=await page('const s=[...document.querySelectorAll(".generated-slot")].at(-1),r=s.getBoundingClientRect();return {rect:r.toJSON(),window:{w:innerWidth,h:innerHeight},visibility:document.visibilityState,ancestors:[...(()=>{let a=[],p=s.parentElement;while(p){a.push(p);p=p.parentElement}return a})()].map(e=>({class:e.className,rect:e.getBoundingClientRect().toJSON(),overflow:getComputedStyle(e).overflow})),overlays:[...document.querySelectorAll("[data-apex-agent-overlay],[role=dialog],[role=menu]")].filter(e=>e.getClientRects().length).map(e=>({class:e.className,rect:e.getBoundingClientRect().toJSON(),visibility:getComputedStyle(e).visibility})),points:[[r.left+2,r.top+2],[r.right-2,r.top+2],[r.left+2,r.bottom-2],[r.right-2,r.bottom-2],[r.left+r.width/2,r.top+r.height/2]].map(([x,y])=>({x,y,class:document.elementFromPoint(x,y)?.className,inside:s.contains(document.elementFromPoint(x,y))}))};');
    await page('window.__trace=[];window.__geometryTraceOff?.();const trace=e=>{const s=[...document.querySelectorAll(".generated-slot")].at(-1),r=s?.getBoundingClientRect();__trace.push({type:e.type,target:e.target?.className,scrollTop:e.target?.scrollTop,rect:r?.toJSON(),at:performance.now()});};for(const t of ["scroll","resize","visibilitychange"])document.addEventListener(t,trace,true);window.__geometryTraceOff=()=>{for(const t of ["scroll","resize","visibilitychange"])document.removeEventListener(t,trace,true)};return true;');
    await button('Run this interface');
    const host = await until('generated host ready', async () => {
      const contents = generated().at(-1);
      const runId = contents?.getURL().split('/').at(-1);
      return contents && await page(`return __generatedEvents.some(e=>e.runId===${JSON.stringify(runId)}&&e.type==="ready");`) ? contents : null;
    });
    const frames = host.mainFrame.framesInSubtree;
    for (const pid of new Set(frames.map(frame => frame.osProcessId))) evidence.processes.push({ pid, checked: false });
    const child = frames.find(frame => frame.url === 'about:srcdoc');
    assert.ok(child);
    assert.ok(frames.every(frame => frame.osProcessId !== evidence.chatPid));
    // `ready` can precede the sandboxed document finishing its parse.
    // Raced against a timer so a frozen fixture cannot hang the gate.
    await Promise.race([
      until('child document loaded', () => child.executeJavaScript('document.readyState==="complete"&&document.body.children.length>0'), 5000).catch(() => {}),
      delay(5500),
    ]);
    return { host, child };
  };
  const stop = async () => { await button('Stop'); await gone(); await installObserver(); };
  const post = async text => {
    const before=await page('return document.querySelectorAll(".message-row").length;');
    // Not awaited: the call resolves only when the bot's turn ends. A refusal still fails the step with its reason.
    await page(`window.__post={text:${JSON.stringify(text)},status:__deck.backend.host?.connection.get().status.kind};__deck.backend.roomPost('generated-smoke',${JSON.stringify(text)}).then(()=>{__post.done=true;},error=>{__post.error=String(error);});return true;`);
    // Wait for a bot reply rendered after the new message row, not just any card.
    await until('fixture bot finished', () => page(`if(__post.error)throw Error("post refused: "+__post.error+" (status "+__post.status+")");const rows=[...document.querySelectorAll(".message-row")];const mine=rows.map(r=>r.textContent.includes(${JSON.stringify(text)})).lastIndexOf(true);return mine>=${before}&&!document.querySelector(".answer-card.preparing")&&rows.slice(mine+1).some(r=>r.querySelector(".generated-answer")&&r.textContent.includes("Run this interface"));`),45000);
    await delay(250);
  };
  const shot = async name => {
    fs.writeFileSync(path.join(output, `${phase}-${name}.png`), (await win.webContents.capturePage()).toPNG());
    // Deck's renderer capture omits the native WebContentsView layer.
    const host = generated().at(-1);
    if (host) {
      const pixels = await host.capturePage();
      fs.writeFileSync(path.join(output, `${phase}-${name}-interface.png`), pixels.toPNG());
      if (name === 'claude' || name === 'codex') {
        const bitmap = pixels.toBitmap();
        assert.ok([...bitmap.subarray(0,3)].every(channel=>channel<64), 'The native flowchart canvas needs an opaque dark backdrop for its inherited dark-mode text');
      }
    }
  };
  const frozen = async (kind, manualStop=false) => {
    await post(`@fixture ${kind}`);await bringIntoView();await button('Run this interface');
    const host=await until('frozen host initialized',()=>generated().find(h=>h.mainFrame.framesInSubtree.some(f=>f.url==='about:srcdoc'&&f.osProcessId>0)));
    const runId = host.getURL().split('/').at(-1);
    await until('frozen payload delivered', () => globalThis.__generatedAudit?.some(event => event.runId === runId && event.type === 'payload-delivered'));
    if (kind !== 'freeze-init') await until('frozen fixture reached ready before its loop', () => page(`return __generatedEvents.some(e=>e.runId===${JSON.stringify(runId)}&&e.type==="ready");`));
    await delay(150);
    const frames=host.mainFrame.framesInSubtree;
    const pids=[...new Set(frames.map(f=>f.osProcessId))];
    assert.equal(pids.length, phase === 'recovery' ? 1 : 2, 'recovery must exercise the claimed same-process or OOPIF layout');
    for(const pid of pids)evidence.processes.push({pid,checked:false});
    const started=Date.now();if(manualStop)await button('Stop');await gone();
    const stopped = await until('frozen run stop receipt', () => page(`return __generatedEvents.find(e=>e.runId===${JSON.stringify(runId)}&&e.type==="stopped");`));
    assert.equal(stopped.reason, manualStop ? 'Generated interface approval was cancelled.' : kind === 'freeze-init' ? 'The interface did not become ready within two seconds.' : 'The interface stopped responding.');
    const disposed = globalThis.__generatedAudit.find(event => event.runId === runId && event.type === 'disposed');
    assert.deepEqual(disposed.remaining, []);
    evidence.recovery??=[];evidence.recovery.push({kind,manualStop,pids,sameGeneratedProcess:pids.length===1,stopReason:stopped.reason,payloadDelivered:true,elapsedMs:Date.now()-started});
    assert.ok(Date.now()-started<(manualStop?1500:8500));await installObserver();
  };
  try {
    win.setContentSize(1200, 1000); app.focus({steal:true});win.show(); win.focus();
    await ready();
    assert.equal(await page('return __deck.backend.demo;'), false);
    assert.ok(generatedUIManager);
    const profile = { id: 'fixture', display_name: 'Generated fixture', backend: { kind: 'cli', program: 'node', args: [path.join(data, 'fixture.mjs')] } };
    // As in the fork step: stop this page's autosave so it cannot replace the new session before the reload.
    await page(`await __deck.backend.roomCreate('generated-smoke',${JSON.stringify([profile])},{policy:'mention',max_bot_hops:1},${JSON.stringify(path.join(data,'project'))});const save=__deck.backend.sessionSave;__deck.backend.sessionSave=async()=>{};await save({version:1,workspaces:[{id:'generated-project',name:'Generated gates',path:${JSON.stringify(path.join(data,'project'))}}],panes:[{id:'generated-smoke',workspaceId:'generated-project',kind:'chat',title:'Generated UI gates'}],profiles:[],activeWorkspace:'generated-project',focusedPane:'generated-smoke',section:'threads',layout:'top'});return true;`);
    win.webContents.reload(); await ready();
    await until('composer ready', () => page('return Boolean(document.querySelector(".composer textarea"));'));
    await page('const pane=document.querySelector(".pane");pane.dispatchEvent(new MouseEvent("mousedown",{bubbles:true}));document.querySelector(".composer textarea").focus();return true;');
    evidence.chatPid = win.webContents.getOSProcessId();
    await installObserver();
    await step('partial generated stream stays inert; completion does not execute', async () => {
      await page('void __deck.backend.roomPost("generated-smoke","@fixture flowchart");return true;');
      await until('incomplete generated placeholder', () => page('return Boolean(document.querySelector(".answer-card.preparing"));'));
      assert.equal(generated().length, 0);
      await until('complete generated card', () => page('return Boolean(document.querySelector(".generated-answer button:not(:disabled)"));'));
      assert.equal(generated().length, 0);
    });
    if (phase === 'visual') {
      for (const provider of ['claude', 'codex']) await step(`native ${provider} flowchart layer has a pixel capture`, async () => {
        await post(`@fixture ${provider}`); await start(); await shot(provider); await stop();
      });
    } else if (phase === 'quit') {
      await start();
      evidence.quitIntent = { realAppQuit: true, daemonAliveBeforeQuit: sidecar()?.alive() };
      assert.equal(evidence.quitIntent.daemonAliveBeforeQuit, true);
      const actualExit = app.exit.bind(app);
      app.once('before-quit', () => { evidence.quitIntent.beforeQuitObserved = true; });
      // Deck deliberately uses app.exit after its real quit-request/flush/daemon
      // path, so it does not emit will-quit. Observe that final call only.
      app.exit = code => {
        evidence.checks.push({name:'actual app.quit reaches production app.exit; outer runner confirms generated PIDs exit',passed:code === 0 && evidence.quitIntent.beforeQuitObserved === true});
        evidence.quitIntent.exitCode = code;
        evidence.passed = code === 0 && evidence.quitIntent.beforeQuitObserved === true;
        fs.writeFileSync(path.join(output, 'quit.json'), JSON.stringify(evidence, null, 2));
        actualExit(code);
      };
      app.quit();
      await new Promise(() => {}); // Real production quit ordering ends this process.
    } else if (phase === 'cycles') {
      await step('32 fresh real sessions dispose all PIDs and then fail closed', async () => {
        for (let index = 0; index < 32; index++) {
          await start(); await stop();
        }
        assert.equal(generatedUIManager.capability().enabled, false);
        assert.match(generatedUIManager.capability().reason, /session limit/);
        await assert.rejects(generatedUIManager.run({win,frame:win.webContents.mainFrame},{}),/session limit/);
        await until('Run disabled after last session',()=>page('return [...document.querySelectorAll(".generated-answer button")].find(b=>b.textContent.trim()==="Run this interface")?.disabled===true;'));
      });
    } else if(phase==='recovery') {
      evidence.weakenedDiagnostic='Site isolation disabled only to exercise same-generated-process termination; no security result claimed under these flags.';
      for(const kind of ['freeze-init','freeze-after','freeze-micro','freeze-allocation'])await step(`${kind} same-process recovery`,()=>frozen(kind));
      await step('trusted Stop terminates a frozen same-process run',()=>frozen('freeze-after',true));
      assert.ok(evidence.recovery.some(record=>record.sameGeneratedProcess),'diagnostic actually observed the same-process path');
    } else {
      await step('native Run renders a working SVG flowchart; Stop and retry require a fresh click', async () => {
        const { child } = await start();
        evidence.firstLayout=await child.executeJavaScript('({width:innerWidth,height:innerHeight,svg:document.querySelector("svg").getBoundingClientRect().toJSON(),body:document.body.getBoundingClientRect().toJSON(),ready:document.readyState})');
        evidence.cardLayout=await page('const c=document.querySelector(".generated-answer");return [c,c.parentElement,c.closest(".bubble"),c.closest(".message-row")].map(e=>({class:e?.className,rect:e?.getBoundingClientRect().toJSON(),display:e&&getComputedStyle(e).display,width:e&&getComputedStyle(e).width}));');
        await until('flowchart layout',()=>child.executeJavaScript('document.querySelector("svg").getBoundingClientRect().width>100'),3000);
        assert.equal(await child.executeJavaScript('document.querySelector("#step").textContent'), 'Ask a question');
        await child.executeJavaScript('document.querySelector("#next").click()');
        assert.equal(await child.executeJavaScript('document.querySelector("#step").textContent'), 'Generate HTML, CSS and JS');
        await child.executeJavaScript('document.querySelector("#reset").click()');
        assert.equal(await child.executeJavaScript('document.querySelector("#step").textContent'), 'Ask a question');
        await shot('flowchart'); await stop();
        assert.equal(generated().length, 0); await start(); await stop();
      });
      await step('Discuss preview does not modify or send a draft; trusted Discuss appends', async () => {
        await page('const el=document.querySelector(".composer textarea");Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set.call(el,"Existing typed draft");el.dispatchEvent(new Event("input",{bubbles:true}));return true;');
        const before = await page('return (await __deck.backend.roomState("generated-smoke")).snapshot.transcript.length;');
        const { child } = await start();
        await child.executeJavaScript('document.querySelector("#discuss").click()');
        await until('trusted Discuss preview', () => page('return Boolean(document.querySelector(".generated-discuss"));'));
        assert.equal(await page('return document.querySelector(".composer textarea").value;'), 'Existing typed draft');
        await button('Discuss this text');
        assert.match(await page('return document.querySelector(".composer textarea").value;'), /^Existing typed draft[\s\S]*Flow step: Ask a question/);
        assert.equal(await page('return (await __deck.backend.roomState("generated-smoke")).snapshot.transcript.length;'), before);
        await stop();
        // Leave a clean composer so its height does not shift the card in later steps.
        await page('const el=document.querySelector(".composer textarea");Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set.call(el,"");el.dispatchEvent(new Event("input",{bubbles:true}));return true;');
        await delay(300);
      });
      for (const [name, action, undo] of [
        ['scroll', 'document.querySelector(".transcript").dispatchEvent(new Event("scroll",{bubbles:true}));', ''],
        ['trusted modal overlay', 'const o=document.createElement("div");o.id="gate-overlay";o.setAttribute("role","dialog");o.style.cssText="position:fixed;inset:0;background:white;z-index:9999";document.body.append(o);', 'document.querySelector("#gate-overlay").remove();'],
        ['ApexAgent partial overlay', 'const r=document.querySelectorAll(".generated-slot").item(document.querySelectorAll(".generated-slot").length-1).getBoundingClientRect();const o=document.createElement("div");o.id="gate-overlay";o.setAttribute("data-apex-agent-overlay","bubble");o.style.cssText="position:fixed;width:20px;height:20px;z-index:9999;background:white;left:"+(r.left+35)+"px;top:"+(r.top+35)+"px";document.body.append(o);', 'document.querySelector("#gate-overlay").remove();'],
        ['connection resync', 'const c=__deck.backend.machines.connection("local");c.setStatus({kind:"resync"});', 'const c=__deck.backend.machines.connection("local");c.setStatus({kind:"connected",hostId:"local"});'],
        ['ordinary disconnect', 'const c=__deck.backend.machines.connection("local");c.setStatus({kind:"disconnected"});', 'const c=__deck.backend.machines.connection("local");c.setStatus({kind:"connected",hostId:"local"});'],
      ]) await step(`${name} disposes generated view and stale Discuss`, async () => {
        await start(); await page(`${action}return true;`); await gone();
        if (undo) await page(`${undo}return true;`);
        await ready(); await installObserver();
        assert.equal(await page('return document.querySelectorAll(".generated-discuss").length;'),0);
      });
      await step('resize and owner focus loss dispose; another window cannot stop owner run', async () => {
        await start(); win.setContentSize(1180,980); await gone(); await installObserver();
        const { host } = await start();
        const second = new BrowserWindow({show:false,width:500,height:400,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
        await second.loadURL('data:text/html,<title>Second owner canary</title>');
        await generatedUIManager.stop({win:second,frame:second.webContents.mainFrame},host.getURL().split('/').at(-1));
        assert.equal(generated().length,1);
        second.show(); second.focus(); await gone(); second.destroy();win.focus();await installObserver();
      });
      await step('suspend invalidates all run authority without sleeping the machine', async () => {
        await start();powerMonitor.emit('suspend');await gone();await installObserver();
      });
      await step('owner zoom uses native DIP bounds and changing it revokes the old run', async()=>{
        for(const zoom of [0.8,1.2]) {
          win.webContents.setZoomFactor(zoom); await delay(250); await installObserver();
          const {child}=await start();
          const css=await page('const r=document.querySelectorAll(".generated-slot").item(document.querySelectorAll(".generated-slot").length-1).getBoundingClientRect();return {width:r.width,height:r.height};');
          const viewport=await child.executeJavaScript('({width:innerWidth,height:innerHeight})');
          assert.ok(Math.abs(viewport.width-css.width*zoom)<3,JSON.stringify({viewport,css,zoom}));
          win.webContents.setZoomFactor(1);await gone();await installObserver();
        }
      });
      await step('revised payload stops the old run; old card remains text-only', async () => {
        await start();await post('@fixture revised flowchart');await gone();await installObserver();
        const cards = await page('return [...document.querySelectorAll(".generated-answer")].map(c=>({text:c.textContent,run:!!c.querySelector("button")}));');
        assert.ok(cards.some(card=>!card.run&&card.text.includes('earlier version')));
        assert.match(cards.at(-1).text,/v2/);
        await start();await stop();
      });
      await step('fork and renderer reload never preserve execution approval', async () => {
        // Open only `pane` after a reload. The old page's autosave is stopped first,
        // or it can save its own thread list over this one before the reload.
        const showOnly=async pane=>{
          await page(`const s=await __deck.backend.sessionLoad();const save=__deck.backend.sessionSave;__deck.backend.sessionSave=async()=>{};await save({...s,panes:[${JSON.stringify(pane)}],focusedPane:${JSON.stringify(pane.id)}});return true;`);
          win.webContents.reload();await until('reload disposed',()=>generated().length===0);await ready();
          await until(`thread ${pane.id} shown`,()=>page(`return [...document.querySelectorAll(".pane")].map(p=>p.dataset.paneId).join()===${JSON.stringify(pane.id)};`));
          evidence.chatPid=win.webContents.getOSProcessId();await installObserver();
        };
        await start();await page('await __deck.backend.roomFork("generated-smoke","generated-fork",null);return true;');
        await showOnly({id:'generated-fork',workspaceId:'generated-project',kind:'chat',title:'Fork'});
        // The fork's copy of the card waits for its own Run click.
        await until('fork card offers Run',()=>page('return [...document.querySelectorAll(".generated-answer button")].some(b=>b.textContent.trim()==="Run this interface"&&!b.disabled);'));
        await delay(500);assert.equal(generated().length,0);
        await showOnly({id:'generated-smoke',workspaceId:'generated-project',kind:'chat',title:'Generated gates'});
        assert.equal(generated().length,0);
      });
      for (const fixture of ['calculator','chart']) await step(`${fixture} local controls, keyboard labels and Reset work in chat`, async()=>{
        await post(`@fixture ${fixture}`);const {child}=await start();
        fs.writeFileSync(path.join(output,`${phase}-${fixture}-child.html`),await child.executeJavaScript('document.documentElement.outerHTML.slice(0,2000)').catch(e=>String(e)));
        assert.ok(await child.executeJavaScript('Boolean(document.querySelector("label[for=amount]"))'));
        assert.equal(await child.executeJavaScript('document.querySelector("#out").textContent'),'20');
        await child.executeJavaScript('(()=>{const input=document.querySelector("#amount");input.value="7";input.dispatchEvent(new Event("input"));})()');
        assert.equal(await child.executeJavaScript('document.querySelector("#out").textContent'),'14');
        await child.executeJavaScript('document.querySelector("#reset").click()');
        assert.equal(await child.executeJavaScript('document.querySelector("#out").textContent'),'20');
        await shot(fixture);await stop();
      });
      for(const provider of ['claude','codex']) await step(`captured ${provider} flowchart renders and its Next/Reset controls work`,async()=>{
        await post(`@fixture ${provider}`);let result=await start();
        await delay(3200); // Startup measurement polling lasts three seconds.
        const resizeHeights = await page('return __generatedEvents.filter(e=>e.type==="resize").map(e=>e.height);');
        assert.ok(resizeHeights.length > 0, 'The initial flowchart height must reach trusted chat after ready');
        assert.ok(resizeHeights.every((height,index)=>index===0||height!==resizeHeights[index-1]), 'Unchanged measurements must not repeatedly resize the native flowchart');
        evidence.providerResizeHeights ??= {}; evidence.providerResizeHeights[provider] = resizeHeights;
        await page('window.__trace=[];for(const t of ["scroll","resize","blur","focusout","visibilitychange"])addEventListener(t,e=>__trace.push(t+":"+(e.target?.className||e.target?.nodeName||"")+"@"+Math.round(performance.now())),true);return true;');
        const before=await result.child.executeJavaScript('document.querySelector("#status").textContent');
        await result.child.executeJavaScript('document.querySelector("#next").click()');
        assert.notEqual(await result.child.executeJavaScript('document.querySelector("#status").textContent'),before);
        evidence.focusTrace=[];const mark=name=>evidence.focusTrace.push(name+'@'+Date.now());win.on('blur',()=>mark('win-blur'));win.on('focus',()=>mark('win-focus'));
        mark('before-host-focus');result.host.focus();mark('after-host-focus');await result.child.executeJavaScript('document.querySelector("#reset").focus()');mark('after-child-focus');
        await result.child.executeJavaScript('window.__k=[];for(const t of ["keydown","keypress","keyup","click","focus","blur"])addEventListener(t,e=>__k.push(t+":"+(e.target.id||e.target.nodeName)),true);true');
        // sendInputEvent only reaches the main widget, never the generated OOPIF, so press a real OS key instead.
        assert.ok(win.isFocused()&&await result.child.executeJavaScript('document.hasFocus()'),'frame must hold OS focus before the key');
        // Check the front app and press Return in one script, so the key can never land in another app.
        const pressed=(await import('node:child_process')).execFileSync('osascript',['-e','tell application "System Events"','-e',`if (unix id of (first process whose frontmost is true)) is ${process.pid} then`,'-e','key code 36','-e','return "sent"','-e','end if','-e','return "skipped"','-e','end tell']).toString().trim();
        assert.equal(pressed,'sent','Deck must be the front app when Return is pressed');
        await delay(500);evidence.keyTrace=await result.child.executeJavaScript('({k:__k,active:document.activeElement?.id,focus:document.hasFocus()})');
        await until('keyboard Reset',async()=>await result.child.executeJavaScript('document.querySelector("#status").textContent')===before);
        assert.equal(await result.child.executeJavaScript('document.querySelector("#status").textContent'),before);
        await shot(provider);await stop();
      });
      await step('chat Revert and Retry stop a running interface; the isolated daemon remains usable',async()=>{
        // Deck never moves a thread that has replies (it offers New thread or Fork), so going
        // back is how a started thread's history changes in place. Use the chat's own buttons,
        // without their confirmation, which is itself an overlay that would stop the run.
        await page('localStorage.setItem("apex-deck.retry.always","1");localStorage.setItem("apex-deck.revert.always","1");await __deck.backend.roomPostTo("generated-smoke","A later note",[],false);return true;');
        const note='[...document.querySelectorAll(".message-row")].filter(r=>r.textContent.includes("A later note")).at(-1)';
        const reply='[...document.querySelectorAll(".message-row")].filter(r=>r.querySelector(".generated-answer")).at(-1)';
        await until('later note shown',()=>page(`return Boolean(${note});`));
        const expand=row=>page(`${row}.querySelector("[data-message-more]").click();return true;`);
        const press=(row,label)=>page(`const b=${row}.querySelector('[aria-label=${JSON.stringify(label)}]');if(!b||b.disabled)throw Error('Unavailable ${label}');b.click();return true;`);
        // Opening the message actions alone must leave the run going.
        const stillRunning=async()=>{const runId=generated().at(-1)?.getURL().split('/').at(-1);await delay(400);assert.equal(generated().length,1);assert.equal(await page(`return !__generatedEvents.some(e=>e.runId===${JSON.stringify(runId)}&&e.type==="stopped");`),true);};
        // Revert on a later message keeps the card but still stops its run.
        await start();await expand(note);await stillRunning();await press(note,'Revert to here');await gone();await installObserver();
        // Approval now stops before the asynchronous mutation completes.
        await until('Revert history completed', () => page(`return !${note} && Boolean(${reply});`));
        await page('const el=document.querySelector(".composer textarea");Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set.call(el,"");el.dispatchEvent(new Event("input",{bubbles:true}));return true;');
        // Retry deletes the card's own reply; the bot's new card needs its own Run click.
        await start();await expand(reply);await stillRunning();await press(reply,'Retry');await gone();await installObserver();
        await until('Retry starts a new fixture stream',()=>page('return Boolean(document.querySelector(".answer-card.preparing"));'));
        await until('retried reply',()=>page('const last=[...document.querySelectorAll(".message-row")].at(-1);return !document.querySelector(".answer-card.preparing")&&[...(last?.querySelectorAll(".generated-answer button")??[])].some(b=>b.textContent.trim()==="Run this interface"&&!b.disabled);'),45000);
        await start();await stop();
      });
      for(const kind of ['freeze-init','freeze-after','freeze-micro','freeze-allocation']) await step(`${kind} watchdog recovers chat and terminates generated PIDs`,()=>frozen(kind));
      await step('trusted Stop terminates a frozen OOPIF run',()=>frozen('freeze-after',true));
      await step('quit event disposes generated PIDs while isolated daemon and chat still answer',async()=>{
        // Only the generated host's listener: Deck's own asks the window and, with nothing running, really quits.
        const quit=app.listeners('before-quit').filter(listener=>String(listener).includes('stopAll'));
        assert.equal(quit.length,1);
        await start(); quit[0]({preventDefault(){}});await gone();
        assert.ok(sidecar()?.alive());
      });
    }
    evidence.passed=true;
  } catch(error) {
    evidence.error=error?.stack??String(error);
    evidence.diagnostic=await page('return {api:Boolean(window.apexDeck?.generatedUI),capability:await window.apexDeck?.generatedUI?.capability(),panes:[...document.querySelectorAll(".pane")].map(p=>({id:p.dataset.paneId,class:p.className,display:getComputedStyle(p).display})),session:await __deck.backend.sessionLoad()};').catch(()=>null);
    console.error(evidence.error);
    fs.writeFileSync(path.join(output,`${phase}-failure-dom.txt`),await page('return document.body.innerText;').catch(()=>''));
    fs.writeFileSync(path.join(output,`${phase}-focus-trace.json`),JSON.stringify(evidence.focusTrace||[]));
    fs.writeFileSync(path.join(output,`${phase}-failure-events.json`),await page('return JSON.stringify({events:window.__generatedEvents||[],trace:window.__trace||[]});').catch(()=>'[]'));
    await shot('failure').catch(()=>{});
  } finally {
    await generatedUIManager?.stopAll('Lifecycle gate complete.');
    evidence.windowCount=windows().length;
    fs.writeFileSync(path.join(output,`${phase}.json`),JSON.stringify(evidence,null,2));
  }
  return evidence.passed?0:1;
}
