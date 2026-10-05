// Spike: embedded Chromium pane inside a Deck-like window, driven by an "agent" over CDP.
const { app, BaseWindow, WebContentsView, ipcMain, session } = require('electron');
const path = require('path');

const SIDEBAR = 320;
let win, ui, browser;

function layout() {
  const { width, height } = win.getContentBounds();
  ui.setBounds({ x: 0, y: 0, width: SIDEBAR, height });
  browser.setBounds({ x: SIDEBAR, y: 0, width: width - SIDEBAR, height });
}

async function cdp(method, params = {}) {
  return browser.webContents.debugger.sendCommand(method, params);
}

// Agent primitives: real input events through CDP, same as Playwright would send.
const agent = {
  async navigate(url) {
    await browser.webContents.loadURL(url);
  },
  async click(selector) {
    const { result } = await cdp('Runtime.evaluate', {
      expression: `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
        return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 }); })()`,
    });
    const { x, y } = JSON.parse(result.value);
    for (const type of ['mousePressed', 'mouseReleased'])
      await cdp('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
  },
  async type(text) {
    await cdp('Input.insertText', { text });
  },
  async eval(expression) {
    return (await cdp('Runtime.evaluate', { expression, returnByValue: true })).result.value;
  },
  async screenshot() {
    return (await cdp('Page.captureScreenshot', { format: 'png' })).data.length;
  },
};

app.whenReady().then(async () => {
  win = new BaseWindow({ width: 1280, height: 800, title: 'Apex Deck — browser spike' });
  ui = new WebContentsView({ webPreferences: { preload: path.join(__dirname, 'preload.js') } });
  // Persistent partition: cookies/logins survive restarts.
  browser = new WebContentsView({ webPreferences: { partition: 'persist:deck-browser' } });
  win.contentView.addChildView(ui);
  win.contentView.addChildView(browser);
  win.on('resize', layout);
  layout();

  browser.webContents.debugger.attach('1.3');
  ui.webContents.loadFile('ui.html');
  await agent.navigate('https://example.com').catch((e) => console.error('initial load:', e.message));

  ipcMain.handle('agent', (_e, op, ...args) => agent[op](...args));

  if (process.env.SPIKE_AUTOTEST) await autotest();
});

async function autotest() {
  const results = {};
  const check = (name, ok) => { results[name] = ok ? 'PASS' : 'FAIL'; };
  try {
    // 1. Docked: browser view occupies the pane next to the Deck UI.
    check('docked', browser.getBounds().x === SIDEBAR);

    // 2. Agent click + type on a real page.
    await agent.navigate('data:text/html,<input id=q><button id=b onclick="document.title=q.value">go</button>');
    await agent.click('#q');
    await agent.type('hello deck');
    await agent.click('#b');
    check('agent_click_type', (await agent.eval('document.title')) === 'hello deck');
    check('screenshot', (await agent.screenshot()) > 0);

    // 3. Persistence: cookie written to disk-backed partition.
    const ses = session.fromPartition('persist:deck-browser');
    const prior = await ses.cookies.get({ name: 'spike' });
    results.persist_prior_run = prior.length ? 'PASS (cookie from previous run)' : 'n/a (first run, rerun to verify)';
    await ses.cookies.set({ url: 'https://example.com', name: 'spike', value: String(Date.now()), expirationDate: Date.now() / 1000 + 86400 });
    await ses.cookies.flushStore();

    // 4. Resize: pane follows window.
    win.setContentSize(1000, 700);
    layout();
    const b = browser.getBounds();
    check('resize', b.width === 1000 - SIDEBAR && b.height === 700);
  } catch (e) {
    results.error = String(e);
  }
  console.log(JSON.stringify(results, null, 2));
  app.quit();
}
