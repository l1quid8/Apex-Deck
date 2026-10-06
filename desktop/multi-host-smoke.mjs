import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { BrowserWindow } from 'electron';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
export async function runMultiHostSmoke(win) {
  // Keep xterm rendering and UI timers active in the hidden test window.
  win.webContents.setBackgroundThrottling(false);
  const root=process.env.APEX_DECK_MULTI_HOST_ROOT;
  // The seeded project's copies (run-multi-host-smoke.mjs): same folder name on each machine.
  const serverCopy=path.join(root,'server-copy','project');
  const remoteSession=path.join(root,'server','saved-chats-v1','session.json');
  const original=fs.readFileSync(remoteSession,'utf8');
  const page=code=>win.webContents.executeJavaScript(`(async()=>{${code}})()`,true);
  async function until(label, check) {
    const end=Date.now()+20000;let last;
    while(Date.now()<end) { try {const value=await check();if(value)return value;}catch(e){last=e;} await sleep(30); }
    // A picture of the window as it was, for whoever reads the failure.
    try { fs.writeFileSync(path.join(process.env.APEX_DECK_SMOKE_OUTPUT,'failure.png'),(await win.webContents.capturePage()).toPNG()); } catch {}
    throw Error(`timed out: ${label}${last?' '+last.message:''}`);
  }
  const pane=id=>`document.querySelector('[data-pane-id="${id}"]')`;
  async function type(id,text) {
    await page(`const input=${pane(id)}.querySelector('textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,${JSON.stringify(text)});input.dispatchEvent(new Event('input',{bubbles:true}));return true;`);
  }
  async function send(id,text) {
    await type(id,text);await sleep(650);
    assert.equal(await page(`return ${pane(id)}.querySelector('[aria-label="Send"]').disabled`),false);
    await page(`${pane(id)}.querySelector('[aria-label="Send"]').click();return true;`);
  }
  const shot=async name=>{
    // The smoke window is hidden. Its animation frames may be suspended;
    // capturePage itself requests a paint after the asserted state settles.
    await sleep(150);
    fs.writeFileSync(path.join(process.env.APEX_DECK_SMOKE_OUTPUT,name+'.png'),(await win.webContents.capturePage()).toPNG());
  };
  await until('Mac ready',()=>page('return Boolean(window.__deck && !document.querySelector(".loading"))'));
  await until('automatic remote import',()=>page('return [...document.querySelectorAll(".pane-row")].some(r=>r.textContent.includes("Server thread"))'));
  assert.equal(BrowserWindow.getAllWindows().length,1);
  // Stage 2: the Codex-style sidebar.
  const sections=()=>page('return [...document.querySelectorAll(".rail .rail-sec")].map(s=>s.dataset.sec).join()');
  await until('codex sidebar',async()=>(await sections())==='pinned,projects');
  const serverRow='.ws-row[data-host-id="at"]';
  assert.equal(await page(`return document.querySelector('${serverRow} .host-name').textContent`),'Production-Frankfurt-Primary-01');
  assert.equal(await page(`return document.querySelector('${serverRow} .host-name').title`),'Production-Frankfurt-Primary-01');
  assert.equal(await page(`return Boolean(document.querySelector('${serverRow} .fold-globe'))`),true);
  assert.equal(await page('return Boolean(document.querySelector(\'.ws-row[data-host-id="local"] .fold-globe\'))'),false);
  assert.equal(await page('return [...document.querySelectorAll(".pane-row.flat")].find(r=>r.textContent.includes("Server thread")).querySelector(".globe-end")!==null'),true);
  assert.equal(await page('return [...document.querySelectorAll(".pane-row.flat")].find(r=>r.textContent.includes("Mac thread")).querySelector(".globe-end")'),null);
  await until('server dot connected',()=>page(`return document.querySelector('${serverRow} .hdot').classList.contains('on')`));
  assert.equal(await page("return __deck.backend.machines.connection('at').get().helper"),JSON.parse(fs.readFileSync('package.json','utf8')).version);
  const hover=sel=>page(`const el=document.querySelector(${JSON.stringify(sel)});el.dispatchEvent(new MouseEvent('mouseover',{bubbles:true,relatedTarget:null}));return true;`);
  const unhover=sel=>page(`const el=document.querySelector(${JSON.stringify(sel)});el.dispatchEvent(new MouseEvent('mouseout',{bubbles:true,relatedTarget:document.body}));return true;`);
  await hover(`${serverRow} .ws-name`);
  await until('project card',()=>page('return document.querySelector(".hover-card")?.innerText.includes("Production-Frankfurt-Primary-01 · 1 thread")'));
  assert.ok((await page('return document.querySelector(".hover-card").innerText')).includes(serverCopy));
  await shot('sidebar-project-card');
  await unhover(`${serverRow} .ws-name`);
  await until('project card closes',()=>page('return !document.querySelector(".hover-card")'));
  const serverPinned='.pane-row.flat[data-pane-row="server-thread"]';
  await page(`document.querySelector('${serverPinned} [aria-haspopup=menu]').click();return true;`);
  const menuLabels=()=>page('return [...document.querySelectorAll(".pane-menu [role=menuitem]")].map(b=>b.querySelector(".label")?.textContent??b.textContent).join("|")');
  assert.equal(await menuLabels(),'Rename|Unpin|Mark as unread|Project|Share as PDF|Copy|Fork|Export|Archive|Delete…');
  assert.equal(await page('return [...document.querySelectorAll(".pane-menu [role=menuitem] .keys")].map(k=>k.textContent).join()'),'⌥⌘R,⌥⌘P,⇧⌘U,⇧⌘A');
  await page('[...document.querySelectorAll(".pane-menu [role=menuitem]")].find(b=>b.textContent.startsWith("Copy")).click();return true;');
  await until('copy submenu',()=>page('return document.querySelectorAll(".pane-submenu [role=menuitem]").length===4'));
  assert.equal(await page('return [...document.querySelectorAll(".pane-submenu [role=menuitem] .sub")].map(s=>s.textContent).join("|")'),`fixture:${serverCopy}|server-thread`);
  await shot('sidebar-thread-menu-copy');
  await page('document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}));return true;');
  await until('menu closed',()=>page('return !document.querySelector(".pane-menu")'));
  await page(`document.querySelector('${serverPinned}').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:120,clientY:140}));return true;`);
  await until('right-click menu',async()=>(await menuLabels())==='Rename|Unpin|Mark as unread|Project|Share as PDF|Copy|Fork|Export|Archive|Delete…');
  await page('document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}));return true;');
  await until('menu closed again',()=>page('return !document.querySelector(".pane-menu")'));
  await page(`document.querySelector('${serverRow} [aria-haspopup=menu]').click();return true;`);
  assert.equal(await menuLabels(),'Pin|Edit…|Edit connection…|Archive threads|Remove project…');
  await page('document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}));return true;');
  await until('project menu closed',()=>page('return !document.querySelector(".pane-menu")'));
  const oldHelper=process.env.APEX_DECK_SMOKE_OLD_HELPER==='1';
  await page(`const b=__deck.backend.machines.get('at');window.__originalRoomState=b.roomState;window.__oldHelperCalls=0;window.__loadRoomState=${oldHelper}?async()=>{window.__oldHelperCalls++;throw Error('unknown variant \u0060room_state\u0060, expected room_create');}:b.roomState;b.roomState=window.__loadRoomState;${oldHelper ? "__deck.backend.machines.connection('at').setStatus({kind:'resync'});" : ''}return true;`);
  if(oldHelper) {
    await until('old helper fallback requested',()=>page('return window.__oldHelperCalls>0'));
    // Complete this injected resync's connection notification. Real handshake
    // resyncs below still finish through DaemonClient's own callback.
    await page("__deck.backend.machines.connection('at').setStatus({kind:'connected',hostId:'fixture'});return true;");
  }
  await page('const row=[...document.querySelectorAll(".pane-row")].find(r=>r.textContent.includes("Server thread"));row.click();return true;');
  await until('both rooms loaded',()=>page(`return [${pane('mac-thread')},${pane('server-thread')}].every(p=>p.offsetWidth>0&&p.querySelector('[aria-label="Add bot"]')&&!p.querySelector('[aria-label="Add bot"]').disabled)`));
  await sleep(650);
  await send('mac-thread','@bot local first');await send('server-thread','@bot remote first');
  await until('Mac positive reply',()=>page(`return ${pane('mac-thread')}.querySelector('.transcript').innerText.includes('mac-native-reply')`));
  await until('server positive reply',()=>page(`return ${pane('server-thread')}.querySelector('.transcript').innerText.includes('server-native-reply')`));
  assert.equal(await page(`return ${pane('mac-thread')}.querySelector('.transcript').innerText.includes('server-native-reply')`),false);
  assert.equal(await page(`return ${pane('server-thread')}.querySelector('.transcript').innerText.includes('mac-native-reply')`),false);
  await until('import saved atomically',async()=>{const s=await page('return await __deck.backend.sessionLoad()');return s.canvasVersion===1&&s.importedHostSessions.includes('at');});
  assert.equal(fs.readFileSync(remoteSession,'utf8'),original);
  assert.equal(await page('const s=await __deck.backend.sessionLoad();return s.workspaces.find(w=>w.hostId==="at").id!=="shared-workspace-id"'),true);
  await until('recents after replies',async()=>(await sections())==='pinned,projects,recents');
  // Copy › with a stand-in clipboard; the real one is never touched.
  await page(`window.__copied=[];window.__clipboardOk=true;Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async t=>{if(!window.__clipboardOk)throw Error('denied');window.__copied.push(t);}}});return true;`);
  const copyItem=async(rowSel,label)=>{
    await page(`document.querySelector('${rowSel} [aria-haspopup=menu]').click();return true;`);
    await page('[...document.querySelectorAll(".pane-menu [role=menuitem]")].find(b=>b.textContent.startsWith("Copy")).click();return true;');
    await until('copy submenu open',()=>page('return document.querySelectorAll(".pane-submenu [role=menuitem]").length===4'));
    await page(`[...document.querySelectorAll(".pane-submenu [role=menuitem]")].find(b=>b.querySelector(".label").textContent===${JSON.stringify(label)}).click();return true;`);
    await until('menu closed after copy',()=>page('return !document.querySelector(".pane-menu")'));
  };
  const toastSaid=words=>page(`return [...document.querySelectorAll(".toast")].some(t=>t.textContent.includes(${JSON.stringify(words)}))`);
  // Copy and Export hold finished messages only: wait until the reply stops streaming.
  await until('server reply finished',()=>page(`return [...${pane('server-thread')}.querySelectorAll('.bubble.bot.completed')].some(b=>b.innerText.includes('server-native-reply'))`));
  await copyItem(serverPinned,'Copy as Markdown');
  await until('markdown copied',()=>page('return window.__copied.some(t=>t.startsWith("# Server thread")&&t.includes("server-native-reply"))'));
  await until('copy toast',()=>toastSaid('Copied the thread as Markdown.'));
  await copyItem(serverPinned,'Copy folder path');
  await until('server folder copied with its destination',()=>page(`return window.__copied.includes(${JSON.stringify('fixture:'+serverCopy)})`));
  await copyItem(serverPinned,'Copy last reply');
  await until('last reply copied',()=>page('return window.__copied.some(t=>t.trim()==="server-native-reply")'));
  await page('window.__clipboardOk=false;return true;');
  await copyItem(serverPinned,'Copy thread ID');
  await until('a refused copy says so',()=>toastSaid("Couldn't reach the clipboard, so nothing was copied."));
  assert.equal(await page('return window.__copied.includes("server-thread")'),false);
  await shot('sidebar-copy-refused');
  await page('window.__clipboardOk=true;return true;');
  assert.equal(await page('return [...document.querySelectorAll(".pane-row.flat")].filter(r=>r.textContent.includes("Server thread")).every(r=>r.querySelector(".globe-end"))'),true);
  await shot('connected');
  // Clear reuses message numbers. Exercise the actual composer after truncation.
  await send('mac-thread','/clear');
  await until('Mac cleared',()=>page(`return !${pane('mac-thread')}.querySelector('.transcript').innerText.includes('mac-native-reply')`));
  await send('mac-thread','@bot after clear');
  await until('reply after reused message numbers',()=>page(`return ${pane('mac-thread')}.querySelector('.transcript').innerText.includes('mac-native-reply')`));

  // A failed snapshot must recover on an ordinary resumed connection.
  await page(`const b=__deck.backend.machines.get('at');b.roomState=async()=>{throw Error('smoke interrupted room load');};__deck.backend.machines.connection('at').setStatus({kind:'resync'});return true;`);
  await until('interrupted room load',()=>page(`return ${pane('server-thread')}.innerText.includes('smoke interrupted room load')`));
  await page(`const b=__deck.backend.machines.get('at');b.roomState=window.__loadRoomState;const c=__deck.backend.machines.connection('at');c.setStatus({kind:'reconnecting',attempt:1,reason:'smoke resume',retryAt:0});c.setStatus({kind:'connected',hostId:'fixture'});return true;`);
  await until('failed room retried on resume',()=>page(`return !${pane('server-thread')}.querySelector('[aria-label="Add bot"]').disabled`));
  // Inject only the read-only snapshot; answering still reaches the real daemon,
  // which rejects the nonexistent request. This checks UI rejection and expiry.
  async function approval(request, expiresAt) {
    await page(`const b=__deck.backend.machines.get('at');b.roomState=async id=>({...await window.__originalRoomState(id),active:['bot'],approvals:[{id:'bot',request:${JSON.stringify(request)},action:{kind:'command',title:'Run pwd',detail:'pwd',risky:false,expires_at:${expiresAt}}}]});__deck.backend.machines.connection('at').setStatus({kind:'resync'});return true;`);
    await until('approval snapshot rendered',()=>page(`return Boolean(${pane('server-thread')}.querySelector('[data-request="${request}"]'))`));
    await page(`__deck.backend.machines.get('at').roomState=window.__loadRoomState;__deck.backend.machines.connection('at').setStatus({kind:'connected',hostId:'fixture'});return true;`);
  }
  await approval('smoke-rejected',Date.now()+60000);
  assert.equal(await page(`return ${pane('server-thread')}.querySelector('.approval-host').textContent`),'Runs on Production-Frankfurt-Primary-01');
  await page(`${pane('server-thread')}.querySelector('[data-answer="once"]').click();return true;`);
  await until('rejected approval permits retry',()=>page(`return ${pane('server-thread')}.querySelector('.approval [role="alert"]')&&!${pane('server-thread')}.querySelector('[data-answer="once"]').disabled`));
  await shot('approval-rejected-retry');
  await type('server-thread','@bot offline draft kept');
  fs.writeFileSync(path.join(root,'offline'),'1');process.kill(Number(fs.readFileSync(path.join(root,'attach.pid'),'utf8')),'SIGTERM');
  await until('only remote paused',()=>page(`const p=${pane('server-thread')};const send=p.querySelector('[aria-label="Send"]');return __deck.backend.machines.connection('at').get().status.kind==='reconnecting'&&(send?send.disabled:Boolean(p.querySelector('[aria-label="Stop all"]')))`));
  assert.equal(await page(`return [...${pane('server-thread')}.querySelectorAll('.approval button')].every(b=>b.disabled)`),true);
  // The server's dot goes gray and its project card says so, with Retry.
  assert.equal(await page(`return document.querySelector('${serverRow} .hdot').classList.contains('off')`),true);
  await hover(`${serverRow} .ws-name`);
  await until('offline project card',()=>page(`return document.querySelector('.hover-card')?.innerText.includes("Can't reach Production-Frankfurt-Primary-01.")`));
  assert.equal(await page('return Boolean(document.querySelector(\'.hover-card [aria-label="Retry Production-Frankfurt-Primary-01"]\'))'),true);
  await shot('sidebar-offline-card');
  await unhover(`${serverRow} .ws-name`);
  await until('offline card closes',()=>page('return !document.querySelector(".hover-card")'));
  assert.equal(await page(`return ${pane('server-thread')}.querySelector('textarea').value`),'@bot offline draft kept');
  assert.equal(await page(`return ${pane('server-thread')}.querySelector('textarea').disabled`),false);
  await page(`${pane('server-thread')}.querySelector('textarea').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));return true;`);
  assert.equal(await page(`return ${pane('server-thread')}.querySelector('textarea').value`),'@bot offline draft kept');
  await assert.rejects(page(`return await __deck.backend.machines.get('at').roomPost('server-thread','@bot rejected')`),/connect/);
  await send('mac-thread','@bot local during outage');
  await until('Mac reply during outage',()=>page(`return ${pane('mac-thread')}.querySelector('.transcript').innerText.split('mac-native-reply').length===3`));
  await shot('remote-offline');
  fs.unlinkSync(path.join(root,'offline'));await page("__deck.backend.machines.connection('at').retryNow();return true;");
  await until('remote reconnected',()=>page("return __deck.backend.machines.connection('at').get().status.kind==='connected'"));
  assert.equal(await page(`return ${pane('server-thread')}.querySelector('textarea').value`),'@bot offline draft kept');
  const remote=await page("return await window.__originalRoomState('server-thread')");
  assert.equal(remote.snapshot.transcript.some(m=>/offline draft|rejected/.test(m.text)),false);
  await assert.rejects(page("return await __deck.backend.hosts.remove('at')"),/saved workspaces/);
  await shot('reconnected-draft-kept');
  const revision=await page("return __deck.backend.machines.connection('at').get().revision");
  fs.writeFileSync(path.join(root,'restart'),'1');
  await until('fixture daemon restarted',()=>fs.existsSync(path.join(root,'restart-done')));
  await page("__deck.backend.machines.connection('at').retryNow();return true;");
  await until('daemon restart snapshot recovered',()=>page(`return __deck.backend.machines.connection('at').get().revision>${revision}&&__deck.backend.machines.connection('at').get().status.kind==='connected'&&!${pane('server-thread')}.querySelector('[aria-label="Add bot"]').disabled`));
  assert.equal(await page(`return ${pane('server-thread')}.querySelector('textarea').value`),'@bot offline draft kept');
  await shot('daemon-restart-recovered');
  const remoteBackend="__deck.backend.machines.get('at')";
  const upload=await page(`return await ${remoteBackend}.saveAttachment('server-thread','proof.txt',new TextEncoder().encode('remote upload proof'))`);
  assert.equal(fs.readFileSync(upload,'utf8'),'remote upload proof');
  assert.ok(upload.startsWith(path.join(root,'server')));
  const bytes=await page(`return [...new Uint8Array(await ${remoteBackend}.readAttachment(${JSON.stringify(upload)}))]`);
  assert.equal(Buffer.from(bytes).toString(),'remote upload proof');
  await approval('smoke-expired',Date.now()-1000);
  assert.equal(await page(`return [...${pane('server-thread')}.querySelectorAll('.approval button')].every(b=>b.disabled)`),true);
  await shot('approval-expired');
  const macPinned='.pane-row.flat[data-pane-row="mac-thread"]';
  await page(`document.querySelector('${macPinned} [aria-haspopup=menu]').click();return true;`);
  await page('[...document.querySelectorAll(".pane-menu [role=menuitem]")].find(b=>b.textContent.startsWith("Mark as unread")).click();return true;');
  await until('marked unread',()=>page(`return Boolean(document.querySelector('${macPinned}.unread'))`));
  await until('unread saved',async()=>(await page('return await __deck.backend.sessionLoad()')).panes.find(p=>p.id==='mac-thread').unread===true);
  win.webContents.reload();
  await until('canvas restored with both panes',()=>page(`return Boolean(window.__deck)&&[${pane('mac-thread')},${pane('server-thread')}].every(p=>p&&p.offsetWidth>0)`));
  assert.equal(fs.readFileSync(remoteSession,'utf8'),original);
  await until('still unread after a reload',()=>page(`return Boolean(document.querySelector('${macPinned}.unread'))`));
  await page(`document.querySelector('${macPinned}').click();return true;`);
  await until('read once opened',()=>page(`return !document.querySelector('${macPinned}.unread')`));
  // Open the imported terminal descriptor, start it explicitly, and exercise the real
  // PTY through history-loss recovery. The process must survive a same-boot gap.
  await page('document.querySelector(".section-button.code").click();return true;');
  await until('imported terminal row',()=>page('return [...document.querySelectorAll(".pane-row")].some(r=>r.textContent.includes("Server terminal"))'));
  await page('const row=[...document.querySelectorAll(".pane-row")].find(r=>r.textContent.includes("Server terminal"));row.click();return true;');
  await until('restored terminal stopped',()=>page(`return ${pane('server-terminal')}?.offsetWidth>0&&Boolean(${pane('server-terminal')}?.querySelector('.terminal-stopped .primary'))`));
  await until('terminal host connected',()=>page("return __deck.backend.machines.connection('at').get().status.kind==='connected'"));
  await page("__deck.backend.machines.connection('at').setStatus({kind:'reconnecting',attempt:1,reason:'smoke terminal offline',retryAt:0});return true;");
  await until('offline terminal start disabled',()=>page(`return ${pane('server-terminal')}.querySelector('.terminal-stopped .primary').disabled`));
  await page("__deck.backend.machines.connection('at').setStatus({kind:'connected',hostId:'fixture'});return true;");
  await until('terminal start available',()=>page(`return !${pane('server-terminal')}.querySelector('.terminal-stopped .primary').disabled`));
  await page(`${pane('server-terminal')}.querySelector('.terminal-stopped .primary').click();return true;`);
  await until('terminal is running',()=>page(`return !${pane('server-terminal')}.querySelector('.terminal-stopped')&&!${pane('server-terminal')}.querySelector('.terminal-bar')`));
  await until('PTY spawned',()=>page("return __deck.backend.machines.get('at').ptyResize('server-terminal:1',80,24).then(()=>true,()=>false)"));
  const terminalOutput=()=>page(`return ${pane('server-terminal')}.querySelector('.xterm-screen').innerText`);
  await page("await __deck.backend.machines.get('at').ptyWrite('server-terminal:1','echo before-gap-$((41+1))\\n');return true;");
  await until('terminal output before gap',async()=>String(await terminalOutput()).includes('before-gap-42'));
  await page("__deck.backend.machines.connection('at').setStatus({kind:'resync'});return true;");
  await until('terminal reattached after gap',async()=>String(await terminalOutput()).includes('Reconnected to the running terminal'));
  // This state was injected rather than issued by DaemonClient's handshake,
  // so complete its matching connected notification explicitly.
  await page("__deck.backend.machines.connection('at').setStatus({kind:'connected',hostId:'fixture'});return true;");
  assert.equal(await page(`return Boolean(${pane('server-terminal')}.querySelector('.terminal-bar'))`),false);
  await page("await __deck.backend.machines.get('at').ptyWrite('server-terminal:1','echo after-gap-$((41+2))\\n');return true;");
  await until('same terminal output after gap',async()=>String(await terminalOutput()).includes('after-gap-43'));
  await shot('terminal-reattached');
  // A terminal that ends while the link is down must become exited on return.
  // Missing-PTY probing without an exit event is covered by the unit regression.
  await page("__deck.backend.machines.connection('at').setStatus({kind:'reconnecting',attempt:1,reason:'smoke gap',retryAt:0});return true;");
  fs.writeFileSync(path.join(root,'offline'),'1');process.kill(Number(fs.readFileSync(path.join(root,'attach.pid'),'utf8')),'SIGTERM');
  const {DaemonClient}=await import('../src/daemon/client.ts');
  const {socketLink}=await import('../tests/e2e/link.mjs');
  const control=new DaemonClient(()=>socketLink(path.join(root,'server','daemon.sock')));
  try {await control.start();await control.call('pty_kill',{id:'server-terminal:1'});} finally {control.close();}
  fs.unlinkSync(path.join(root,'offline'));await page("__deck.backend.machines.connection('at').retryNow();return true;");
  await until('terminal link resumed',()=>page("return __deck.backend.machines.connection('at').get().status.kind==='connected'"));
  await page("__deck.backend.machines.connection('at').setStatus({kind:'resync'});return true;");
  await until('completed PTY recorded as exited',()=>page(`return Boolean(${pane('server-terminal')}.querySelector('.terminal-bar'))`));
  await shot('terminal-exited-after-drop');
  // Stage 2: Edit connection… from the project menu. A server stays one machine.
  // The terminal checks above injected a resync without its connected notification; complete it.
  await page("__deck.backend.machines.connection('at').setStatus({kind:'connected',hostId:'fixture'});return true;");
  await page('document.querySelector(".section-button.threads").click();return true;');
  const hostsFile=path.join(root,'mac-desktop','hosts.json');
  const savedHost=()=>JSON.parse(fs.readFileSync(hostsFile,'utf8')).hosts[0];
  const field=(name,value)=>page(`const input=document.querySelector('.connection-dialog [data-field="${name}"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}));return true;`);
  const act=name=>page(`document.querySelector('.connection-dialog [data-act="${name}"]').click();return true;`);
  await until('server project row',()=>page(`return Boolean(document.querySelector('${serverRow} [aria-haspopup=menu]'))`));
  await page(`document.querySelector('${serverRow} [aria-haspopup=menu]').click();return true;`);
  await page('[...document.querySelectorAll(".pane-menu [role=menuitem]")].find(b=>b.textContent.startsWith("Edit connection")).click();return true;');
  await until('edit connection dialog',()=>page('return Boolean(document.querySelector(".connection-dialog"))'));
  assert.equal(await page('return document.querySelector(\'.connection-dialog [data-field="command"]\').value'),savedHost().command);
  await field('ssh','fixture-alias');
  assert.equal(await page('return Boolean(document.querySelector(".connection-dialog .conn-retarget"))'),true);
  await act('test');
  await until('same machine',()=>page('return document.querySelector(".connection-dialog .conn-test.ok")?.textContent.includes("same machine")'));
  await shot('edit-connection-same');
  await field('ssh','other-fixture');
  await act('save');
  await until('different machine refused',()=>page('return Boolean(document.querySelector(\'.connection-dialog [data-act="instead"]\'))'));
  assert.match(await page('return document.querySelector(".connection-dialog .conn-test").textContent'),/different machine/);
  assert.equal(savedHost().ssh,'fixture');
  await shot('edit-connection-different');
  await field('ssh','fixture-alias');
  await field('name','This Mac');
  assert.equal(await page('return document.querySelector(\'.connection-dialog [data-act="save"]\').disabled'),true);
  assert.match(await page('return document.querySelector(".connection-dialog .conn-taken").textContent'),/already called This Mac/);
  await field('name','Frankfurt');
  await act('save');
  await until('saved after the same-machine check',()=>savedHost().ssh==='fixture-alias'&&savedHost().name==='Frankfurt');
  assert.equal(savedHost().command,JSON.parse(fs.readFileSync(hostsFile,'utf8')).hosts[0].command);
  await until('dialog closed and renamed in the sidebar',()=>page(`return !document.querySelector('.connection-dialog')&&document.querySelector('${serverRow} .host-name').textContent==='Frankfurt'`));
  // Archive: the thread leaves every list and the canvas, then comes back from Archived.
  await page(`document.querySelector('${macPinned} [aria-haspopup=menu]').click();return true;`);
  await page('[...document.querySelectorAll(".pane-menu [role=menuitem]")].find(b=>b.textContent.startsWith("Archive")).click();return true;');
  await until('archived',()=>page('return !document.querySelector(\'.pane-row[data-pane-row="mac-thread"]\')&&document.querySelector(".rail-foot")?.textContent.includes("Archived (1)")'));
  assert.equal(await page(`return ${pane('mac-thread')}.offsetWidth`),0);
  await until('archive saved',async()=>(await page('return await __deck.backend.sessionLoad()')).panes.find(p=>p.id==='mac-thread').archived===true);
  await shot('sidebar-archived');
  await page('document.querySelector(\'[aria-label="Show archived threads"]\').click();return true;');
  await page('[...document.querySelectorAll(".pane-menu [role=menuitem]")].find(b=>b.textContent.startsWith("Mac thread")).click();return true;');
  await until('restored and open',()=>page(`return Boolean(document.querySelector('.pane-row[data-pane-row="mac-thread"]'))&&${pane('mac-thread')}.offsetWidth>0&&!(document.querySelector(".rail-foot")?.textContent??"").includes("Archived")`));
  // Two copies of a project on one server: each row says which folder it is.
  await page('document.querySelector("[data-add-workspace]").click();return true;');
  await until('machine menu',()=>page('return Boolean(document.querySelector(\'[data-machine-menu] [data-host-id="at"]\'))'));
  await page('document.querySelector(\'[data-machine-menu] [data-host-id="at"]\').click();return true;');
  await until('server folder picker',()=>page('return document.querySelector(".path-prompt .folder-list")?.getAttribute("aria-busy")==="false"'));
  const second=path.join(root,'work');
  await page(`const input=document.querySelector('.path-prompt .folder-bar input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(second)});input.dispatchEvent(new Event('input',{bubbles:true}));return true;`);
  await page(`document.querySelector('.path-prompt .folder-bar input').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));return true;`);
  // The server names the folder as it resolves it (/tmp is /private/tmp on macOS).
  const listed=await until('in the second folder',()=>page(`const label=document.querySelector('.path-prompt .folder-list')?.getAttribute('aria-label')??'';return label.endsWith(${JSON.stringify(path.basename(root)+'/work')})&&label.slice(3);`));
  await page('document.querySelector(".path-prompt button[type=submit]").click();return true;');
  await until('second server project',()=>page(`return document.querySelectorAll('${serverRow}').length===2`));
  await page(`[...document.querySelectorAll('${serverRow}')].find(r=>r.querySelector('.ws-title')?.textContent==='work').querySelector('[aria-haspopup=menu]').click();return true;`);
  await page('[...document.querySelectorAll(".pane-menu [role=menuitem]")].find(b=>b.textContent.startsWith("Edit…")).click();return true;');
  await until('rename field',()=>page('return Boolean(document.querySelector(".ws-row .thread-name-input"))'));
  await page(`const input=document.querySelector('.ws-row .thread-name-input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'Server thread');input.dispatchEvent(new Event('input',{bubbles:true}));return true;`);
  await page(`document.querySelector('.ws-row .thread-name-input').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));return true;`);
  await until('each copy shows its folder',()=>page(`return [...document.querySelectorAll('${serverRow} .twin')].map(t=>t.textContent).sort().join('|')===${JSON.stringify([serverCopy,listed].sort().join('|'))}`));
  // Pin acts on the row it was chosen from: the second copy moves to the top of Projects.
  await page(`[...document.querySelectorAll('${serverRow}')].find(r=>r.querySelector('.twin')?.textContent===${JSON.stringify(listed)}).querySelector('[aria-haspopup=menu]').click();return true;`);
  await page('[...document.querySelectorAll(".pane-menu [role=menuitem]")].find(b=>b.textContent==="Pin").click();return true;');
  await until('pinned copy leads Projects',()=>page(`return document.querySelector('[data-sec=projects] ~ .ws .twin')?.textContent===${JSON.stringify(listed)}`));
  await shot('sidebar-two-copies');

  // Stage 3: an unstarted thread goes where it's pointed, with its text and its bots.
  const macProjectId='shared-workspace-id';
  // Threads go to the small work folder on the server (its project id is new, so read it from the session).
  const serverProject=await page(`return (await __deck.backend.sessionLoad()).workspaces.find(w=>w.hostId==='at'&&w.path.endsWith('/work')).id`);
  const paneIds=()=>page('return [...document.querySelectorAll(".pane")].map(p=>p.dataset.paneId)');
  const newDraft=async()=>{
    const known=await paneIds();
    await page('document.querySelector(\'.ws-row[data-host-id="local"] [aria-label^="New thread in"]\').click();return true;');
    const id=await until('a new thread',async()=>(await paneIds()).find(x=>!known.includes(x)));
    await until('its room open on the Mac',()=>page(`return ${pane(id)}.offsetWidth>0&&await __deck.backend.roomState(${JSON.stringify(id)}).then(()=>true,()=>false)`));
    return id;
  };
  const projectMenu=async rowSel=>{
    await page(`document.querySelector('${rowSel} [aria-haspopup=menu]').click();return true;`);
    await page('[...document.querySelectorAll(".pane-menu [role=menuitem]")].find(b=>b.querySelector(".label")?.textContent==="Project").click();return true;');
    await until('project submenu',()=>page(`return Boolean(document.querySelector('.pane-submenu [data-key="${serverProject}"]'))`));
  };
  const draft=await newDraft();
  await page(`await __deck.backend.roomAddParticipant(${JSON.stringify(draft)},{id:'bot',display_name:'Bot',backend:{kind:'cli',program:'sh',args:['-c','echo moved-reply']}});return true;`);
  await type(draft,'@bot hello there');
  await projectMenu(`.pane-row[data-pane-row="${draft}"]`);
  assert.match(await page('return document.querySelector(".pane-submenu .menu-note").textContent'),/hasn't started/);
  await page(`document.querySelector('.pane-submenu [data-key="${serverProject}"]').click();return true;`);
  await until('the thread moved to the server',()=>page(`return ${pane(draft)}.dataset.hostId==='at'`));
  await until('it reopened there with its bot',()=>page(`return [...${pane(draft)}.querySelectorAll('.composer .chip')].some(c=>c.textContent.includes('Bot'))&&!${pane(draft)}.querySelector('[aria-label="Add bot"]').disabled`));
  assert.equal(await page(`return ${pane(draft)}.querySelector('textarea').value`),'@bot hello there');
  await assert.rejects(page(`return await __deck.backend.roomState(${JSON.stringify(draft)})`));
  await send(draft,'@bot hello there');
  await until('the moved thread answers on the server',()=>page(`return ${pane(draft)}.querySelector('.transcript').innerText.includes('moved-reply')`));
  await shot('moved-to-server');
  // A started thread stays: pointing it elsewhere asks New thread or Fork, and Fork carries the history.
  await projectMenu(macPinned);
  assert.match(await page('return document.querySelector(".pane-submenu .menu-note").textContent'),/stays on This Mac/);
  await page(`document.querySelector('.pane-submenu [data-key="${serverProject}"]').click();return true;`);
  await until('the New thread / Fork question',()=>page(`return Boolean(${pane('mac-thread')}.querySelector('.move-ask'))`));
  assert.match(await page(`return ${pane('mac-thread')}.querySelector('.move-ask').textContent`),/runs on This Mac and stays there/);
  await shot('move-ask');
  const before=await paneIds();
  await page(`${pane('mac-thread')}.querySelector('[data-act="ask-fork"]').click();return true;`);
  const forked=await until('a fork on the server',async()=>(await paneIds()).find(x=>!before.includes(x)));
  await until('the fork has the history and says where it came from',()=>page(`const p=${pane(forked)};return p.dataset.hostId==='at'&&p.querySelector('.transcript').innerText.includes('mac-native-reply')&&(p.querySelector('.fork-line')?.textContent??'').includes('Forked from “Mac thread” on This Mac')&&p.querySelector('.fork-line').textContent.includes('nothing runs until you send')`));
  assert.equal(await page(`return ${pane('mac-thread')}.dataset.hostId`),'local');
  assert.equal(await page(`return Boolean(${pane('mac-thread')}.querySelector('.move-ask'))`),false);
  await shot('fork-to-server');
  // An offline server can't be picked for a thread. Every attach to it ends (probes rewrote attach.pid).
  fs.writeFileSync(path.join(root,'offline'),'1');
  const {execFileSync}=await import('node:child_process');
  for (const line of execFileSync('ps',['-ax','-o','pid=,command=']).toString().split('\n'))
    if (line.includes('--attach') && line.includes(path.join(root,'server'))) { try { process.kill(Number(line.trim().split(/\s+/)[0]),'SIGTERM'); } catch {} }
  await until('server offline',()=>page("return __deck.backend.machines.connection('at').get().status.kind!=='connected'"));
  const third=await newDraft();
  await projectMenu(`.pane-row[data-pane-row="${third}"]`);
  assert.equal(await page(`return document.querySelector('.pane-submenu [data-key="${serverProject}"]').disabled`),true);
  assert.match(await page(`return document.querySelector('.pane-submenu [data-key="${serverProject}"]').title`),/can't be reached/);
  await page('document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}));return true;');
  fs.unlinkSync(path.join(root,'offline'));await page("__deck.backend.machines.connection('at').retryNow();return true;");
  await until('server back',()=>page("return __deck.backend.machines.connection('at').get().status.kind==='connected'"));

  // Stage 3: the Work bar above every thread's message box.
  const tray=id=>`${pane(id)}.querySelector('.tray')`;
  assert.equal(await page(`return ${tray('mac-thread')}.querySelector('.tray-chip.proj .pname').textContent`),'Mac thread');
  assert.equal(await page(`return Boolean(${tray('mac-thread')}.querySelector('.tray-chip.work .lock'))`),true,'a started thread shows the lock');
  assert.equal(await page(`return ${tray('server-thread')}.querySelector('.tray-chip.work .lbl').textContent`),'Frankfurt');
  // An empty thread asks what to work on; its project name opens the picker.
  const fresh=await newDraft();
  assert.match(await page(`return ${pane(fresh)}.querySelector('.empty .ask').textContent`),/What should we work on in Mac thread\?/);
  assert.match(await page(`return ${pane(fresh)}.querySelector('.empty .where').textContent`),/^On This Mac · /);
  assert.equal(await page(`return Boolean(${tray(fresh)}.querySelector('.tray-chip.work .lock'))`),false);
  await page(`${pane(fresh)}.querySelector('.empty .pick-name').click();return true;`);
  await until('project picker',()=>page(`return Boolean(document.querySelector('.tray-pop.picker input'))`));
  assert.equal(await page(`return document.querySelector('.tray-pop .pk-row[data-workspace="${macProjectId}"] .check')!==null`),true,'the current project has its ✓');
  await page(`const input=document.querySelector('.tray-pop.picker input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'/work');input.dispatchEvent(new Event('input',{bubbles:true}));return true;`);
  await until('search finds the server folder',()=>page(`const rows=[...document.querySelectorAll('.tray-pop.picker .pk-row[data-workspace]')];return rows.length===1&&rows[0].dataset.workspace===${JSON.stringify(serverProject)}`));
  await shot('work-bar-picker');
  await page(`document.querySelector('.tray-pop .pk-row[data-workspace="${serverProject}"]').click();return true;`);
  await until('picked project moves the empty thread',()=>page(`return ${pane(fresh)}.dataset.hostId==='at'&&${tray(fresh)}.querySelector('.tray-chip.work .lbl')?.textContent==='Frankfurt'`));
  // An older helper can't put a thread in another folder on its machine without deleting it
  // first, so it isn't asked to: the thread stays whole, and a new thread there is offered.
  await page("const b=__deck.backend.machines.get('at');window.__realImport=b.roomImport;b.roomImport=async()=>{throw Error('unknown variant `room_import`, expected one of `session_load`');};return true;");
  const serverOriginal='at:shared-workspace-id:1';
  await projectMenu(`.pane-row[data-pane-row="${fresh}"]`);
  await page(`document.querySelector('.pane-submenu [data-key="${serverOriginal}"]').click();return true;`);
  await until('an older helper asks instead of moving',()=>page(`return Boolean(${pane(fresh)}.querySelector('.move-ask'))`));
  assert.match(await page(`return ${pane(fresh)}.querySelector('.move-ask').textContent`),/too old to move a thread to another folder there/);
  assert.equal(await page(`return Boolean(${pane(fresh)}.querySelector('.move-ask [data-act="ask-fork"]'))`),false);
  await shot('old-helper-move-ask');
  assert.ok((await page(`return ${pane(fresh)}.querySelector('.pane-ws').title`)).endsWith(listed));
  assert.equal(JSON.parse(fs.readFileSync(path.join(root,'server','saved-chats-v1','rooms',`${Buffer.from(fresh).toString('hex')}.json`),'utf8')).cwd,listed);
  const beforeNew=await paneIds();
  await page(`${pane(fresh)}.querySelector('.move-ask [data-act="ask-new"]').click();return true;`);
  const opened=await until('a new thread in the other folder',async()=>(await paneIds()).find(x=>!beforeNew.includes(x)));
  await until('it opened in the other folder there',()=>page(`const p=${pane(opened)};return p.dataset.hostId==='at'&&p.querySelector('.pane-ws').title.endsWith(${JSON.stringify(serverCopy)})`));
  assert.equal(await page(`return Boolean(${pane(fresh)}.querySelector('.move-ask'))`),false);
  await page(`${pane(opened)}.querySelector('.pane-head [aria-label^="Close"]').click();return true;`);
  await until('the extra thread closed',()=>page(`return ${pane(opened)}.offsetWidth===0`));
  // Asked again, then a helper that can: one replace there moves it, and the question goes away.
  const pickOriginal=async()=>{await projectMenu(`.pane-row[data-pane-row="${fresh}"]`);await page(`document.querySelector('.pane-submenu [data-key="${serverOriginal}"]').click();return true;`);};
  await pickOriginal();
  await until('asked again',()=>page(`return Boolean(${pane(fresh)}.querySelector('.move-ask'))`));
  await page("__deck.backend.machines.get('at').roomImport=window.__realImport;return true;");
  await pickOriginal();
  await until('moved to the other folder there, without the question',()=>page(`const p=${pane(fresh)};return p.querySelector('.pane-ws').title.endsWith(${JSON.stringify(serverCopy)})&&!p.querySelector('.move-ask')`));
  assert.equal(JSON.parse(fs.readFileSync(path.join(root,'server','saved-chats-v1','rooms',`${Buffer.from(fresh).toString('hex')}.json`),'utf8')).cwd,serverCopy);
  await until('it reopened there',()=>page(`return !${pane(fresh)}.querySelector('[aria-label="Add bot"]')?.disabled`));
  // ⌥⇧⌘O opens the picker of the thread in use.
  await page(`${pane('mac-thread')}.dispatchEvent(new MouseEvent('mousedown',{bubbles:true}));return true;`);
  await page(`window.dispatchEvent(new KeyboardEvent('keydown',{code:'KeyO',key:'Ø',metaKey:true,altKey:true,shiftKey:true,bubbles:true,cancelable:true}));return true;`);
  await until('shortcut opens the picker',()=>page(`return Boolean(document.querySelector('.tray-pop.picker'))`));
  await page('document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}));return true;');
  await until('picker closed',()=>page(`return !document.querySelector('.tray-pop')`));
  // Work in lists every machine, one row per folder; the server row is the copy of this project there.
  await page(`${tray('mac-thread')}.querySelector('.tray-chip.work').click();return true;`);
  await until('Work in',()=>page(`return Boolean(document.querySelector('.tray-pop .work-menu'))`));
  const rows=await page(`return [...document.querySelectorAll('.tray-pop .work-menu [role=menuitemradio]')].map(r=>[r.dataset.hostId,r.dataset.workspace,r.getAttribute('aria-checked')])`);
  assert.deepEqual(rows,[['local',macProjectId,'true'],['at','at:shared-workspace-id:1','false']]);
  assert.match(await page(`return document.querySelector('.tray-pop .work-menu').textContent`),/This thread stays on This Mac/);
  assert.ok(await page(`return [...document.querySelectorAll('.tray-pop .work-menu [role=menuitem]')].some(b=>b.textContent.includes('Add server…'))`));
  await shot('work-in');
  await page('document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}));return true;');
  // Files: recent files from this Mac attach with a click.
  const readme=path.join(root,'work','README.md');
  await page(`__deck.recentFiles.remember(${JSON.stringify(readme)});return true;`);
  await page(`${tray('mac-thread')}.querySelector('.tray-chip.files').click();return true;`);
  await until('Files list',()=>page(`return [...document.querySelectorAll('.tray-pop.files .pk-row .nm')].some(n=>n.textContent==='README.md')`));
  await page(`[...document.querySelectorAll('.tray-pop.files .pk-row')].find(r=>r.querySelector('.nm')?.textContent==='README.md').click();return true;`);
  await until('file attached',()=>page(`return [...${pane('mac-thread')}.querySelectorAll('.attachments .attachment')].some(a=>a.textContent.includes('README.md')&&a.getAttribute('aria-busy')!=='true')&&${tray('mac-thread')}.querySelector('.tray-chip.files .count')?.textContent==='1'`));
  // Tools lists the bots' servers, apps and plugins here; these shell bots have none.
  await page(`${tray('server-thread')}.querySelector('.tray-chip.tools').click();return true;`);
  await until('Tools',()=>page(`return document.querySelector('.tray-pop.tools')?.textContent.includes('From the bots in this thread, on Frankfurt')`));
  await page('document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}));return true;');
  // Offline: the server's Work in row is disabled, and the current one keeps its ✓.
  fs.writeFileSync(path.join(root,'offline'),'1');
  for (const line of execFileSync('ps',['-ax','-o','pid=,command=']).toString().split('\n'))
    if (line.includes('--attach') && line.includes(path.join(root,'server'))) { try { process.kill(Number(line.trim().split(/\s+/)[0]),'SIGTERM'); } catch {} }
  await until('server offline again',()=>page("return __deck.backend.machines.connection('at').get().status.kind!=='connected'"));
  await page(`${tray('server-thread')}.querySelector('.tray-chip.work').click();return true;`);
  await until('Work in while offline',()=>page(`return Boolean(document.querySelector('.tray-pop .work-menu'))`));
  assert.deepEqual(await page(`const r=document.querySelector('.tray-pop .work-menu [data-host-id="at"]');return [r.disabled,r.getAttribute('aria-checked'),Boolean(r.querySelector('.check'))]`),[true,'true',true]);
  await shot('work-in-offline');
  await page('document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}));return true;');
  fs.unlinkSync(path.join(root,'offline'));await page("__deck.backend.machines.connection('at').retryNow();return true;");
  await until('server back again',()=>page("return __deck.backend.machines.connection('at').get().status.kind==='connected'"));

  // Stage 3: + New names where a new thread opens.
  await page(`${pane('mac-thread')}.dispatchEvent(new MouseEvent('mousedown',{bubbles:true}));return true;`);
  await page('document.querySelector(".new-menu > button").click();return true;');
  await until('New menu',()=>page('return Boolean(document.querySelector(".new-menu-list"))'));
  assert.match(await page('return document.querySelector(".new-menu-list").textContent'),/new thread in Mac thread on This Mac/);
  await page('document.querySelector(".new-menu-filter").dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}));return true;');
  // Long names in narrow panes: the project and the server stay, shortened, with their full names on hover.
  const renameProject=async(id,name)=>{
    await page(`document.querySelector('.ws-row [data-workspace="${id}"]').closest('.ws-row').querySelector('[aria-haspopup=menu]').click();return true;`);
    await page('[...document.querySelectorAll(".pane-menu [role=menuitem]")].find(b=>b.textContent.startsWith("Edit…")).click();return true;');
    await until('rename field',()=>page('return Boolean(document.querySelector(".ws-row .thread-name-input"))'));
    await page(`const input=document.querySelector('.ws-row .thread-name-input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(name)});input.dispatchEvent(new Event('input',{bubbles:true}));return true;`);
    await page(`document.querySelector('.ws-row .thread-name-input').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));return true;`);
  };
  await renameProject(serverProject,'apex-smoke-test-long-project');
  await page(`document.querySelector('${serverRow} [aria-haspopup=menu]').click();return true;`);
  await page('[...document.querySelectorAll(".pane-menu [role=menuitem]")].find(b=>b.textContent.startsWith("Edit connection")).click();return true;');
  await until('edit dialog again',()=>page('return Boolean(document.querySelector(".connection-dialog"))'));
  await field('name','Production-Frankfurt-Primary-01');
  await act('save');
  await until('long server name back',()=>page('return !document.querySelector(".connection-dialog")'));
  // A reply in a thread nobody is looking at flags its top line "New reply". The hidden smoke window may or
  // may not have focus, so the flag is made here, in a narrow pane that isn't the focused one.
  await page(`${pane('mac-thread')}.dispatchEvent(new MouseEvent('mousedown',{bubbles:true}));return true;`);
  await send(draft,'@bot one more');
  await until('a narrow pane flagged',()=>page(`return ${pane(draft)}.querySelector('.pane-head .flag')?.textContent==='New reply'`));
  const heads=await until('heads fitted',()=>page(`const out=[];for(const p of document.querySelectorAll('.pane')){if(!p.offsetWidth||!p.querySelector('.composer'))continue;const h=p.querySelector('.pane-head');const hr=h.getBoundingClientRect();const inside=el=>{if(!el||!el.offsetWidth)return false;const r=el.getBoundingClientRect();return r.left>=hr.left-1&&r.right<=hr.right+1;};const ws=h.querySelector('.pane-ws');const host=h.querySelector('.pane-host .hn');const buttons=[...h.querySelectorAll(':scope > .icon, :scope > .pane-menu-wrap')];const flag=h.querySelector('.flag');out.push({id:p.dataset.paneId,fit:h.dataset.fit,width:Math.round(hr.width),ws:inside(ws),short:ws&&getComputedStyle(ws.querySelector('.nm-short')).display!=='none'?ws.querySelector('.nm-short').textContent:'',host:p.dataset.hostId==='at'?{inside:inside(host),title:host?.closest('.pane-host').title}:null,flag:flag&&{shown:inside(flag),hidden:h.hasAttribute('data-flag-hidden'),dot:h.querySelector(':scope > .dot').title},buttons:buttons.every(inside)});}return out.length>=3&&out;`));
  await shot('narrow-headers');
  for (const h of heads) {
    assert.equal(h.ws,true,`project stays in ${h.id}`);
    assert.equal(h.buttons,true,`buttons stay in ${h.id}: ${JSON.stringify(h)}`);
    if (h.host) { assert.equal(h.host.inside,true,`server stays in ${h.id}`); assert.equal(h.host.title,'Production-Frankfurt-Primary-01'); }
  }
  const flagged=heads.find(h=>h.id===draft);
  assert.ok(flagged?.flag,`the narrow pane keeps its flag: ${JSON.stringify(flagged)}`);
  assert.ok(flagged.flag.shown||(flagged.flag.hidden&&flagged.flag.dot==='New reply'),`the flag shows, or gives way to the dot, which names it: ${JSON.stringify(flagged)}`);
  assert.ok(heads.some(h=>h.short==='apex…ject'),`a narrow head shortens the long project name: ${JSON.stringify(heads.map(h=>[h.fit,h.short]))}`);
  console.log(`multi-host: ${oldHelper?'old-helper fallback':'current helper'} passed; running terminal reattached and completed PTY exited`);
  console.log('multi-host: ok — replies after Clear, interrupted load retry, rejected/expired snapshot-card UI, isolated drop, daemon restart recovery, preserved draft, remote upload, no replay, import remap, removal protection and canvas restore');
  return 0;
}
