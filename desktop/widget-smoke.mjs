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
  const reveal=async selector=>{const rect=await page(`const el=document.querySelector(${JSON.stringify(selector)});if(!el)throw Error('Missing '+${JSON.stringify(selector)});el.scrollIntoView({block:'center',inline:'nearest'});const r=el.getBoundingClientRect();return {top:r.top,bottom:r.bottom,left:r.left,right:r.right,width:r.width,height:r.height,viewportWidth:innerWidth,viewportHeight:innerHeight};`);assert.ok(rect.width>0&&rect.height>0&&rect.top>=0&&rect.bottom<=rect.viewportHeight&&rect.left>=0&&rect.right<=rect.viewportWidth,`${selector} can be fully brought into view: ${JSON.stringify(rect)}`);return rect;};
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
    const profile=await page(`const select=document.querySelector('[aria-label="ApexAgent profile"]');return select&&{value:select.value,options:[...select.options].map(option=>({value:option.value,text:option.textContent.trim()}))}`);
    assert.ok(profile&&profile.options.some(option=>option.text==='Widget test model')&&profile.options.some(option=>option.text==='Widget alternate model'),`The profile picker shows both local test profiles: ${JSON.stringify(profile)}`);
    const originalProfile=profile.value;
    const alternateProfile=profile.options.find(option=>option.text==='Widget alternate model').value;
    await page(`const select=document.querySelector('[aria-label="ApexAgent profile"]');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(select,${JSON.stringify(alternateProfile)});select.dispatchEvent(new Event('change',{bubbles:true}));return true;`);
    await until('alternate profile selection',()=>page(`return document.querySelector('[aria-label="ApexAgent profile"]')?.value===${JSON.stringify(alternateProfile)}`));
    await page(`const select=document.querySelector('[aria-label="ApexAgent profile"]');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(select,${JSON.stringify(originalProfile)});select.dispatchEvent(new Event('change',{bubbles:true}));return true;`);
    await until('original profile selection',()=>page(`return document.querySelector('[aria-label="ApexAgent profile"]')?.value===${JSON.stringify(originalProfile)}`));
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
    const composer=await page(`const c=document.querySelector('.assistant-request').getBoundingClientRect(),p=document.querySelector('.apex-widget-panel').getBoundingClientRect();return {top:c.top,bottom:c.bottom,panelBottom:p.bottom,viewport:innerHeight};`);
    assert.ok(composer.top<composer.viewport&&composer.bottom>0&&composer.bottom>composer.top,`The task request form intersects the viewport while findings scroll: ${JSON.stringify(composer)}`);
    await shot('blocker');
  });
  await step('a direct answer leaves the periodic responsibility and finding in place',async()=>{
    const before=await monitor();
    await reveal('.assistant-request textarea');
    await type('.assistant-request textarea','Why is SSO still blocking the November 1 release?');
    await reveal('.assistant-request button');
    await clickText('.assistant-request button','Send message');
    await until('direct answer',()=>page(`return document.querySelector('.assistant-task-response')?.textContent.includes('kept that responsibility active')`));
    const after=await monitor();
    assert.equal(after.conversationId,before.conversationId);
    assert.equal(after.responsibility,before.responsibility);
    assert.equal(after.profileId,before.profileId);
    assert.equal(after.paused,false);
    assert.ok(after.nextCheckAt,'The periodic check remains scheduled');
    assert.deepEqual(after.findings.filter(f=>f.status==='open').map(f=>f.summary),before.findings.filter(f=>f.status==='open').map(f=>f.summary));
    await shot('direct-answer');
  });
  await step('changing the assigned profile preserves responsibility, sources, and history',async()=>{
    const before=await monitor();
    await clickText('.apex-agent-tabs button','Settings');
    const picker=await page(`const select=document.querySelector('[aria-label="Saved profile"]');return select&&[...select.options].map(option=>({value:option.value,text:option.textContent.trim()}))`);
    const alternate=picker?.find(option=>option.text==='Widget alternate model');
    assert.ok(alternate,`The alternate saved profile is available: ${JSON.stringify(picker)}`);
    await page(`const select=document.querySelector('[aria-label="Saved profile"]');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(select,${JSON.stringify(alternate.value)});select.dispatchEvent(new Event('change',{bubbles:true}));return true;`);
    const after=await until('updated assigned profile',async()=>{const current=await monitor();return current.profileId===alternate.value&&current;});
    assert.equal(after.conversationId,before.conversationId);
    assert.equal(after.responsibility,before.responsibility);
    assert.deepEqual(after.files,before.files);
    assert.deepEqual(after.messages.map(({role,text})=>({role,text})),before.messages.map(({role,text})=>({role,text})));
    await clickText('.apex-agent-tabs button','Chat');
  });
  await step('a clarification request appears as a native task card',async()=>{
    await type('.assistant-request textarea','Please create an implementation task for the SSO test setup.');
    await clickText('.assistant-request button','Send message');
    const card=await until('clarification task card',()=>page(`const card=document.querySelector('.assistant-task-card.status-needs_clarification');return card?.innerText??''`));
    assert.match(card,/create an implementation task/i);
    assert.match(await page(`return document.querySelector('.assistant-task-response')?.textContent??''`),/Which existing chat should receive this implementation task/);
    assert.ok(await page(`return Boolean(document.querySelector('.assistant-task-card textarea'))`),'The task card offers a clarification editor');
    await shot('task-card');
  });
  await step('reading and closing chat leave avatar and sidebar blocker visible',async()=>{
    await click('.apex-widget-header [aria-label="Close ApexAgent"]');
    await until('durable blocker and task badges',()=>page(`return document.querySelector('.apex-widget-count')?.textContent==='2'&&document.querySelector('.flag-count.needs_input')?.textContent==='2'`));
    assert.match(await page(`return document.querySelector('.apex-widget-bubble')?.textContent??''`),/SSO blocks/);
    await shot('closed-blocker');
  });
  await step('page changes retain the same assignment and avatar',async()=>{
    await page(`window.dispatchEvent(new KeyboardEvent('keydown',{code:'Digit1',key:'1',metaKey:true,bubbles:true}));return true;`);
    await until('Agents page',()=>page(`return Boolean(document.querySelector('.agents-section'))`));
    assert.equal(await page(`return document.querySelectorAll('.apex-widget-hit').length`),1);
    await click('.apex-widget-hit');await until('conversation ready',()=>page(`return Boolean(document.querySelector('.assistant-request'))`));
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
    await type('.assistant-request textarea','Defer SSO, keep November 1, and draft the revised plan.');
    await clickText('.assistant-request button','Send message');
    await until('revised plan answer',()=>page(`return document.querySelector('.assistant-task-response')?.textContent.includes('Revised plan')`));
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
    // The blocker is resolved, while the earlier clarification task remains
    // actionable and must continue to account for one needs-you badge.
    await until('resolved finding with clarification badge retained',()=>page(`return document.querySelector('.apex-widget-count')?.textContent==='1'&&document.querySelector('.flag-count.needs_input')?.textContent==='1'`));
  });
  await step('drag/arrow positioning stays inside a narrow viewport',async()=>{
    await click('.apex-widget-header [aria-label="Close ApexAgent"]');win.setMinimumSize(320,500);win.setSize(420,700);await sleep(300);
    await page(`document.querySelector('.apex-widget-hit').focus();return true;`);
    win.webContents.sendInputEvent({type:'keyDown',keyCode:'Right'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Right'});
    await click('.apex-widget-hit');await sleep(200);
    const bounds=await page(`const r=document.querySelector('.apex-widget-panel').getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,w:innerWidth,h:innerHeight};`);
    assert.ok(bounds.left>=0&&bounds.right<=bounds.w&&bounds.top>=0&&bounds.bottom<=bounds.h,JSON.stringify(bounds));
    assert.ok(bounds.w <= 420, 'The responsive check must actually use a narrow viewport');
    await reveal('.assistant-request textarea');
    await type('.assistant-request textarea','One more narrow-window follow-up.');
    await reveal('.assistant-request button');
    await clickText('.assistant-request button','Send message');
    const before=await monitor();
    await until('narrow follow-up sent',()=>page(`return document.querySelector('.apex-agent-transcript')?.textContent.includes('One more narrow-window follow-up.')`));
    const after=await until('narrow follow-up saved',async()=>{const current=await monitor();return current.messages.length>before.messages.length&&current.messages.some(message=>message.role==='human'&&message.text==='One more narrow-window follow-up.')&&current;});
    assert.equal(after.conversationId,original.conversationId);assert.equal(after.responsibility,original.responsibility);assert.ok(after.files.includes('CHANGELOG.md'));
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
