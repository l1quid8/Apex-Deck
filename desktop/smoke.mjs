// `npm run desktop:smoke`: drive the real app, on a real apex-daemon, through
// the backend the window exposes when APEX_DECK_SMOKE=1. Resolves with the
// exit code; any failed check ends the run.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { app, BrowserWindow, powerMonitor, session } from 'electron';
import { PARTITION } from './browser.mjs';

const OPTIONS = { policy: 'mention', max_bot_hops: 3 };
const shell = (id, script) => ({ id, display_name: id, backend: { kind: 'cli', program: 'sh', args: ['-c', script] } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Resolves with the exit code, or null once it has started a quit the way
 * the person would; desktop/run-smoke.mjs then checks the app and the daemon
 * it started are gone.
 */
export async function runSmoke(win, { sidecar, browser }) {
  if (process.env.APEX_DECK_SMOKE_HOST) return runRemoteSmoke(win);
  if (process.env.APEX_DECK_SMOKE_PHASE === 'again') return runAgain(win, sidecar);
  // Keep fixture checkouts small and outside daemon-owned data so checkpoint
  // scans never traverse shared /tmp contents or another smoke run's storage.
  const smokeProject = path.join(app.getPath('userData'), 'smoke-project');
  fs.mkdirSync(smokeProject, { recursive: true });
  fs.writeFileSync(path.join(smokeProject, 'README.md'), '# Native smoke project\n');
  const contents = win.webContents;
  /** Run `code` in the window; it may await, and its value comes back. */
  const page = (code) => contents.executeJavaScript(`(async () => { ${code} })()`, true);

  async function until(what, test, ms = 20_000) {
    const start = Date.now();
    let last;
    for (;;) {
      try {
        const value = await test();
        if (value) return value;
      } catch (e) {
        last = e;
      }
      if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}${last ? ` (last error: ${last.message})` : ''}`);
      await sleep(50);
    }
  }

  async function step(name, run) {
    const start = Date.now();
    await run();
    console.log(`smoke: ok — ${name} (${Date.now() - start} ms)`);
  }

  const ready = () => until('the UI to connect', () => page(`return Boolean(window.__deck && !document.querySelector('.loading'))`), 30_000);

  /** Record room events in the page from now on. */
  const listen = () => page(`
    window.__smoke = { events: [], pty: '' };
    await __deck.backend.onRoomEvent((room, event) => __smoke.events.push({ room, event }));
    await __deck.backend.onPtyData((id, data) => { if (id === 'smoke-term') __smoke.pty += data; });
    return true;`);

  const said = (room, text) => page(`return __smoke.events.some((e) => e.room === ${JSON.stringify(room)} && e.event.type === 'message_added' && e.event.message.text === ${JSON.stringify(text)})`);

  await step('the window connects to the daemon', async () => {
    await ready();
    if (await page(`return __deck.backend.demo`) !== false) throw new Error('the window fell back to the demo backend');
  });

  await step("the Tauri app's window storage came over", async () => {
    const kept = await page(`return localStorage.getItem('apex-deck.smoke.tauri')`);
    if (kept !== 'kept from Tauri') throw new Error(`the old value is ${JSON.stringify(kept)}`);
    // The next launch must not bring it back.
    await page(`localStorage.removeItem('apex-deck.smoke.tauri'); return true;`);
  });

  await step('a chat gets its reply', async () => {
    await listen();
    await page(`
      await __deck.backend.roomCreate('smoke-chat', [${JSON.stringify(shell('bot', 'echo hello from bot'))}], ${JSON.stringify(OPTIONS)}, '');
      await __deck.backend.roomPost('smoke-chat', '@bot hi');
      return true;`);
    await until('the reply', () => said('smoke-chat', 'hello from bot'));
  });

  await step('a reload mid-turn leaves the host working', async () => {
    await page(`
      await __deck.backend.roomCreate('smoke-slow', [${JSON.stringify(shell('slow', 'sleep 3; echo late reply'))}], ${JSON.stringify(OPTIONS)}, '');
      void __deck.backend.roomPost('smoke-slow', '@slow go').catch(() => {});
      return true;`);
    await until('the turn to start', () => page(`return __smoke.events.some((e) => e.room === 'smoke-slow' && e.event.type === 'turn_started')`));
    await sleep(1000);
    contents.reload();
    await sleep(200);
    await ready();
    await until('the reply after the reload', () => page(`
      const room = await __deck.backend.roomCreate('smoke-slow', [], ${JSON.stringify(OPTIONS)}, '');
      return room.transcript.some((m) => m.text === 'late reply');`), 15_000);
  });

  await step('a terminal runs a command', async () => {
    await listen();
    await page(`
      await __deck.backend.ptySpawn({ id: 'smoke-term', cols: 80, rows: 24 });
      await __deck.backend.ptyWrite('smoke-term', 'echo $((6*7))smoke\\n');
      return true;`);
    await until('the terminal output', () => page(`return __smoke.pty.includes('42smoke')`));
    await page(`await __deck.backend.ptyKill('smoke-term'); return true;`);
  });

  await step('a Preview pane docks a real browser where its placeholder is', async () => {
    const site = await serveSite();
    try {
      await page(`
        await __deck.backend.sessionSave({
          version: 1, workspaces: [{ id: 'ws-smoke', name: 'smoke', path: ${JSON.stringify(smokeProject)} }],
          panes: [{ id: 'smoke-preview', workspaceId: 'ws-smoke', kind: 'preview', title: 'Preview', url: ${JSON.stringify(`${site.url}/`)}, deck: 'threads' }],
          profiles: [], activeWorkspace: 'ws-smoke', focusedPane: 'smoke-preview', section: 'threads', layout: 'top',
        });
        return true;`);
      contents.reload();
      await sleep(200);
      await ready();
      const docked = await until('the page to show', () => {
        const seen = browser.inspect('smoke-preview');
        return seen?.shown && seen.contents.getURL().startsWith(site.url) && !seen.contents.isLoading() && seen;
      }).catch(async (error) => {
        const diagnostic = await page(`return {session:await __deck.backend.sessionLoad(),pane:document.querySelector('.pane[data-pane-id="smoke-preview"]')?.innerText??null,place:document.querySelector('.browser-place')?.outerHTML??null}`);
        const native = browser.inspect('smoke-preview');
        throw new Error(`${error.message}; BrowserView mount diagnostics: ${JSON.stringify({ diagnostic, native:native&&{shown:native.shown,url:native.contents.getURL(),loading:native.contents.isLoading(),title:native.contents.getTitle()} })}`);
      });
      const place = await page(`const r = document.querySelector('.browser-place').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height };`);
      const zoom = contents.getZoomFactor();
      for (const key of ['x', 'y', 'width', 'height']) {
        if (Math.abs(docked.bounds[key] - place[key] * zoom) > 1) throw new Error(`the view is at ${JSON.stringify(docked.bounds)}, its place at ${JSON.stringify(place)}`);
      }
      if (await docked.contents.executeJavaScript(`document.body.innerText`) !== 'hello') throw new Error('the page did not render');

      // A menu over the pane: the view steps aside for a picture of itself, and comes back.
      await page(`document.querySelector('button[aria-label="More actions for Preview"]').click(); return true;`);
      await until('the view to step aside for the menu', () => !browser.inspect('smoke-preview').shown, 5_000);
      // The picture needs the window on screen and uncovered, which a smoke
      // run can't promise; say whether it came rather than fail on it.
      const pictured = await until('the picture in its place', () => page(`return Boolean(document.querySelector('.browser-snapshot'))`), 2_000).catch(() => false);
      console.log(`smoke: ${pictured ? 'a picture of the page stood in for it' : 'no picture of the page (the window was not capturable)'}`);
      await page(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true;`);
      await until('the view to come back', () => browser.inspect('smoke-preview').shown, 5_000);

      // Settings takes the deck's place; the page must not sit on top of it.
      await page(`document.querySelector('button[aria-label="Settings"]').click(); return true;`);
      await until('the view to step aside for Settings', () => !browser.inspect('smoke-preview').shown, 5_000);
      await page(`document.querySelector('button[aria-label="Close settings"]').click(); return true;`);
      await until('the view to come back after Settings', () => browser.inspect('smoke-preview').shown, 5_000);

      // A page that tries to take over the window or reach the bridge gets nowhere.
      await page(`await __deck.backend.browser.navigate('smoke-preview', ${JSON.stringify(`${site.url}/evil`)}); return true;`);
      await until('the hostile page', () => {
        const seen = browser.inspect('smoke-preview').contents;
        return seen.getURL().endsWith('/evil') && !seen.isLoading();
      });
      await sleep(1000);
      const after = browser.inspect('smoke-preview').contents;
      if (!after.getURL().endsWith('/evil')) throw new Error(`the page went to ${after.getURL()}`);
      if (contents.getURL() !== 'app://deck/') throw new Error(`the deck went to ${contents.getURL()}`);
      if (BrowserWindow.getAllWindows().length !== 1) throw new Error('the page opened a window');
      const reach = await after.executeJavaScript(`[typeof window.apexDeck, typeof require, typeof process].join(' ')`);
      if (reach !== 'undefined undefined undefined') throw new Error(`the page can see: ${reach}`);
    } finally {
      site.close();
    }
  });

  await step('a Preview page that won\'t load says so, and comes back by itself', async () => {
    // A port nothing listens on, until the end.
    const port = await new Promise((resolve) => { const probe = http.createServer().listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); }); });
    const url = `http://127.0.0.1:${port}/`;
    await page(`
      await __deck.backend.sessionSave({
        version: 1, workspaces: [{ id: 'ws-smoke', name: 'smoke', path: ${JSON.stringify(smokeProject)} }],
        panes: [{ id: 'smoke-down', workspaceId: 'ws-smoke', kind: 'preview', title: 'Preview', url: ${JSON.stringify(url)}, deck: 'threads' }],
        profiles: [], activeWorkspace: 'ws-smoke', focusedPane: 'smoke-down', section: 'threads', layout: 'top',
      });
      return true;`);
    contents.reload();
    await sleep(200);
    await ready();
    await until('the failed Preview pane to mount', () => page(`return Boolean(document.querySelector('.pane[data-pane-id="smoke-down"] .preview'))`));
    await page(`window.__smoke=window.__smoke??{};window.__smoke.browserStates=[];await __deck.backend.browser.onState((pane,state)=>{if(pane==='smoke-down')__smoke.browserStates.push(state)});return true;`);
    // The first navigation can fail while the reloaded renderer is still
    // attaching its BrowserView state listener. Start it again after mount.
    await page(`await __deck.backend.browser.navigate('smoke-down', ${JSON.stringify(url)}); return true;`);
    const notice = () => page(`return document.querySelector('[role="status"].preview-notice')?.innerText ?? ''`);
    const said = await until('the notice', async () => /Nothing is answering at 127\.0\.0\.1:\d+/.test(await notice()) && notice()).catch(async (error) => {
      const diagnostic = await page(`return {notices:[...document.querySelectorAll('.preview-notice,[role="status"]')].map(el=>el.innerText),panes:[...document.querySelectorAll('.pane')].map(el=>({id:el.dataset.paneId,text:el.innerText.slice(0,500)}))}`);
      const native = browser.inspect('smoke-down');
      throw new Error(`${error.message}; preview diagnostics: ${JSON.stringify({ diagnostic, native: native && { shown: native.shown, url: native.contents.getURL(), loading: native.contents.isLoading() } })}`);
    });
    if (!/Checking every 2 s/.test(said)) throw new Error(`the notice says: ${said.replace(/\s+/g, ' ')}`);
    await until('the failed browser view to step aside', () => !browser.inspect('smoke-down')?.shown, 5_000).catch(async (error) => {
      const details = await page(`return {notice:document.querySelector('.preview-notice')?.innerText??'',place:document.querySelector('.browser-place')?.outerHTML??null,states:__smoke.browserStates}`);
      const native = browser.inspect('smoke-down');
      throw new Error(`${error.message}; browser hide diagnostics: ${JSON.stringify({ details, native: native && { shown:native.shown, url:native.contents.getURL(), loading:native.contents.isLoading() } })}`);
    });
    // Through two tries the notice stays, and the blank page never shows in its place.
    const start = Date.now();
    while (Date.now() - start < 4_500) {
      if (browser.inspect('smoke-down')?.shown) throw new Error('the failed page showed over the pane');
      if (!(await notice())) throw new Error('the notice went away while trying again');
      await sleep(50);
    }
    const site = await serveSite(port);
    try {
      await until('the page to come back', async () => {
        const seen = browser.inspect('smoke-down');
        return seen?.shown && !seen.contents.isLoading() && (await seen.contents.executeJavaScript('document.body.innerText')) === 'hello';
      }, 10_000);
      if (await notice()) throw new Error('the notice stayed after the page came back');
    } finally {
      site.close();
    }
  });

  await step('machine chooser replaces window switching and does not reload the canvas', async () => {
    const list = await page(`return await __deck.backend.hosts.add({ name: 'nowhere', ssh: 'nowhere.invalid', command: 'apex-daemon' })`);
    const id = list.find(host => host.name === 'nowhere').id;
    const before = await page('return [...document.querySelectorAll(".pane")].map(p => p.dataset.paneId)');
    await page('window.__hostMenuSentinel = "kept"; document.querySelector("[data-add-workspace]").click(); return true;');
    if (!await page('return Boolean(document.querySelector("[data-machine-menu] [data-host-id=local]"))')) throw Error('missing machine chooser');
    if (!await page(`return Boolean(document.querySelector('[data-machine-menu] [data-host-id="${id}"]'))`)) throw Error('missing saved host');
    await page('document.querySelector("[data-machine-menu]").dispatchEvent(new KeyboardEvent("keydown", {key:"Escape",bubbles:true})); return true;');
    if (await page('return Boolean(document.querySelector("[data-machine-menu]"))')) throw Error('Escape did not close menu');
    if (await page('return window.__hostMenuSentinel') !== 'kept') throw Error('window reloaded');
    const after = await page('return [...document.querySelectorAll(".pane")].map(p => p.dataset.paneId)');
    if (JSON.stringify(before) !== JSON.stringify(after)) throw Error('canvas changed');
    if (BrowserWindow.getAllWindows().length !== 1) throw Error('host menu made another window');
    await page(`await __deck.backend.hosts.remove(${JSON.stringify(id)}); return true;`);
  });

  await step('two threads side by side keep every bot and Add bot in view', async () => {
    const bots = ['reviewer-with-a-long-name', 'planner-with-a-long-name', 'implementer-long-name'].map((id) => shell(id, 'true'));
    await page(`
      await __deck.backend.roomCreate('smoke-bots-a', ${JSON.stringify(bots)}, ${JSON.stringify(OPTIONS)}, '');
      await __deck.backend.roomCreate('smoke-bots-b', ${JSON.stringify(bots)}, ${JSON.stringify(OPTIONS)}, '');
      await __deck.backend.sessionSave({
        version: 1, workspaces: [{ id: 'ws-smoke', name: 'smoke', path: ${JSON.stringify(smokeProject)} }],
        panes: [
          { id: 'smoke-bots-a', workspaceId: 'ws-smoke', kind: 'chat', title: 'Bots A' },
          { id: 'smoke-bots-b', workspaceId: 'ws-smoke', kind: 'chat', title: 'Bots B' },
        ],
        profiles: [], activeWorkspace: 'ws-smoke', focusedPane: 'smoke-bots-a', section: 'threads', layout: 'top',
      });
      return true;`);
    contents.reload();
    await sleep(200);
    await ready();
    // What is wrong with the message boxes right now, or '' when nothing is.
    const problems = () => page(`
      const panes = [...document.querySelectorAll('.pane')].filter((p) => p.offsetWidth > 0 && p.querySelector('.composer'));
      if (panes.length !== 2) return panes.length + ' thread pane(s) showing, not 2';
      const found = [];
      for (const pane of panes) {
        const name = pane.querySelector('.pane-title')?.textContent;
        if (pane.querySelector('.thread-chat > .chat-bar')) found.push(name + ': the old bot row is still there');
        const placeholder = pane.querySelector('.composer textarea').placeholder;
        if (!placeholder.startsWith('Message ')) found.push(name + ': the placeholder says ' + JSON.stringify(placeholder));
        const row = pane.querySelector('.composer .chips');
        const seats = [...pane.querySelectorAll('.composer .chip'), pane.querySelector('.composer .chip-add')];
        if (!row || seats.length !== 4 || seats.includes(null)) { found.push(name + ': ' + seats.filter(Boolean).length + ' of 3 bots and Add bot in the message box'); continue; }
        const box = row.getBoundingClientRect();
        const cut = seats.filter((seat) => { const r = seat.getBoundingClientRect(); return r.width === 0 || r.left < box.left - 1 || r.right > box.right + 1; });
        if (cut.length) found.push(name + ': ' + cut.length + ' badge(s) cut off ' + JSON.stringify({fit: row.dataset.fit, room: box.width, seats: seats.map(s => s.getBoundingClientRect().width), dock: pane.querySelector('.composer').getBoundingClientRect().width}));
      }
      return found.join('; ');`);
    const [width, height] = win.getContentSize();
    try {
      // 900 is the window's minimum width (desktop/main.mjs).
      for (const w of [1600, 1200, 900]) {
        win.setContentSize(w, height);
        let problem = '';
        await until(`the message boxes at ${w}px`, async () => (problem = await problems()) === '', 5_000)
          .catch(async () => { console.error("smoke: room loading diagnostics", await page('return {connection: __deck.backend.machines.connection().get(), chats: [...document.querySelectorAll(".thread-chat")].map(c => c.innerText.slice(0, 600))}')); throw new Error(`at ${w}px: ${problem}`); });
      }
    } finally {
      win.setContentSize(width, height);
    }
    // Populate the saved-agent library through its real editor. sessionSave
    // immediately after reload is raced by App's state persistence and is not
    // a valid way to seed this UI test.
    await page(`document.querySelector('.section-button.agents').click(); return true;`);
    await until('Agents section', () => page(`return Boolean(document.querySelector('.agents-section'))`));
    const created = await page(`return await (async()=>{
      const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
      const setValue = (element, value) => { const proto = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(element, value); element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true })); };
      for (let i=0;i<36;i++) {
        let form=document.querySelector('.agents-section form.add-form');
        if (!form) { [...document.querySelectorAll('.titlebar-end button')].find(button=>button.textContent.trim()==='+ New agent')?.click(); for(let attempt=0;attempt<50&&!form;attempt++){await sleep(20);form=document.querySelector('.agents-section form.add-form');} }
        if (!form) throw new Error('The saved-agent editor did not open.');
        const preset=form.querySelector('select[name="preset"]');if(!preset)throw new Error('The editor has no provider selector.');setValue(preset,'scripted');
        const name=form.querySelector('input[name="name"]');setValue(name,'Saved agent '+String(i).padStart(2,'0')+' with a long name');
        form.requestSubmit();
        for(let attempt=0;attempt<100&&document.querySelector('.agents-section form.add-form');attempt++)await sleep(20);
        if(document.querySelector('.agents-section .form-error'))throw new Error(document.querySelector('.agents-section .form-error').textContent);
      }
      return document.querySelectorAll('.agents-section .agent-card').length;
    })()`);
    if (created !== 36) throw new Error(`The real Agents editor showed ${created} profiles, not 36.`);
    await until('36 profiles persisted through the session API', () => page(`return (await __deck.backend.sessionLoad()).profiles.length===36`));
    await page(`document.querySelector('.section-button.threads').click(); return true;`);
    await until('threads section after populating saved agents', () => page(`return Boolean(document.querySelector('.pane[data-pane-id="smoke-bots-a"]'))`));
  });

  await step('changing Who answers updates the placeholder and recipient badges', async () => {
    await page(`document.querySelector('button[aria-label="Show thread details"]').click(); return true;`);
    await until('the policy control', () => page(`return Boolean(document.querySelector('.chat-options select'))`));
    await page(`
      const control = document.querySelector('.chat-options select');
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
      setter.call(control, 'everyone');
      control.dispatchEvent(new Event('change', { bubbles: true }));
      return true;`);
    await until('everyone in the placeholder', () => page(`
      const pane = document.querySelector('.pane.focused') ?? document.querySelector('.pane');
      return pane.querySelector('textarea').placeholder === 'Message everyone…' && pane.querySelectorAll('.chip.to').length === 3;`), 3_000);
    await page(`document.querySelector('button[aria-label="Close thread details"]').click(); return true;`);
  });

  await step('Add bot stays on screen and a choice remains clickable in a short window', async () => {
    const [width, height] = win.getContentSize();
    try {
      win.setContentSize(900, 600);
      await sleep(300);
      await page(`document.querySelector('.composer .chip-add').click(); return true;`);
      await until('the add-bot choices', () => page(`return document.querySelectorAll('.roster-pop .quick-add-tools [role="radio"]').length > 0`));
      const problem = await page(`
        const form = document.querySelector('.roster-pop .quick-add');
        const rect = form.getBoundingClientRect();
        if (rect.top < 8 || rect.bottom > innerHeight - 8) return 'form outside viewport: ' + JSON.stringify({ top: rect.top, bottom: rect.bottom, height: innerHeight });
        const first = form.querySelector('.quick-add-tools [role="radio"]');
        first.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        const r = first.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        if (!first.contains(hit)) return 'first add-bot choice is not clickable: ' + JSON.stringify({ target: first.outerHTML, hit: hit?.outerHTML, rect: { left:r.left,top:r.top,right:r.right,bottom:r.bottom }, viewport:{ width:innerWidth,height:innerHeight } });
        first.click();
        return '';`);
      if (problem) throw new Error(problem);
      await until('the chosen add-bot tool', () => page(`return Boolean(document.querySelector('.roster-pop .quick-add-tools [role="radio"][aria-checked="true"]'))`));
    } finally {
      win.setContentSize(width, height);
    }
  });

  await step('quitting while an agent replies asks first', async () => {
    // A thread in the window, with a bot that takes its time.
    await page(`
      await __deck.backend.roomCreate('smoke-busy', [${JSON.stringify(shell('slow', 'sleep 30; echo done'))}], ${JSON.stringify(OPTIONS)}, ${JSON.stringify(smokeProject)});
      await __deck.backend.sessionSave({
        version: 1, workspaces: [{ id: 'ws-smoke', name: 'smoke', path: ${JSON.stringify(smokeProject)} }],
        panes: [{ id: 'smoke-busy', workspaceId: 'ws-smoke', kind: 'chat', title: 'Busy' }],
        profiles: [], activeWorkspace: 'ws-smoke', focusedPane: 'smoke-busy', section: 'threads', layout: 'top',
      });
      return true;`);
    contents.reload();
    await sleep(200);
    await ready();
    await listen();
    await page(`void __deck.backend.roomPost('smoke-busy', '@slow go').catch(() => {}); return true;`);
    await until('the turn to start', () => page(`return __smoke.events.some((e) => e.room === 'smoke-busy' && e.event.type === 'turn_started')`));
    await sleep(500);
    // A second message waits for the busy bot, and its badge shows the count at every fit step.
    await page(`
      const box = document.querySelector('.composer textarea');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(box, '@slow next');
      box.dispatchEvent(new Event('input', { bubbles: true }));
      return true;`);
    await page(`document.querySelector('.composer textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return true;`);
    await until('the queued count', () => page(`return Boolean(document.querySelector('.composer .chip-queued'))`), 5_000);
    const hidden = await page(`
      const row = document.querySelector('.composer .chips');
      const was = row.dataset.fit;
      const queued = row.querySelector('.chip-queued');
      const steps = ['full', 'levels', 'names', 'faces'].filter((step) => { row.dataset.fit = step; return getComputedStyle(queued).display === 'none'; });
      row.dataset.fit = was;
      return steps.join(', ');`);
    if (hidden) throw new Error(`the queued count is hidden at: ${hidden}`);
    await page(`document.querySelector('button[aria-label="Remove queued message"]').click(); return true;`);
    await until('the queue to empty', () => page(`return !document.querySelector('.composer .chip-queued')`), 5_000);
    win.close();
    const asked = await until('the question', () => page(`return document.querySelector('[role=alertdialog] #confirm-title')?.textContent ?? ''`), 5_000);
    if (!/still running/.test(asked)) throw new Error(`asked "${asked}"`);
    // Stay, stop the bot, and the next quit asks nothing.
    await page(`[...document.querySelectorAll('[role=alertdialog] button')].find((b) => b.textContent === 'Cancel').click(); return true;`);
    await page(`await __deck.backend.roomStop('smoke-busy'); return true;`);
    await until('the bot to stop', () => page(`return !document.querySelector('[role=alertdialog]')`));
    await sleep(1000);
  });

  return quit(win, sidecar);
}

