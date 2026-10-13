// Native React/Electron/daemon integration checks; no model or store stand-ins.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function runSmoke(win) {
  const data = process.env.APEX_DECK_DATA_DIR;
  const output = process.env.APEX_ANSWERS_OUTPUT;
  const phase = process.env.APEX_ANSWERS_PHASE;
  const page = code => win.webContents.executeJavaScript(`(async()=>{${code}})()`, true);
  const until = async (name, check) => {
    const deadline = Date.now() + 25_000;
    let error;
    while (Date.now() < deadline) {
      try { const value = await check(); if (value) return value; } catch (caught) { error = caught; }
      await sleep(60);
    }
    throw Error(`Timed out: ${name}${error ? ` (${error.message})` : ''}`);
  };
  const passed = [];
  const shot = async name => {
    await page(`document.querySelector('.answer-card')?.scrollIntoView({block:'center'}); return true;`);
    const frame = await until('composited screenshot', () => win.webContents.capturePage().then(frame => frame.isEmpty() ? null : frame));
    fs.writeFileSync(path.join(output, `${name}.png`), frame.toPNG());
  };
  const step = async (name, check) => {
    try { await check(); } catch (error) {
      console.error('answers diagnostics', await page('return document.body.innerText').catch(() => ''));
      await shot('failure').catch(() => {});
      throw error;
    }
    passed.push(name);
    console.log(`answers smoke: PASS ${name}`);
  };
  const clickText = text => page(`const button=[...document.querySelectorAll('.answer-card button')].find(b=>b.textContent.trim()===${JSON.stringify(text)});if(!button)throw Error('Missing card button');button.click();return true;`);
  const value = () => page(`return Number(document.querySelector('.pane[data-pane-id="answers-smoke"] .answer-card input[type=range]')?.value);`);
  const setRange = budget => page(`const el=document.querySelector('.pane[data-pane-id="answers-smoke"] .answer-card input[type=range]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,${budget});el.dispatchEvent(new Event('input',{bubbles:true}));return true;`);
  const setComposer = text => page(`const el=document.querySelector('.composer textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,${JSON.stringify(text)});el.dispatchEvent(new Event('input',{bubbles:true}));return true;`);
  const ready = () => until('connected app', () => page(`return Boolean(window.__deck&&!document.querySelector('.loading'));`));
  win.setContentSize(1100, 880);
  win.show();
  await ready();
  assert.equal(await page('return __deck.backend.demo;'), false);
  if (phase === 'again') {
    await step('settings survive quitting and reopening the desktop app', async () => {
      // The fork can restore first; wait for the original pane being checked.
      await until('restored original card', () => page(`return Boolean(document.querySelector('.pane[data-pane-id="answers-smoke"] .answer-card input[type=range]:not(:disabled)'));`));
      assert.equal(await value(), 175);
      assert.match(await page(`return document.querySelector('.pane[data-pane-id="answers-smoke"] .answer-result').textContent;`), /Serverless/);
      await shot('reopened');
    });
    fs.writeFileSync(path.join(output, `${phase}.json`), JSON.stringify({ passed }, null, 2));
    return 0;
  }
  const profile = (id, mode) => ({ id, display_name: id === 'card' ? 'Card author' : 'Reviewer', backend: { kind: 'cli', program: 'node', args: [path.join(data, 'fixture.mjs'), mode] } });
  await page(`
    await __deck.backend.settingsSave({...await __deck.backend.settingsLoad(), interactiveAnswers:true});
    await __deck.backend.roomCreate('answers-smoke', ${JSON.stringify([profile('card', 'card'), profile('reviewer', 'review')])}, {policy:'mention',max_bot_hops:3}, ${JSON.stringify(path.join(data, 'project'))});
    await __deck.backend.sessionSave({version:1,workspaces:[{id:'answers-project',name:'Interactive answers',path:${JSON.stringify(path.join(data, 'project'))}}],panes:[{id:'answers-smoke',workspaceId:'answers-project',kind:'chat',title:'Deployment comparison'}],profiles:[],activeWorkspace:'answers-project',focusedPane:'answers-smoke',section:'threads',layout:'top'});
    return true;`);
  win.webContents.reload();
  await ready();
  await until('loaded room', () => page(`return document.querySelector('.composer textarea')&&!document.querySelector('.thread-chat .loading');`));
  await step('incomplete streamed JSON shows only the preparing card', async () => {
    await page(`void __deck.backend.roomPost('answers-smoke','@card Compare three deployment options and add a card.');return true;`);
    await until('streaming placeholder', () => page(`return Boolean(document.querySelector('.answer-card.preparing'));`));
    assert.equal(await page(`return document.querySelectorAll('.answer-card.preparing input,.answer-card.preparing button').length;`), 0);
    await shot('streaming');
    await until('finished card', () => page(`return Boolean(document.querySelector('.answer-card input[type=range]:not(:disabled)'));`));
    assert.equal(await value(), 250);
    assert.match(await page(`return document.querySelector('.answer-eyebrow').textContent;`), /v1.*Card author/);
    await shot('comparison');
  });
  await step('inputs change results locally and Reset restores defaults', async () => {
    const before = await page(`return (await __deck.backend.roomState('answers-smoke')).snapshot.transcript.length;`);
    await setRange(100);
    await until('changed result', () => page(`return document.querySelector('.answer-result').textContent.includes('Serverless');`));
    assert.equal(await page(`return (await __deck.backend.roomState('answers-smoke')).snapshot.transcript.length;`), before);
    await clickText('Reset');
    await until('reset value', async () => await value() === 250);
    await setRange(100);
    await until('saved budget', () => page(`const file=await __deck.backend.answersLoad('answers-smoke');return Object.values(file?.cards??{}).some(c=>c.inputs.budget===100);`));
  });
  await step('Discuss preserves typed text without sending; Send routes the exact snapshot to another bot', async () => {
    const before = await page(`return (await __deck.backend.roomState('answers-smoke')).snapshot.transcript.length;`);
    await setComposer('@reviewer Check this tradeoff.');
    await clickText('Discuss these settings');
    const draft = await page(`return document.querySelector('.composer textarea').value;`);
    assert.match(draft, /^@reviewer Check this tradeoff\./);
    assert.match(draft, /Monthly budget: \$100/);
    assert.match(draft, /Priority: Simplicity/);
    assert.match(draft, /\(v1\)/);
    assert.equal(await page(`return (await __deck.backend.roomState('answers-smoke')).snapshot.transcript.length;`), before);
    await shot('discuss');
    await page(`document.querySelector('.composer form')?.requestSubmit();const box=document.querySelector('.composer textarea');box.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));return true;`);
    await until('reviewer replied to shared settings', () => page(`return document.querySelector('.transcript')?.innerText.includes('With your shared $100 budget');`));
    await shot('shared-reply');
  });
  await step('saved settings survive renderer reload and a same-project fork', async () => {
    win.webContents.reload();
    await ready();
    await until('restored saved value', async () => await value() === 100);
    await page(`await __deck.backend.roomFork('answers-smoke','answers-fork',null);return true;`);
    const files = await page(`return [await __deck.backend.answersLoad('answers-smoke'),await __deck.backend.answersLoad('answers-fork')];`);
    assert.deepEqual(files[1], files[0]);
  });
  await step('export waits for a slow saved-settings reload rather than printing defaults', async () => {
    await page(`
      window.__answerLoad=__deck.backend.answersLoad;
      window.__answerExport=__deck.backend.exportThread;
      __deck.backend.answersLoad=async(...args)=>{await new Promise(resolve=>setTimeout(resolve,1000));return __answerLoad(...args);};
      __deck.backend.exportThread=async(name,text)=>{window.__exportedAnswer=text;return null;};
      const c=__deck.backend.machines.connection('local');c.setStatus({kind:'resync'});c.setStatus({kind:'connected',hostId:'local'});
      return true;`);
    await sleep(150);
    await until('reloaded transcript', () => page(`return document.querySelector('.transcript')?.innerText.includes('With your shared $100 budget');`));
    await setComposer('/export');
    await page(`document.querySelector('.composer textarea').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));return true;`);
    const exported = await until('exported Markdown', () => page(`return window.__exportedAnswer;`));
    assert.match(exported, /Monthly budget: \$100/);
    assert.doesNotMatch(exported, /Monthly budget: \$250/);
    fs.writeFileSync(path.join(output, 'export.md'), exported);
    await page(`__deck.backend.answersLoad=__answerLoad;__deck.backend.exportThread=__answerExport;return true;`);
  });
  await step('a failed save survives reconnect and retries without discarding the input', async () => {
    await page(`window.__answerSave=__deck.backend.answerSave;__deck.backend.answerSave=async()=>{throw Error('smoke offline');};return true;`);
    await setRange(150);
    await until('save failure note', () => page(`return document.querySelector('.answer-card')?.textContent.includes('smoke offline');`));
    await page(`__deck.backend.answerSave=__answerSave;const c=__deck.backend.machines.connection('local');c.setStatus({kind:'resync'});c.setStatus({kind:'connected',hostId:'local'});return true;`);
    await until('retried settings', () => page(`const file=await __deck.backend.answersLoad('answers-smoke');return Object.values(file?.cards??{}).some(c=>c.inputs.budget===150);`));
    assert.equal(await value(), 150);
    await setRange(100);
  });
  await step('keyboard arrows adjust the slider and radio choices', async () => {
    await page(`document.querySelector('.answer-card input[type=range]').focus();return true;`);
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Right' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Right' });
    await until('keyboard slider value', async () => await value() === 125);
    await page(`document.querySelector('.answer-card input[type=radio]:checked').focus();return true;`);
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Left' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Left' });
    await until('keyboard radio choice', () => page(`return document.querySelector('.answer-card input[type=radio]:checked')?.value==='cost';`));
    await page(`document.querySelector('.answer-card input[type=radio][value=ease]').click();return true;`);
    await setRange(100);
  });
  await step('a narrow pane stacks options without horizontal overflow', async () => {
    win.setContentSize(560, 900);
    await sleep(200);
    const layout = await page(`const card=document.querySelector('.answer-card');const options=[...card.querySelectorAll('.answer-option')].map(el=>{const r=el.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width};});return {width:card.clientWidth,scroll:card.scrollWidth,options};`);
    assert.ok(layout.width <= 480, JSON.stringify(layout));
    assert.equal(layout.options[0].x, layout.options[1].x);
    assert.ok(layout.options[1].y > layout.options[0].y);
    assert.ok(layout.scroll <= layout.width + 2);
    await shot('narrow');
    win.setContentSize(1100, 880);
  });
  // Poll the actual host save before the process exits and the next app launch.
  await until('final saved settings', () => page(`const file=await __deck.backend.answersLoad('answers-smoke');return Object.values(file?.cards??{}).some(c=>c.inputs.budget===100&&c.inputs.priority==='ease');`));
  await step('fork immediately after a slider edit waits for the pending save', async () => {
    await setRange(125);
    await setComposer('/fork Rapid fork');
    await page(`document.querySelector('.composer textarea').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));return true;`);
    const fork = await until('rapid fork created', () => page(`const s=await __deck.backend.sessionLoad();return s.panes.find(p=>p.title==='Rapid fork');`));
    const file = await page(`return await __deck.backend.answersLoad(${JSON.stringify(fork.id)});`);
    assert.ok(Object.values(file.cards).some(entry=>entry.inputs.budget===125));
  });
  // Focus the original pane so its last change proves the real Cmd-Q path,
  // rather than pre-saving and terminating from the smoke driver.
  await page(`document.querySelector('.pane[data-pane-id="answers-smoke"] .answer-card input[type=range]').focus();return true;`);
  await page(`window.__quitAnswerSave=__deck.backend.answerSave;__deck.backend.answerSave=async(...args)=>{await new Promise(resolve=>setTimeout(resolve,1200));return __quitAnswerSave(...args);};return true;`);
  await setRange(175);
  fs.writeFileSync(path.join(output, `${phase}.json`), JSON.stringify({ passed }, null, 2));
  app.quit();
  return null;
}
