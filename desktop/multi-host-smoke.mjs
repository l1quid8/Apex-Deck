import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { BrowserWindow } from 'electron';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
export async function runMultiHostSmoke(win) {
  // Keep xterm rendering and UI timers active in the hidden test window.
  win.webContents.setBackgroundThrottling(false);
  const root=process.env.APEX_DECK_MULTI_HOST_ROOT;
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
  assert.ok((await page('return document.querySelector(".hover-card").innerText')).includes(root));
  await shot('sidebar-project-card');
  await unhover(`${serverRow} .ws-name`);
  await until('project card closes',()=>page('return !document.querySelector(".hover-card")'));
  const serverPinned='.pane-row.flat[data-pane-row="server-thread"]';
  await page(`document.querySelector('${serverPinned} [aria-haspopup=menu]').click();return true;`);
  const menuLabels=()=>page('return [...document.querySelectorAll(".pane-menu [role=menuitem]")].map(b=>b.querySelector(".label")?.textContent??b.textContent).join("|")');
  assert.equal(await menuLabels(),'Rename|Unpin|Mark as unread|Share as PDF|Copy|Fork|Export|Archive|Delete…');
  assert.equal(await page('return [...document.querySelectorAll(".pane-menu [role=menuitem] .keys")].map(k=>k.textContent).join()'),'⌥⌘R,⌥⌘P,⇧⌘U,⇧⌘A');
  await page('[...document.querySelectorAll(".pane-menu [role=menuitem]")].find(b=>b.textContent.startsWith("Copy")).click();return true;');
  await until('copy submenu',()=>page('return document.querySelectorAll(".pane-submenu [role=menuitem]").length===4'));
  assert.equal(await page('return [...document.querySelectorAll(".pane-submenu [role=menuitem] .sub")].map(s=>s.textContent).join("|")'),`fixture:${root}|server-thread`);
  await shot('sidebar-thread-menu-copy');
  await page('document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}));return true;');
  await until('menu closed',()=>page('return !document.querySelector(".pane-menu")'));
  await page(`document.querySelector('${serverPinned}').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:120,clientY:140}));return true;`);
  await until('right-click menu',async()=>(await menuLabels())==='Rename|Unpin|Mark as unread|Share as PDF|Copy|Fork|Export|Archive|Delete…');
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
  await until('server folder copied with its destination',()=>page(`return window.__copied.includes(${JSON.stringify('fixture:'+root)})`));
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
  const second=path.join(root,'server');
  await page(`const input=document.querySelector('.path-prompt .folder-bar input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(second)});input.dispatchEvent(new Event('input',{bubbles:true}));return true;`);
  await page(`document.querySelector('.path-prompt .folder-bar input').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));return true;`);
  // The server names the folder as it resolves it (/tmp is /private/tmp on macOS).
  const listed=await until('in the second folder',()=>page(`const label=document.querySelector('.path-prompt .folder-list')?.getAttribute('aria-label')??'';return label.endsWith(${JSON.stringify(path.basename(root)+'/server')})&&label.slice(3);`));
  await page('document.querySelector(".path-prompt button[type=submit]").click();return true;');
  await until('second server project',()=>page(`return document.querySelectorAll('${serverRow}').length===2`));
  await page(`[...document.querySelectorAll('${serverRow}')].find(r=>r.querySelector('.ws-title')?.textContent==='server').querySelector('[aria-haspopup=menu]').click();return true;`);
  await page('[...document.querySelectorAll(".pane-menu [role=menuitem]")].find(b=>b.textContent.startsWith("Edit…")).click();return true;');
  await until('rename field',()=>page('return Boolean(document.querySelector(".ws-row .thread-name-input"))'));
  await page(`const input=document.querySelector('.ws-row .thread-name-input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'Server thread');input.dispatchEvent(new Event('input',{bubbles:true}));return true;`);
  await page(`document.querySelector('.ws-row .thread-name-input').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));return true;`);
  await until('each copy shows its folder',()=>page(`return [...document.querySelectorAll('${serverRow} .twin')].map(t=>t.textContent).sort().join('|')===${JSON.stringify([root,listed].sort().join('|'))}`));
  // Pin acts on the row it was chosen from: the second copy moves to the top of Projects.
  await page(`[...document.querySelectorAll('${serverRow}')].find(r=>r.querySelector('.twin')?.textContent===${JSON.stringify(listed)}).querySelector('[aria-haspopup=menu]').click();return true;`);
  await page('[...document.querySelectorAll(".pane-menu [role=menuitem]")].find(b=>b.textContent==="Pin").click();return true;');
  await until('pinned copy leads Projects',()=>page(`return document.querySelector('[data-sec=projects] ~ .ws .twin')?.textContent===${JSON.stringify(listed)}`));
  await shot('sidebar-two-copies');
  console.log(`multi-host: ${oldHelper?'old-helper fallback':'current helper'} passed; running terminal reattached and completed PTY exited`);
  console.log('multi-host: ok — replies after Clear, interrupted load retry, rejected/expired snapshot-card UI, isolated drop, daemon restart recovery, preserved draft, remote upload, no replay, import remap, removal protection and canvas restore');
  return 0;
}
