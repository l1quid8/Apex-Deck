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
          version: 1, workspaces: [{ id: 'ws-smoke', name: 'smoke', path: '/tmp' }],
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

  await step('a second window runs on another host, names it, and closes on its own', async () => {
    const saved = () => JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'hosts.json'), 'utf8')).windows;
    // A host nothing answers at, so the new window sits on its loading screen.
    const list = await page(`return await __deck.backend.hosts.add({ name: 'nowhere', ssh: 'nowhere.invalid', command: 'apex-daemon' })`);
    const id = list.find((host) => host.name === 'nowhere').id;
    await page(`await __deck.backend.hosts.openWindow(${JSON.stringify(id)}); return true;`);
    const other = await until('the second window', () => BrowserWindow.getAllWindows().find((w) => w !== win && w.getTitle() === 'Apex Deck — nowhere'));
    const words = await until('the second window to name its host', async () => {
      const shown = await other.webContents.executeJavaScript(`document.querySelector('.loading')?.innerText ?? ''`);
      return /Reconnecting to nowhere|Can't connect to nowhere/.test(shown) && shown;
    }, 30_000);
    if (!/Use This Mac/.test(words)) throw new Error(`no way back to this Mac on: ${words.replace(/\s+/g, ' ')}`);
    // Asking again brings that window forward instead of making another.
    await page(`await __deck.backend.hosts.openWindow(${JSON.stringify(id)}); return true;`);
    await sleep(300);
    if (BrowserWindow.getAllWindows().length !== 2) throw new Error(`${BrowserWindow.getAllWindows().length} windows are open`);
    const both = saved();
    if (JSON.stringify(both) !== JSON.stringify(['local', id])) throw new Error(`hosts.json keeps windows ${JSON.stringify(both)}`);
    const hosts = await page(`return await __deck.backend.hosts.list()`);
    if (!hosts.every((host) => host.open)) throw new Error(`the list doesn't show both open: ${JSON.stringify(hosts)}`);
    // Closing it asks nothing, and this window stays connected.
    other.close();
    await until('the second window to close', () => other.isDestroyed(), 5_000);
    if (JSON.stringify(saved()) !== JSON.stringify(['local'])) throw new Error(`hosts.json keeps windows ${JSON.stringify(saved())}`);
    await page(`await __deck.backend.hosts.remove(${JSON.stringify(id)}); return true;`);
    if (await page(`return document.querySelector('.connection-banner')?.innerText ?? ''`)) throw new Error('this window lost its host');
    if ((await page(`return (await __deck.backend.hosts.current()).id`)) !== 'local') throw new Error('this window moved');
  });

  await step('quitting while an agent replies asks first', async () => {
    // A thread in the window, with a bot that takes its time.
    await page(`
      await __deck.backend.roomCreate('smoke-busy', [${JSON.stringify(shell('slow', 'sleep 30; echo done'))}], ${JSON.stringify(OPTIONS)}, '');
      await __deck.backend.sessionSave({
        version: 1, workspaces: [{ id: 'ws-smoke', name: 'smoke', path: '/tmp' }],
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

/** Pages for the docked browser: one that signs in (sets a cookie), and one that misbehaves. */
function serveSite() {
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
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() })));
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

  // Logging out or shutting down never waits on a question, even with a bot replying.
  await contents.executeJavaScript(`(async () => {
    window.__smoke = { events: [] };
    await __deck.backend.onRoomEvent((room, event) => __smoke.events.push({ room, event }));
    // Opened as the restored thread pane opens it, whichever gets there first.
    await __deck.backend.roomCreate('smoke-busy', [], ${JSON.stringify(OPTIONS)}, '');
    void __deck.backend.roomPost('smoke-busy', '@slow go').catch(() => {});
  })()`);
  while (!(await contents.executeJavaScript(`__smoke.events.some((e) => e.room === 'smoke-busy' && e.event.type === 'turn_started')`))) {
    if (Date.now() - start > 60_000) throw new Error('the bot never started in the second launch');
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
