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
  await page('const row=[...document.querySelectorAll(".ws-row")].find(r=>r.textContent.includes("Server thread"));row.querySelector("[aria-haspopup=menu]").click();return true;');
  assert.equal(await page('return [...document.querySelectorAll("[role=menuitem]")].find(b=>b.textContent==="Open folder on server").disabled'),true);
  assert.match(await page('return [...document.querySelectorAll("[role=menuitem]")].find(b=>b.textContent==="Open folder on server").title'),/server folders/);
  await page('document.querySelector(".ws-row [aria-expanded=true]").click();return true;');
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
  win.webContents.reload();
  await until('canvas restored with both panes',()=>page(`return Boolean(window.__deck)&&[${pane('mac-thread')},${pane('server-thread')}].every(p=>p&&p.offsetWidth>0)`));
  assert.equal(fs.readFileSync(remoteSession,'utf8'),original);
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
  console.log(`multi-host: ${oldHelper?'old-helper fallback':'current helper'} passed; running terminal reattached and completed PTY exited`);
  console.log('multi-host: ok — replies after Clear, interrupted load retry, rejected/expired snapshot-card UI, isolated drop, daemon restart recovery, preserved draft, remote upload, no replay, import remap, removal protection and canvas restore');
  return 0;
}
