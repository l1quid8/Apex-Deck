import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import electron from 'electron';
import { createServer } from 'vite';
import { runElectronScenario } from './helpers/electron-test.mjs';
import { classifyPlainHandoffReply, deriveHandoffPill, deriveHandoffPopover, preserveTypedAgentOrder } from '../src/assistantHandoffModel.ts';

const handoffOwner = { workspaceId: 'watchdog-test', cwd: '/work/watchdog-test', hostId: 'local', conversationId: 'monitor-1' };
const handoffTask = (overrides = {}) => ({
  id: 'at-409', workspaceId: handoffOwner.workspaceId, owner: handoffOwner,
  destination: { threadId: 'watchdog-qa', workers: overrides.workers ?? ['Hyke'], newThread: false },
  origin: 'human_request', originalRequest: 'Run the watchdog steps.',
  brief: 'From the project folder, run tools/step.sh 1 up to 40',
  evidence: [], reviewCriteria: [], parentThreadId: 'alfred', executionThreadId: 'watchdog-qa',
  workers: ['Hyke'], attempts: [{ number: 1, runId: 'run-1', status: 'running', startedAtMs: 1, finishedAtMs: null, reviewRevision: null, usage: null }],
  status: 'running', result: null, revision: 7, mode: 'in_place', usage: null, createdAtMs: 1, updatedAtMs: 2,
  ...overrides,
});
const listedSteps = Array.from({ length: 40 }, (_, index) => ({ text: `step ${index + 1}`, status: index < 20 ? 'done' : 'open' }));

test('round 1 handoff replies, pills, and popover stay literal', () => {
  const agents = ['Hyke', 'Muck', 'Null', 'Jigga'];
  assert.equal(classifyPlainHandoffReply('stop'), 'stop');
  assert.equal(classifyPlainHandoffReply('  Cancel that. '), 'stop');
  assert.equal(classifyPlainHandoffReply('keep going'), 'continue');
  for (const text of ['No, wait for me', 'What did step 12 do?', 'hmm', "Don't give it to Muck", 'Also check stderr and don\'t stop on warnings', 'stop?', 'yes?', 'yes, but wait']) {
    assert.equal(classifyPlainHandoffReply(text), 'other', text);
  }
  assert.deepEqual(preserveTypedAgentOrder('Muck and Hyke', agents), ['Muck', 'Hyke']);

  const running = deriveHandoffPill(handoffTask(), { taskId: 'at-409', todos: listedSteps }, 'Watchdog QA');
  assert.equal(running.label, 'Hyke · step 20/40');
  assert.equal(running.stopA11yLabel, 'Stop Hyke');
  assert.deepEqual(running.availableActions, ['stop', 'open']);
  assert.equal(running.sentence, "Handing this to Hyke in Watchdog QA, I'll tell you when it's done.");

  const team = deriveHandoffPill(handoffTask({ workers: ['Muck', 'Null'] }), { taskId: 'at-409', todos: listedSteps }, 'Watchdog QA');
  assert.equal(team.label, 'Muck + Null · 20/40');
  assert.equal(team.teamPreview, 'Muck + Null · Muck leads');
  assert.equal(team.leadWorkerId, 'Muck');

  assert.equal(deriveHandoffPill(handoffTask({ status: 'proposed', attempts: [] })).label, 'needs your OK');
  assert.deepEqual(deriveHandoffPill(handoffTask({ status: 'proposed', attempts: [] })).availableActions, ['open']);
  assert.equal(deriveHandoffPill(handoffTask({ status: 'needs_you' })).label, 'Hyke · needs you');
  assert.equal(deriveHandoffPill(handoffTask({ status: 'failed' })).label, "Hyke · couldn't start");
  assert.deepEqual(deriveHandoffPill(handoffTask({ status: 'failed' })).availableActions, ['retry', 'open']);
  assert.equal(deriveHandoffPill(handoffTask({ status: 'queued', attempts: [] })).label, 'Hyke · queued');
  assert.equal(deriveHandoffPill(handoffTask({ desiredState: 'paused' })).label, 'Hyke · stopping');
  const noTotal = deriveHandoffPill(handoffTask(), { taskId: 'at-409', latestActivity: 'ran tools/step.sh 21' });
  assert.match(noTotal.label, /^Hyke · working · ran tools\/step\.sh 21$/);
  assert.equal(noTotal.totalCount, undefined);
  assert.doesNotMatch(noTotal.label, /40/);

  const popover = deriveHandoffPopover(handoffTask(), { taskId: 'at-409', todos: listedSteps }, []);
  assert.equal(popover.canHandover, false);
  assert.equal(popover.canRetry, false);
  assert.equal(popover.steps[34].state, 'future');
  assert.equal(popover.steps[34].text, 'step 35');
  assert.equal(deriveHandoffPopover(handoffTask({ status: 'cancelled' }), { taskId: 'at-409', todos: listedSteps }, []).canRetry, true);
  assert.equal(deriveHandoffPopover(handoffTask(), undefined, []).steps.length, 0);
});

