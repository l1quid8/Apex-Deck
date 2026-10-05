// `npm run desktop:smoke`: drive the real app, on a real apex-daemon, through
// the backend the window exposes when APEX_DECK_SMOKE=1. Resolves with the
// exit code; any failed check ends the run.

import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';

const OPTIONS = { policy: 'mention', max_bot_hops: 3 };
const shell = (id, script) => ({ id, display_name: id, backend: { kind: 'cli', program: 'sh', args: ['-c', script] } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Resolves with the exit code, or null once it has started a quit the way
 * the person would; desktop/run-smoke.mjs then checks the app and the daemon
 * it started are gone.
 */
export async function runSmoke(win, { sidecar }) {
  if (process.env.APEX_DECK_SMOKE_HOST) return runRemoteSmoke(win);
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

  // Quit with nothing running: the window answers, nothing is asked, and the
  // app exits 0 after the daemon it started has wound down.
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

  await step('a connection that goes quiet mid-reply comes back with the reply, once', async () => {
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

  await step('a stopped daemon is named in the banner', async () => {
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
