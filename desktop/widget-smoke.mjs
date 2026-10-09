// Real React, Electron, native browser and host commands; no component stand-ins.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function runSmoke(win, { browser }) {
  const page = code => win.webContents.executeJavaScript(`(async()=>{${code}})()`, true);
  const until = async (name, check, timeout = 25_000) => { const start = Date.now(); let error; while (Date.now()-start < timeout) { try { const value=await check(); if(value) return value; } catch(e) { error=e; } await sleep(60); } throw Error(`Timed out: ${name}${error ? ` (${error.message})` : ''}`); };
  let passed=0;
  const step=async(name,fn)=>{try {await fn();} catch(error) {console.error('widget diagnostics',await page('return document.body.innerText').catch(()=>''));await shot('failure').catch(()=>{});throw error;} passed++; console.log(`widget smoke: PASS ${name}`);};
  const click = selector => page(`const el=document.querySelector(${JSON.stringify(selector)}); if(!el) throw Error('Missing '+${JSON.stringify(selector)});el.click();return true;`);
  const clickText=(selector,text)=>page(`const el=[...document.querySelectorAll(${JSON.stringify(selector)})].find(e=>e.textContent.trim()===${JSON.stringify(text)});if(!el)throw Error('Missing '+${JSON.stringify(text)});el.click();return true;`);
  const type=(selector,text)=>page(`const el=document.querySelector(${JSON.stringify(selector)});if(!el)throw Error('Missing textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,${JSON.stringify(text)});el.dispatchEvent(new Event('input',{bubbles:true}));return true;`);
  const monitor=()=>page(`return await __deck.backend.call('monitor_get',{workspaceId:'launch'})`);
  const shot=async name=>{const directory=process.env.APEX_WIDGET_SCREENSHOTS; if(directory){fs.mkdirSync(directory,{recursive:true});fs.writeFileSync(path.join(directory,`${name}.png`),(await win.webContents.capturePage()).toPNG());}};
  await until('connected UI',()=>page(`return Boolean(window.__deck&&!document.querySelector('.loading')&&document.querySelector('.apex-widget-hit'))`));
  await until('saved projects loaded',()=>page(`return Boolean(document.querySelector('[data-workspace="launch"]'))`)).catch(async error=>{console.error('startup diagnostics',await page('return {text:document.body.innerText,session:await __deck.backend.sessionLoad()}'));throw error;});
  win.setSize(1200,850); win.show(); win.focus(); await sleep(150);
  await step('keyboard opens the persistent assistant',async()=>{
    await page(`window.__widgetKeys=[];window.addEventListener('keydown',e=>__widgetKeys.push({key:e.key,code:e.code,defaultPrevented:e.defaultPrevented}));document.querySelector('.apex-widget-hit').focus();return true;`);
    await sleep(100);
    win.webContents.sendInputEvent({type:'keyDown',keyCode:'Return'});win.webContents.sendInputEvent({type:'char',keyCode:'\r'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Return'});
    await until('conversation',()=>page(`return Boolean(document.querySelector('.apex-agent-setup-form'))`)).catch(async error=>{console.error('keyboard diagnostics',await page(`return {keys:__widgetKeys,focus:document.activeElement?.outerHTML}`));throw error;});
    assert.equal(await page(`return document.querySelector('.apex-agent').getAttribute('aria-modal')`),null);
    await shot('setup');
  });
  let original;
  await step('chat-first responsibility collects approved evidence and reports SSO',async()=>{
    await until('suggested sources',()=>page(`return document.querySelector('.apex-agent-chips')?.textContent.includes('test-report.md')`));
    await type('[aria-label="Responsibility for ApexAgent"]','Keep the November 1 launch on track; flag unmet release requirements.');
    await clickText('.apex-agent-setup-form button','Assign responsibility');
    original=await until('saved assignment',monitor);
    await until('evidence-backed finding',async()=>{const m=await monitor();return !m.activeCheck&&m.findings.some(f=>f.status==='open');});
    await click('.apex-widget-header [aria-label="Close ApexAgent"]');await sleep(100);await click('.apex-widget-hit');
    await until('finding in real chat',()=>page(`return document.querySelector('.apex-agent-findings')?.textContent.includes('SSO blocks')`));
    assert.equal((await monitor()).conversationId,original.conversationId);
    const composer=await page(`const c=document.querySelector('.apex-agent-composer').getBoundingClientRect(),p=document.querySelector('.apex-widget-panel').getBoundingClientRect();return {top:c.top,bottom:c.bottom,panelBottom:p.bottom};`);
    assert.ok(composer.bottom<=composer.panelBottom&&composer.top>0,'The reply composer stays visible while findings scroll');
    await shot('blocker');
  });
  await step('reading and closing chat leave avatar and sidebar blocker visible',async()=>{
    await click('.apex-widget-header [aria-label="Close ApexAgent"]');
    await until('durable badge',()=>page(`return document.querySelector('.apex-widget-count')?.textContent==='1'&&document.querySelector('.flag-count.needs_input')?.textContent==='1'`));
    assert.match(await page(`return document.querySelector('.apex-widget-bubble')?.textContent??''`),/SSO blocks/);
    await shot('closed-blocker');
  });
  await step('page changes retain the same assignment and avatar',async()=>{
    await page(`window.dispatchEvent(new KeyboardEvent('keydown',{code:'Digit1',key:'1',metaKey:true,bubbles:true}));return true;`);
    await until('Agents page',()=>page(`return Boolean(document.querySelector('.agents-section'))`));
    assert.equal(await page(`return document.querySelectorAll('.apex-widget-hit').length`),1);
    await click('.apex-widget-hit');await until('conversation ready',()=>page(`return Boolean(document.querySelector('.apex-agent-composer'))`));
    assert.equal((await monitor()).conversationId,original.conversationId);
  });
  await step('drop adds one source without replacing the assignment',async()=>{
    const cwd=(await monitor()).cwd;
    await page(`const dt=new DataTransfer();dt.setData('application/x-apex-agent-source',JSON.stringify({workspaceId:'launch',hostId:'local',cwd:${JSON.stringify(cwd)},kind:'file',sourceId:'CHANGELOG.md'}));document.querySelector('[data-apex-agent-overlay="avatar"]').dispatchEvent(new DragEvent('drop',{bubbles:true,dataTransfer:dt}));return true;`);
    const m=await until('saved source',async()=>{const m=await monitor();return m.files.includes('CHANGELOG.md')&&m;});
    assert.equal(m.conversationId,original.conversationId);assert.equal(m.files.filter(f=>f==='CHANGELOG.md').length,1);
    assert.ok(m.messages.length>=original.messages.length);
  });
  await step('redirect continues the same assignment and produces a revised plan',async()=>{
    await type('[aria-label="Message ApexAgent"]','Defer SSO, keep November 1, and draft the revised plan.');
    await clickText('.apex-agent-composer button','Send');
    const m=await until('redirect result',async()=>{const m=await monitor();return !m.activeCheck&&m.messages.some(msg=>msg.role==='assistant'&&msg.text.includes('Revised plan'))&&m;});
    assert.equal(m.conversationId,original.conversationId);assert.ok(m.messages.some(msg=>msg.role==='human'&&msg.text.startsWith('Defer SSO')));
    // Reopen to receive the new snapshot immediately rather than waiting for the display poll.
    await click('.apex-widget-header [aria-label="Close ApexAgent"]');await sleep(100);await click('.apex-widget-hit');
    await until('redirect in chat',()=>page(`return document.querySelector('.apex-agent-transcript')?.textContent.includes('Revised plan')`));await shot('redirect');
  });
  await step('explicit resolution clears badges and Check now does not reopen settled SSO',async()=>{
    await clickText('.apex-agent-findings button','Resolve');
    await until('resolved',async()=>!(await monitor()).findings.some(f=>f.status==='open'));
    await clickText('.apex-agent-tabs button','Activity');
    const before=(await monitor()).lastCheckedAt;
    await clickText('.apex-agent-buttons button','Check now');
    const m=await until('check now finished',async()=>{const m=await monitor();return !m.activeCheck&&m.lastCheckedAt>before&&m;});
    assert.equal(m.findings.filter(f=>f.status==='open').length,0);
    await until('resolved badges',()=>page(`return !document.querySelector('.apex-widget-count')&&!document.querySelector('.flag-count.needs_input')`));
  });
  await step('drag/arrow positioning stays inside a narrow viewport',async()=>{
    await click('.apex-widget-header [aria-label="Close ApexAgent"]');win.setMinimumSize(320,500);win.setSize(420,700);await sleep(300);
    await page(`document.querySelector('.apex-widget-hit').focus();return true;`);
    win.webContents.sendInputEvent({type:'keyDown',keyCode:'Right'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Right'});
    await click('.apex-widget-hit');await sleep(200);
    const bounds=await page(`const r=document.querySelector('.apex-widget-panel').getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,w:innerWidth,h:innerHeight};`);
    assert.ok(bounds.left>=0&&bounds.right<=bounds.w&&bounds.top>=0&&bounds.bottom<=bounds.h,JSON.stringify(bounds));
    assert.ok(bounds.w <= 420, 'The responsive check must actually use a narrow viewport');
    assert.ok(await page(`const c=document.querySelector('.apex-agent-composer').getBoundingClientRect();return c.top>0&&c.bottom<=innerHeight;`),'The reply composer stays visible on narrow windows');
    await shot('narrow');win.setSize(1200,850);await sleep(200);
  });
  await step('docked browser stays live with avatar and yields to overlapping assistant',async()=>{
    await click('.apex-widget-header [aria-label="Close ApexAgent"]');
    await page(`const s=await __deck.backend.sessionLoad();await __deck.backend.sessionSave({...s,section:'code',activeWorkspace:'launch',focusedPane:'widget-browser',panes:[{id:'widget-browser',kind:'preview',title:'Browser',workspaceId:'launch',url:${JSON.stringify(process.env.APEX_WIDGET_SITE)}}]});return true;`);
    win.webContents.reload();await until('UI reloaded',()=>page(`return Boolean(window.__deck&&!document.querySelector('.loading'))`));
    await until('live native browser',()=>browser.inspect('widget-browser')?.shown);
    await click('.apex-widget-hit');
    await until('assistant open',()=>page(`return Boolean(document.querySelector('.apex-widget-panel'))`));
    const rects=await page(`const p=document.querySelector('.apex-widget-panel').getBoundingClientRect(),b=document.querySelector('.browser-place').getBoundingClientRect();return {overlap:Math.min(p.right,b.right)-Math.max(p.left,b.left)>0&&Math.min(p.bottom,b.bottom)-Math.max(p.top,b.top)>0};`);
    if(rects.overlap) await until('browser snapshot while assistant overlaps',()=>!browser.inspect('widget-browser')?.shown,5000);
    await shot('browser');
  });
  console.log(`widget smoke: ${passed} passed, 0 failed`);
  return 0;
}