test('real assistant chat and companion keep outcomes conversational, decisions intact, and execution history in Tasks', { timeout: 120000 }, async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-conversation-ui-'));
  const html = '<div id="root"></div><script type="module" src="/tests/helpers/assistant-conversation-browser.jsx"></script>';
  const server = await createServer({ cacheDir: path.join(temp, 'vite-cache'), server: { port: 0 }, logLevel: 'error', plugins: [{ name: 'conversation-ui-test', configureServer(s) { s.middlewares.use('/__conversation_ui', async (_q, res) => { res.setHeader('Content-Type', 'text/html'); res.end(await s.transformIndexHtml('/__conversation_ui', html)); }); } }] });
  await server.listen();
  const main = path.join(temp, 'main.cjs');
  fs.writeFileSync(main, `const {app,BrowserWindow}=require('electron');const assert=require('node:assert/strict');app.whenReady().then(async()=>{try{
    for(const companion of [false,true]){
      const win=new BrowserWindow({show:false,width:900,height:780,webPreferences:{offscreen:true}});
      const run=code=>win.webContents.executeJavaScript(code);
      const frame=()=>run('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
      await win.loadURL('http://localhost:${server.httpServer.address().port}/__conversation_ui'+(companion?'?companion':''));
      let ready=false;for(let i=0;i<400;i++){if(await run('typeof window.setScenario==="function"&&!!document.querySelector("${'.assistant-chat-transcript'},.assistant-float-log")')){ready=true;break;}await new Promise(r=>setTimeout(r,25));}assert.ok(ready,'real conversation mounted');await frame();
      const selector=companion?'.assistant-float-log':'.assistant-chat-transcript';
      const text=()=>run('document.querySelector('+JSON.stringify(selector)+').textContent');
      const routine=await text();assert.match(routine,/Permanently deleted all 2 selected threads\\./,companion?'companion outcome':'main outcome');assert.doesNotMatch(routine,/exited with|room\\.deleteMany|Completed IDs|Remaining IDs|Approved\\.|Allowed once|Open details|Running|Command/);assert.ok(routine.indexOf('What next?')<routine.indexOf('Permanently deleted'),'outcome stays at completion time');
      assert.equal(await run('document.querySelectorAll('+JSON.stringify(selector+' details,'+selector+' .apex-agent-task-link')+').length'),0,'routine execution has no inline dropdown or task link');
      if(!companion){await run('openTask()');await frame();assert.match(await text(),/Command/);assert.match(await text(),/Completed IDs: one, two/);assert.match(await text(),/Request to plan3 ms/);assert.match(await text(),/Waiting to start6 ms/);assert.match(await text(),/Latest action10 ms/);await run('document.querySelector(".apex-agent-back").click()');await frame();}
      await run('setScenario("ask")');await frame();assert.match(await text(),/One/);assert.match(await text(),/Two/);
      if(companion){assert.equal(await run('document.querySelectorAll(".assistant-float-log button").length'),1);await run('document.querySelector(".assistant-float-log button").click()');await frame();assert.equal(await run('calls.at(-1).type'),'assistant-details');}
      else {assert.equal(await run('[...document.querySelectorAll(".dot-actions button")].filter(b=>b.textContent==="Allow once").length'),1,'one approval binds the entire bulk set');await run('[...document.querySelectorAll(".dot-actions button")].find(b=>b.textContent==="Allow once").click()');await frame();assert.deepEqual(await run('calls'),[['approval','sha256:exact-batch',true]]);}
      await run('setScenario("failed")');await frame();assert.match(await text(),/outcome is uncertain/);assert.doesNotMatch(await text(),/Permanently deleted all|exited with|Completed IDs|Remaining IDs/);assert.equal(await run('document.querySelectorAll('+JSON.stringify(selector+' button')+').length>0'),true,'problem offers task review');
      if(!companion){await run('[...document.querySelectorAll(".assistant-chat-transcript button")].find(b=>b.textContent==="Review task").click()');await frame();assert.match(await text(),/Remaining IDs: two/);await run('document.querySelector(".apex-agent-back").click()');await frame();}
      await run('setScenario("unverified")');await frame();assert.match(await text(),/couldn.t verify/i);assert.doesNotMatch(await text(),/It is done|Permanently deleted all/);
      await run('setScenario("helperFailure")');await frame();assert.match(await text(),/The provider is unavailable/);assert.equal(await run('document.querySelectorAll('+JSON.stringify(selector+' button')+').length>0'),true,'automatic helper failure offers review without a task-linked log message');
      if(!companion){await run('setScenario("routine");popup()');await frame();assert.doesNotMatch(await text(),/Open details|Task ·|exited with|Completed IDs/);await run('[...document.querySelectorAll("button[role=tab]")].find(b=>b.textContent.startsWith("Tasks")).click()');await frame();await run('[...document.querySelectorAll(".apex-agent-task-row")].find(b=>b.textContent.includes("Done")).click()');await frame();assert.match(await text(),/Completed IDs: one, two/);await run('showTaskSidebar()');await frame();const timing=await run('document.querySelector(\".assistant-personal-task-detail\").textContent');assert.match(timing,/Request to plan3 ms/);assert.match(timing,/Waiting to start6 ms/);assert.match(timing,/Latest action10 ms/);await run('setScenario("pruned")');await frame();const pruned=await run('document.querySelector(\".assistant-personal-task-detail\").textContent');assert.doesNotMatch(pruned,/Waiting to start/);assert.match(pruned,/Latest action10 ms/);}
      win.destroy();
    }
    app.exit(0);
  }catch(error){console.error(error.stack);app.exit(1)}});`);
  try { const result = await runElectronScenario(electron, main, temp, { timeoutMs: 90000, attempts: 1 }); assert.equal(result.code, 0, result.output); }
  finally { await server.close(); fs.rmSync(temp, { recursive: true, force: true }); }
});

