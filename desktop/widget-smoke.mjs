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
  const clickLabel=(selector,label)=>page(`const el=[...document.querySelectorAll(${JSON.stringify(selector)})].find(e=>e.getAttribute('aria-label')===${JSON.stringify(label)});if(!el)throw Error('Missing '+${JSON.stringify(label)});el.click();return true;`);
  const type=(selector,text)=>page(`const el=document.querySelector(${JSON.stringify(selector)});if(!el)throw Error('Missing textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,${JSON.stringify(text)});el.dispatchEvent(new Event('input',{bubbles:true}));return true;`);
  const reveal=async selector=>{const rect=await page(`const el=document.querySelector(${JSON.stringify(selector)});if(!el)throw Error('Missing '+${JSON.stringify(selector)});el.scrollIntoView({block:'center',inline:'nearest'});const r=el.getBoundingClientRect();return {top:r.top,bottom:r.bottom,left:r.left,right:r.right,width:r.width,height:r.height,viewportWidth:innerWidth,viewportHeight:innerHeight};`);assert.ok(rect.width>0&&rect.height>0&&rect.top>=0&&rect.bottom<=rect.viewportHeight&&rect.left>=0&&rect.right<=rect.viewportWidth,`${selector} can be fully brought into view: ${JSON.stringify(rect)}`);return rect;};
  const monitor=()=>page(`return await __deck.backend.call('monitor_get',{workspaceId:'launch'})`);
  const shot=async name=>{const directory=process.env.APEX_WIDGET_SCREENSHOTS; if(directory){fs.mkdirSync(directory,{recursive:true});fs.writeFileSync(path.join(directory,`${name}.png`),(await win.webContents.capturePage()).toPNG());}};
  // The avatar opens the combined conversation; project setup and sources live under ⋯.
  const openProject=async()=>{await click('.apex-widget-hit');await until('dock open',()=>page(`return Boolean(document.querySelector('.apex-agent-dock'))`));await page(`if(document.querySelector('.apex-agent-all')){const item=[...document.querySelectorAll('.apex-agent-more [role="menuitem"]')].find(e=>/^(Sources for|Watch) Mobile launch/.test(e.textContent.trim()));if(!item)throw Error('Missing Mobile launch menu item');item.click();}return true;`);};
  await until('connected UI',()=>page(`return Boolean(window.__deck&&!document.querySelector('.loading')&&document.querySelector('.apex-widget-hit'))`));
  await until('saved projects loaded',()=>page(`return Boolean(document.querySelector('[data-workspace="launch"]'))`)).catch(async error=>{console.error('startup diagnostics',await page('return {text:document.body.innerText,session:await __deck.backend.sessionLoad()}'));throw error;});
  win.setSize(1200,850); win.show(); win.focus(); await sleep(150);
  await step('keyboard opens the persistent assistant',async()=>{
    await page(`window.__widgetKeys=[];window.addEventListener('keydown',e=>__widgetKeys.push({key:e.key,code:e.code,defaultPrevented:e.defaultPrevented}));document.querySelector('.apex-widget-hit').focus();return true;`);
    await sleep(100);
    win.webContents.sendInputEvent({type:'keyDown',keyCode:'Return'});win.webContents.sendInputEvent({type:'char',keyCode:'\r'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Return'});
    // With nothing watched yet, the combined conversation sends setup through ⋯ → Watch <project>….
    await until('combined conversation',()=>page(`return Boolean(document.querySelector('.apex-agent-all'))`));
    await page(`const item=[...document.querySelectorAll('.apex-agent-more [role="menuitem"]')].find(e=>e.textContent.trim()==='Watch Mobile launch…');if(!item)throw Error('Missing Watch Mobile launch…');item.click();return true;`);
    await until('conversation',()=>page(`return Boolean(document.querySelector('.apex-agent-setup-form'))`)).catch(async error=>{console.error('keyboard diagnostics',await page(`return {keys:__widgetKeys,focus:document.activeElement?.outerHTML}`));throw error;});
    assert.equal(await page(`return document.querySelector('.apex-agent').getAttribute('aria-modal')`),null);
    const profile=await page(`const select=document.querySelector('[aria-label="Thinking with profile"],[aria-label="ApexAgent profile"]');return select&&{value:select.value,options:[...select.options].map(option=>({value:option.value,text:option.textContent.trim()}))}`);
    assert.ok(profile&&profile.options.some(option=>option.text==='Widget test model')&&profile.options.some(option=>option.text==='Widget alternate model'),`The profile picker shows both local test profiles: ${JSON.stringify(profile)}`);
    const originalProfile=profile.value;
    const alternateProfile=profile.options.find(option=>option.text==='Widget alternate model').value;
    await page(`const select=document.querySelector('[aria-label="Thinking with profile"],[aria-label="ApexAgent profile"]');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(select,${JSON.stringify(alternateProfile)});select.dispatchEvent(new Event('change',{bubbles:true}));return true;`);
    await until('alternate profile selection',()=>page(`return document.querySelector('[aria-label="Thinking with profile"],[aria-label="ApexAgent profile"]')?.value===${JSON.stringify(alternateProfile)}`));
    await page(`const select=document.querySelector('[aria-label="Thinking with profile"],[aria-label="ApexAgent profile"]');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(select,${JSON.stringify(originalProfile)});select.dispatchEvent(new Event('change',{bubbles:true}));return true;`);
    await until('original profile selection',()=>page(`return document.querySelector('[aria-label="Thinking with profile"],[aria-label="ApexAgent profile"]')?.value===${JSON.stringify(originalProfile)}`));
    await shot('setup');
  });
  await step('v4 pop-up floats over the app without resizing it, with no tabs or AI picker',async()=>{
    const before=await page(`const dock=document.querySelector('.apex-agent-dock'),canvas=document.querySelector('.body > .canvas'),avatar=document.querySelector('.apex-widget-avatar');const d=dock.getBoundingClientRect(),c=canvas.getBoundingClientRect();return {dock:{left:d.left,right:d.right,width:d.width},canvas:{left:c.left,right:c.right,width:c.width},avatar:{open:avatar.classList.contains('is-open'),glow:getComputedStyle(avatar.querySelector('.apex-widget-core')).borderTopColor},separator:!!document.querySelector('[role="separator"][aria-label="Resize ApexAgent dock"]'),body:document.querySelector('.body').getBoundingClientRect().toJSON()};`);
    const extra=await page(`return {position:getComputedStyle(document.querySelector('.apex-agent-dock')).position,tabs:!!document.querySelector('.apex-agent-tabs'),picker:!!document.querySelector('[aria-label="Thinking with profile"]'),bodyRight:document.querySelector('.body').getBoundingClientRect().right}`);
    assert.equal(extra.position,'fixed',`The pop-up floats: ${JSON.stringify(extra)}`);
    assert.ok(before.dock.width>=360&&before.dock.width<=420,`The pop-up is about 400px wide: ${JSON.stringify(before)}`);
    assert.ok(Math.abs(before.canvas.right-extra.bodyRight)<=2,`The app keeps its full width under the pop-up: ${JSON.stringify(before)}`);
    assert.ok(!before.separator&&!extra.tabs&&!extra.picker,`No resize bar, tabs or AI picker: ${JSON.stringify(extra)}`);
    const green=before.avatar.glow.match(/\d+/g)?.map(Number)??[];
    assert.ok(before.avatar.open&&green[1]>green[0]&&green[1]>green[2],`The avatar remains visible and uses the green open state: ${JSON.stringify(before.avatar)}`);
    await shot('v4-open');
  });
  await step('Escape closes dock and restores focus to the avatar',async()=>{
    win.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});
    await until('dock closed on Escape',()=>page(`return !document.querySelector('.apex-agent-dock')`));
    await until('avatar restored as focus target',()=>page(`return document.activeElement?.classList.contains('apex-widget-hit')`));
    assert.equal(await page(`return document.querySelector('.apex-widget-avatar')?.classList.contains('is-open')`),false);
    await openProject();await until('dock reopened',()=>page(`return Boolean(document.querySelector('.apex-agent-dock'))`));
  });
  let original;
  await step('chat-first responsibility collects approved evidence and reports SSO',async()=>{
    await until('suggested sources',()=>page(`return document.querySelector('.apex-agent-chips')?.textContent.includes('test-report.md')`));
    await type('[aria-label="Responsibility for ApexAgent"]','Keep the November 1 launch on track; flag unmet release requirements.');
    await clickText('.apex-agent-setup-form button','Assign responsibility');
    original=await until('saved assignment',monitor);
    await until('setup form gives way to the conversation',()=>page(`return Boolean(document.querySelector('.assistant-chat-transcript')&&document.querySelector('.apex-agent-setup-form')===null&&!document.querySelector('[aria-label="Thinking with profile"]'))`));
    await until('evidence-backed finding',async()=>{const m=await monitor();return !m.activeCheck&&m.findings.some(f=>f.status==='open');});
    await clickLabel('.apex-agent [aria-label]','Close ApexAgent');await sleep(100);await openProject();
    await until('finding in real chat',()=>page(`return document.querySelector('.apex-agent-findings')?.textContent.includes('SSO blocks')`));
    assert.equal((await monitor()).conversationId,original.conversationId);
    const composer=await page(`const c=document.querySelector('.assistant-request').getBoundingClientRect(),p=document.querySelector('.apex-agent-dock').getBoundingClientRect();return {top:c.top,bottom:c.bottom,panelBottom:p.bottom,viewport:innerHeight};`);
    assert.ok(composer.top<composer.viewport&&composer.bottom>0&&composer.bottom>composer.top,`The task request form intersects the viewport while findings scroll: ${JSON.stringify(composer)}`);
    await shot('blocker');
  });
  await step('a direct answer leaves the periodic responsibility and finding in place',async()=>{
    const before=await monitor();
    await reveal('.assistant-request textarea');
    await type('.assistant-request textarea','Why is SSO still blocking the November 1 release?');
    await reveal('.assistant-request .primary');
    await click('.assistant-request .primary');
    await until('direct answer',()=>page(`return [...document.querySelectorAll('.assistant-chat-message.assistant')].some(message=>message.textContent.includes('kept that responsibility active'))`));
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
    await clickText('.apex-agent-more [role="menuitem"]','Sources and AI');
    const picker=await page(`const select=document.querySelector('[aria-label="Saved profile"]');return select&&[...select.options].map(option=>({value:option.value,text:option.textContent.trim()}))`);
    const alternate=picker?.find(option=>option.text==='Widget alternate model');
    assert.ok(alternate,`The alternate saved profile is available: ${JSON.stringify(picker)}`);
    await page(`const select=document.querySelector('[aria-label="Saved profile"]');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(select,${JSON.stringify(alternate.value)});select.dispatchEvent(new Event('change',{bubbles:true}));return true;`);
    const after=await until('updated assigned profile',async()=>{const current=await monitor();return current.profileId===alternate.value&&current;});
    assert.equal(after.conversationId,before.conversationId);
    assert.equal(after.responsibility,before.responsibility);
    assert.deepEqual(after.files,before.files);
    assert.deepEqual(after.messages.map(({role,text})=>({role,text})),before.messages.map(({role,text})=>({role,text})));
    await clickText('.apex-agent-more [role="menuitem"]','Back to conversation');
  });
  await step('reading and closing chat leave avatar and sidebar blocker visible',async()=>{
    await clickLabel('.apex-agent [aria-label]','Close ApexAgent');
    await until('durable blocker badges',()=>page(`return document.querySelector('.apex-widget-count')?.textContent==='1'&&document.querySelector('.flag-count.needs_input')?.textContent==='1'`));
    assert.match(await page(`return document.querySelector('.apex-widget-bubble')?.textContent??''`),/SSO blocks/);
    await shot('closed-blocker');
  });
  await step('page changes retain the same assignment and avatar',async()=>{
    await page(`window.dispatchEvent(new KeyboardEvent('keydown',{code:'Digit1',key:'1',metaKey:true,bubbles:true}));return true;`);
    await until('Agents page',()=>page(`return Boolean(document.querySelector('.agents-section'))`));
    assert.equal(await page(`return document.querySelectorAll('.apex-widget-hit').length`),1);
    await openProject();await until('conversation ready',()=>page(`return Boolean(document.querySelector('.assistant-request'))`));
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
    await click('.assistant-request .primary');
    await until('revised plan answer',()=>page(`return [...document.querySelectorAll('.assistant-chat-message.assistant')].some(message=>message.textContent.includes('Revised plan'))`));
    const m=await until('redirect result',async()=>{const m=await monitor();return !m.activeCheck&&m.messages.some(msg=>msg.role==='assistant'&&msg.text.includes('Revised plan'))&&m;});
    assert.equal(m.conversationId,original.conversationId);assert.ok(m.messages.some(msg=>msg.role==='human'&&msg.text.startsWith('Defer SSO')));
    // Reopen to receive the new snapshot immediately rather than waiting for the display poll.
    await clickLabel('.apex-agent [aria-label]','Close ApexAgent');await sleep(100);await openProject();
    await until('redirect in chat',()=>page(`return document.querySelector('.assistant-chat-transcript')?.textContent.includes('Revised plan')`));await shot('redirect');
  });
  await step('explicit resolution clears badges and Check now does not reopen settled SSO',async()=>{
    await clickText('.apex-agent-findings button','Resolve');
    await until('resolved',async()=>!(await monitor()).findings.some(f=>f.status==='open'));
    const before=await monitor();
    await clickText('.apex-agent-more [role="menuitem"]','Check now');
    const m=await until('check now finished',async()=>{const m=await monitor();return !m.activeCheck&&(m.snapshotVersion??0)>(before.snapshotVersion??0)&&m;});
    assert.ok(m.lastCheckedAt>=before.lastCheckedAt,'A completed check does not move the recorded time backward');
    assert.equal(m.findings.filter(f=>f.status==='open').length,0);
    // With no task waiting, resolving the only blocker clears both badges.
    await until('resolved finding clears badges',()=>page(`return !document.querySelector('.apex-widget-count')&&!document.querySelector('.flag-count.needs_input')`));
  });
  await step('drag/arrow positioning stays inside a narrow viewport',async()=>{
    await clickLabel('.apex-agent [aria-label]','Close ApexAgent');win.setMinimumSize(320,500);win.setSize(420,700);await sleep(300);
    await page(`document.querySelector('.apex-widget-hit').focus();return true;`);
    win.webContents.sendInputEvent({type:'keyDown',keyCode:'Right'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Right'});
    await openProject();await sleep(200);
    const bounds=await page(`const r=document.querySelector('.apex-agent-dock').getBoundingClientRect(),body=document.querySelector('.body'),br=body.getBoundingClientRect(),rail=document.querySelector('.rail')?.getBoundingClientRect(),canvas=document.querySelector('.body > .canvas').getBoundingClientRect(),actions=document.querySelector('.apex-agent-head-actions').getBoundingClientRect();return {left:r.left,right:r.right,width:r.width,styleWidth:document.querySelector('.apex-agent-dock').style.width,top:r.top,bottom:r.bottom,w:innerWidth,h:innerHeight,body:{left:br.left,right:br.right,clientWidth:body.clientWidth},rail:rail&&{left:rail.left,right:rail.right,width:rail.width},canvas:{left:canvas.left,right:canvas.right,width:canvas.width},actions:{left:actions.left,right:actions.right}};`);
    assert.ok(bounds.left>=0&&bounds.right<=bounds.w&&bounds.top>=0&&bounds.bottom<=bounds.h,JSON.stringify(bounds));
    assert.ok(bounds.w <= 420, 'The responsive check must actually use a narrow viewport');
    assert.ok(bounds.right<=bounds.body.right+1&&bounds.actions.right<=bounds.right+1,`Dock resize and header actions remain inside the narrow body: ${JSON.stringify(bounds)}`);
    await reveal('.assistant-request textarea');
    await type('.assistant-request textarea','One more narrow-window follow-up.');
    await reveal('.assistant-request .primary');
    await click('.assistant-request .primary');
    const before=await monitor();
    await until('narrow follow-up sent',()=>page(`return document.querySelector('.assistant-chat-transcript')?.textContent.includes('One more narrow-window follow-up.')`));
    const after=await until('narrow follow-up saved',async()=>{const current=await monitor();return current.messages.length>before.messages.length&&current.messages.some(message=>message.role==='human'&&message.text==='One more narrow-window follow-up.')&&current;});
    assert.equal(after.conversationId,original.conversationId);assert.equal(after.responsibility,original.responsibility);assert.ok(after.files.includes('CHANGELOG.md'));
    await shot('narrow');win.setSize(1200,850);await sleep(200);
  });
  await step('optional full screen and Clear conversation; no ApexAgent button by + New',async()=>{
    await clickLabel('.apex-agent [aria-label]','Close ApexAgent');await sleep(100);
    assert.equal(await page(`return Boolean(document.querySelector('.apex-agent-entry'))`),false,'The ApexAgent button beside + New is gone');
    await click('.apex-widget-hit');
    await until('combined conversation',async()=>{const ready=await page(`return Boolean(document.querySelector('.apex-agent-all'))`);if(!ready)await page(`document.querySelector('.apex-agent-back')?.click();return true;`);return ready;});
    await clickLabel('.apex-agent-all [aria-label]','Full screen');
    const full=await until('full screen',()=>page(`const d=document.querySelector('.apex-agent-dock.apex-agent-full');if(!d)return null;const r=d.getBoundingClientRect();return {width:r.width,height:r.height,w:innerWidth,h:innerHeight,right:r.right,bottom:r.bottom}`));
    assert.ok(full.width>full.w*0.9&&full.height>full.h*0.8&&full.right<=full.w&&full.bottom<=full.h,`Full screen covers the window: ${JSON.stringify(full)}`);
    await shot('full-screen');
    await clickLabel('.apex-agent-all [aria-label]','Exit full screen');
    await until('pop-up size again',()=>page(`return Boolean(document.querySelector('.apex-agent-dock')&&!document.querySelector('.apex-agent-full'))`));
    const saved=(await monitor()).messages.length;
    assert.ok(await page(`return document.querySelectorAll('.apex-agent-all .assistant-chat-message:not(.apex-agent-needs-you):not(.apex-agent-check-failed)').length>0`),'Messages show before clearing');
    await page(`window.confirm=()=>true;document.querySelector('.apex-agent-more').open=true;return true;`);
    await clickText('.apex-agent-more [role="menuitem"]','Clear conversation');
    await until('conversation cleared',()=>page(`return document.querySelectorAll('.apex-agent-all .assistant-chat-message:not(.apex-agent-needs-you):not(.apex-agent-check-failed)').length===0`));
    assert.equal((await monitor()).messages.length,saved,'Clearing hides messages on screen; the assistant keeps its memory');
    await shot('cleared');
  });
  await step('native browser steps aside while the pop-up is open',async()=>{
    await clickLabel('.apex-agent [aria-label]','Close ApexAgent');
    await page(`const s=await __deck.backend.sessionLoad();await __deck.backend.sessionSave({...s,section:'code',activeWorkspace:'launch',focusedPane:'widget-browser',panes:[{id:'widget-browser',kind:'preview',title:'Browser',workspaceId:'launch',url:${JSON.stringify(process.env.APEX_WIDGET_SITE)}}]});return true;`);
    win.webContents.reload();await until('UI reloaded',()=>page(`return Boolean(window.__deck&&!document.querySelector('.loading'))`));
    await until('live native browser',()=>browser.inspect('widget-browser')?.shown);
    const beforeDock=browser.inspect('widget-browser')?.bounds;
    await click('.apex-widget-hit');
    await until('assistant dock open',()=>page(`return Boolean(document.querySelector('.apex-agent-dock'))`));
    // The pop-up floats over the browser, so the native view must step aside while it is open.
    await until('native browser hides under the pop-up',()=>!browser.inspect('widget-browser')?.shown);
    await clickLabel('.apex-agent [aria-label]','Close ApexAgent');
    await until('native browser returns at full size',()=>{const current=browser.inspect('widget-browser');return current?.shown&&current.bounds.width===beforeDock.width;});
    await shot('browser');
  });
  console.log(`widget smoke: ${passed} passed, 0 failed`);
  return 0;
}
