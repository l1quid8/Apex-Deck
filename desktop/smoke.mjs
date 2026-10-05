// `npm run desktop:smoke`: drive the real app, on a real apex-daemon, through
// the backend the window exposes when APEX_DECK_SMOKE=1. Resolves with the
// exit code; any failed check ends the run.

const OPTIONS = { policy: 'mention', max_bot_hops: 3 };
const shell = (id, script) => ({ id, display_name: id, backend: { kind: 'cli', program: 'sh', args: ['-c', script] } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function runSmoke(win) {
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

  return 0;
}