test('round 1 handoff pill, popover, agent picker, and paused replies work in the browser', { timeout: 180000 }, async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-handoff-ui-'));
  const html = '<div id="root"></div><script type="module" src="/tests/helpers/assistant-handoff-browser.jsx"></script>';
  const server = await createServer({ cacheDir: path.join(temp, 'vite-cache'), server: { port: 0 }, logLevel: 'error', plugins: [{ name: 'handoff-ui-test', configureServer(s) { s.middlewares.use('/__handoff_ui', async (_q, res) => { res.setHeader('Content-Type', 'text/html'); res.end(await s.transformIndexHtml('/__handoff_ui', html)); }); } }] });
  await server.listen();
  const port = server.httpServer.address().port;
  const main = path.join(temp, 'main.cjs');
  fs.writeFileSync(main, `const {app,BrowserWindow}=require('electron');const assert=require('node:assert/strict');app.whenReady().then(async()=>{try{
    const win=new BrowserWindow({show:false,width:900,height:800,webPreferences:{offscreen:true}});
    const run=code=>win.webContents.executeJavaScript(code);
    const frame=()=>run('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
    await win.loadURL('http://localhost:${port}/__handoff_ui');
    let ready=false;for(let i=0;i<400;i++){if(await run('window.__handoffReady===true && !!document.querySelector(".assistant-handoff-pill")')){ready=true;break;}await new Promise(r=>setTimeout(r,25));}
    assert.ok(ready,'handoff fixture mounted');await frame();
    const failures=await run('runHandoffChecks()');
    assert.deepEqual(failures,[]);
    app.exit(0);
  }catch(error){console.error(error.stack||error);app.exit(1)}});`);
  try { const result = await runElectronScenario(electron, main, temp, { timeoutMs: 120000, attempts: 1 }); assert.equal(result.code, 0, result.output); }
  finally { await server.close(); fs.rmSync(temp, { recursive: true, force: true }); }
});