/**
 * Quit with nothing running: the window answers, nothing is asked, and the
 * app exits 0 after the daemon it started has wound down, which
 * run-smoke.mjs checks by its pid.
 */
function quit(win, sidecar) {
  const daemon = sidecar();
  if (!daemon?.owned) throw new Error('the smoke run should own its daemon');
  fs.writeFileSync(path.join(app.getPath('userData'), 'sidecar.pid'), String(daemon.child.pid));
  console.log('smoke: quitting');
  win.close();
  return null;
}

/**
 * The same window on a saved host over SSH (desktop/run-smoke.mjs --ssh):
 * a chat, a connection that goes quiet mid-reply and comes back, and a
 * daemon that stops. The commands that pause, resume, stop and start the
 * server come from the environment.
 */
async function runRemoteSmoke(win) {
  const { execSync } = await import('node:child_process');
  const env = process.env;
  const host = env.APEX_DECK_SMOKE_HOST;
  const contents = win.webContents;
  const page = (code) => contents.executeJavaScript(`(async () => { ${code} })()`, true);
  async function until(what, test, ms = 30_000) {
    const start = Date.now();
    let last;
    for (;;) {
      try {
        const value = await test();
        if (value) return value;
      } catch (e) {
        last = e;
      }
      if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}${last ? ` (last error: ${last.message})` : ''}`);
      await sleep(250);
    }
  }
  async function step(name, run) {
    const start = Date.now();
    await run();
    console.log(`smoke: ok — ${name} (${Date.now() - start} ms)`);
  }
  const run = (command) => { if (command) execSync(command, { stdio: 'inherit' }); };
  const banner = () => page(`return document.querySelector('.connection-banner')?.innerText ?? ''`);
  const room = `ssh-${Date.now()}`;

  await step(`the window connects to ${host} over SSH`, async () => {
    await until('the UI to connect', () => page(`return Boolean(window.__deck && !document.querySelector('.loading'))`), 60_000);
    if (win.getTitle() !== `Apex Deck — ${host}`) throw new Error(`the title is "${win.getTitle()}"`);
    const current = await page(`return await __deck.backend.hosts.current()`);
    if (!current.remote || current.name !== host) throw new Error(`connected to ${JSON.stringify(current)}`);
  });

  await step('a chat there gets its reply', async () => {
    await page(`
      window.__smoke = { events: [] };
      await __deck.backend.onRoomEvent((room, event) => __smoke.events.push({ room, event }));
      await __deck.backend.roomCreate(${JSON.stringify(room)}, [${JSON.stringify(shell('bot', 'echo hello over ssh'))}], ${JSON.stringify(OPTIONS)}, '');
      await __deck.backend.roomPost(${JSON.stringify(room)}, '@bot hi');
      return true;`);
    await until('the reply', () => page(`return __smoke.events.some((e) => e.event.type === 'message_added' && e.event.message.text === 'hello over ssh')`));
  });

  await step('the folder picker looks through the host\'s folders and picks one', async () => {
    const shown = () => page(`
      const list = document.querySelector('.folder-list');
      const first = list?.querySelector('button span');
      if (!list || list.getAttribute('aria-busy') === 'true') return null;
      return { at: document.querySelector('.folder-bar input').value, first: first?.textContent ?? null };`);
    const click = (selector) => page(`document.querySelector(${JSON.stringify(selector)}).click(); return true;`);
    await page(`window.__picked = __deck.backend.pickFolder(); return true;`);
    const home = await until('the home folder\'s list', async () => { const now = await shown(); return now?.first && now; });
    await click('.folder-list button');
    const inside = await until('the folder to open', async () => { const now = await shown(); return now && now.at !== home.at && now; });
    if (!inside.at.endsWith(`/${home.first}`)) throw new Error(`opened ${inside.at}, not ${home.first}`);
    await click('[aria-label="Enclosing folder"]');
    await until('the way back up', async () => (await shown())?.at === home.at);
    await click('.folder-list button');
    await until('the folder again', async () => (await shown())?.at === inside.at);
    await click('.path-prompt button[type="submit"]');
    const picked = await page(`return await window.__picked`);
    if (picked !== inside.at) throw new Error(`picked ${picked}, not ${inside.at}`);
    console.log(`smoke: picked ${picked}`);
  });

  if (env.APEX_DECK_SMOKE_PAUSE) await step('a connection that goes quiet mid-reply comes back with the reply, once', async () => {
    await page(`
      await __deck.backend.roomAddParticipant(${JSON.stringify(room)}, ${JSON.stringify(shell('slow', 'sleep 20; echo after the pause'))});
      void __deck.backend.roomPost(${JSON.stringify(room)}, '@slow go').catch(() => {});
      return true;`);
    await until('the turn to start', () => page(`return __smoke.events.some((e) => e.event.type === 'turn_started' && e.event.id === 'slow')`));
    run(env.APEX_DECK_SMOKE_PAUSE);
    const shown = await until('the banner', async () => /Reconnecting/.test(await banner()) && banner(), 90_000);
    console.log(`smoke: the banner said: ${shown.replace(/\s+/g, ' ')}`);
    await sleep(Math.max(0, 60_000 - 45_000));
    run(env.APEX_DECK_SMOKE_RESUME);
    await page(`return true`);
    await until('the reply after the pause', () => page(`return __smoke.events.some((e) => e.event.type === 'message_added' && e.event.message.text === 'after the pause')`), 120_000);
    await until('the banner to go', async () => (await banner()) === '', 60_000);
    await sleep(2000);
    const count = await page(`return __smoke.events.filter((e) => e.event.type === 'message_added' && e.event.message.text === 'after the pause').length`);
    if (count !== 1) throw new Error(`the reply arrived ${count} times`);
  });

  if (env.APEX_DECK_SMOKE_STOP) await step('a stopped daemon is named in the banner', async () => {
    run(env.APEX_DECK_SMOKE_STOP);
    try {
      const shown = await until('the daemon\'s words', async () => /apex-daemon/.test(await banner()) && banner(), 60_000);
      console.log(`smoke: the banner said: ${shown.replace(/\s+/g, ' ')}`);
    } finally {
      run(env.APEX_DECK_SMOKE_START);
    }
  });

  console.log('smoke: quitting');
  win.close();
  return null;
}

/** Pages for the docked browser, on `port` or any free one: one that signs in (sets a cookie), and one that misbehaves. */
function serveSite(port = 0) {
  const server = http.createServer((request, response) => {
    response.setHeader('content-type', 'text/html');
    if (request.url === '/evil') {
      response.end(`<title>evil</title><p>evil</p><script>
        try { window.open('app://deck/'); } catch {}
        try { window.open('file:///etc/passwd'); } catch {}
        setTimeout(() => { try { top.location = 'app://deck/#taken'; } catch {} }, 50);
      </script>`);
      return;
    }
    response.end(`<title>smoke page</title><body>hello<script>document.cookie = 'deck_login=kept; max-age=86400; path=/';</script></body>`);
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() })));
}

/** The second launch on the same folders: the sign-in from the first is still there. */
async function runAgain(win, sidecar) {
  const contents = win.webContents;
  const start = Date.now();
  while (!(await contents.executeJavaScript(`Boolean(window.__deck && !document.querySelector('.loading'))`).catch(() => false))) {
    if (Date.now() - start > 30_000) throw new Error('the second launch never connected');
    await sleep(50);
  }
  const cookies = await session.fromPartition(PARTITION).cookies.get({ domain: '127.0.0.1', name: 'deck_login' });
  if (cookies.length !== 1 || cookies[0].value !== 'kept') throw new Error(`the docked browser's cookie is gone (${JSON.stringify(cookies)})`);
  console.log('smoke: ok — a cookie set in the docked browser survives a restart of the app');
  const again = await contents.executeJavaScript(`localStorage.getItem('apex-deck.smoke.tauri')`);
  if (again !== null) throw new Error(`the Tauri app's storage came over a second time (${JSON.stringify(again)})`);
  console.log("smoke: ok — the Tauri app's storage comes over only once");

  // Logging out or shutting down never waits on a question, even with a bot replying.
  await contents.executeJavaScript(`(async () => {
    window.__smoke = { events: [], failure: '', dispatch: 'starting' };
    await __deck.backend.onRoomEvent((room, event) => __smoke.events.push({ room, event }));
    // Opened as the restored thread pane opens it, whichever gets there first.
    try {
      window.__smoke.room = await __deck.backend.roomCreate('smoke-busy', [], ${JSON.stringify(OPTIONS)}, '');
      // This restored-room probe needs an observable background dispatch: the
      // compatibility roomPost command waits for the whole worker batch.
      window.__smoke.dispatch = 'pending';
      void __deck.backend.roomPostTo('smoke-busy', '@slow go', ['slow']).then(() => { window.__smoke.dispatch = 'resolved'; }, (error) => { window.__smoke.dispatch = 'rejected'; window.__smoke.failure = String(error); });
    } catch (error) { window.__smoke.failure = String(error); }
  })()`);
  const dataRoot = process.env.APEX_DECK_DATA_DIR;
  const savedRoomFile = dataRoot ? path.join(dataRoot, 'saved-chats-v1', 'rooms', `${Buffer.from('smoke-busy').toString('hex')}.json`) : '';
  const savedRoom = JSON.parse(await fs.promises.readFile(savedRoomFile, 'utf8'));
  const expectedCwd = path.join(app.getPath('userData'), 'smoke-project');
  if (savedRoom.cwd !== expectedCwd) throw new Error(`the restored busy room uses cwd ${JSON.stringify(savedRoom.cwd)}, expected isolated project ${JSON.stringify(expectedCwd)}`);
  console.log(`smoke: restored room cwd is isolated to ${savedRoom.cwd}`);
  while (!(await contents.executeJavaScript(`__smoke.events.some((e) => e.room === 'smoke-busy' && e.event.type === 'turn_started')`))) {
    if (Date.now() - start > 60_000) {
      const diagnostic = await contents.executeJavaScript(`(async()=>({failure:__smoke.failure,dispatch:__smoke.dispatch,room:__smoke.room,roomState:await __deck.backend.roomState('smoke-busy').catch(error=>({error:String(error)})),session:await __deck.backend.sessionLoad(),events:__smoke.events.filter(e=>e.room==='smoke-busy')}))()`);
      const root = process.env.APEX_DECK_DATA_DIR;
      const roomFile = root ? path.join(root, 'saved-chats-v1', 'rooms', `${Buffer.from('smoke-busy').toString('hex')}.json`) : '';
      try { diagnostic.savedRoomCwd = JSON.parse(await fs.promises.readFile(roomFile, 'utf8')).cwd; }
      catch (error) { diagnostic.savedRoomFile = { path: roomFile, error: String(error) }; }
      const registry = root ? path.join(root, 'worker-processes', 'smoke-busy') : '';
      const files = [];
      async function walk(directory) {
        if (!directory) return;
        let entries;
        try { entries = await fs.promises.readdir(directory, { withFileTypes: true }); } catch (error) { files.push({ path: directory, error: String(error) }); return; }
        for (const entry of entries) {
          const child = path.join(directory, entry.name);
          if (entry.isDirectory()) await walk(child);
          else {
            try { files.push({ path: child.slice(registry.length + 1), content: await fs.promises.readFile(child, 'utf8') }); }
            catch (error) { files.push({ path: child.slice(registry.length + 1), error: String(error) }); }
          }
        }
      }
      await walk(registry);
      diagnostic.workerProcessRegistry = { root: registry, files };
      throw new Error(`the bot never started in the second launch: ${JSON.stringify(diagnostic)}`);
    }
    await sleep(50);
  }
  await sleep(500);
  const daemon = sidecar();
  fs.writeFileSync(path.join(app.getPath('userData'), 'sidecar.pid'), String(daemon.child.pid));
  console.log('smoke: logging out while a bot replies');
  powerMonitor.emit('shutdown', { preventDefault() {} });
  app.quit();
  // The app should be gone well before this; a question means it waited.
  await sleep(5_000);
  const asked = await contents.executeJavaScript(`document.querySelector('[role=alertdialog] #confirm-title')?.textContent ?? ''`).catch(() => '');
  throw new Error(`logging out didn't quit${asked ? `; it asked "${asked}"` : ''}`);
}
