// The docked browser: a real Chromium page for each Preview pane, drawn over
// its place in the window. Pages share one saved profile, so sign-ins last,
// and get no preload and no Node: they can't reach the Deck window or its bridge.

import { session as sessions, shell, WebContentsView } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { deckKey } from './browser-keys.mjs';
import { safeName } from './files.mjs';

export const PARTITION = 'persist:deck-browser';

const web = (url) => {
  try {
    return ['http:', 'https:'].includes(new URL(url).protocol);
  } catch {
    return false;
  }
};

/** What a pane may be pointed at: web pages, and data: pages the deck makes itself. */
const loadable = (url) => web(url) || String(url).startsWith('data:');

/** A name in `dir` nothing has taken yet, numbered before the extension. */
function freeName(dir, name) {
  const safe = (() => {
    try {
      return safeName(name);
    } catch {
      return 'download';
    }
  })();
  const dot = safe.lastIndexOf('.');
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? safe : dot > 0 ? `${safe.slice(0, dot)} (${n})${safe.slice(dot)}` : `${safe} (${n})`;
    if (!fs.existsSync(path.join(dir, candidate))) return path.join(dir, candidate);
  }
}

/**
 * The docked pages of `win`. `send(channel, ...args)` reaches the Deck window:
 * `browser:state` (pane, state) and `browser:shortcut` (a key press the deck owns).
 */
export function dockedBrowser({ win, send, downloads }) {
  const profile = sessions.fromPartition(PARTITION);
  // Clipboard writes (a page's Copy button) and fullscreen video; nothing else.
  const allowed = new Set(['clipboard-sanitized-write', 'fullscreen']);
  profile.setPermissionRequestHandler((_contents, permission, done) => done(allowed.has(permission)));
  profile.setPermissionCheckHandler((_contents, permission) => allowed.has(permission));
  profile.on('will-download', (_event, item) => item.setSavePath(freeName(downloads(), item.getFilename())));

  /** pane id → { view, shown } */
  const panes = new Map();
  const mac = process.platform === 'darwin';

  function create(pane) {
    const view = new WebContentsView({
      webPreferences: { partition: PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    const page = view.webContents;
    const state = (extra = {}) => send('browser:state', pane, {
      url: page.getURL(),
      title: page.getTitle(),
      loading: page.isLoading(),
      canGoBack: page.navigationHistory.canGoBack(),
      canGoForward: page.navigationHistory.canGoForward(),
      ...extra,
    });
    for (const event of ['did-start-loading', 'did-stop-loading', 'did-navigate', 'did-navigate-in-page', 'page-title-updated']) {
      page.on(event, () => state());
    }
    page.on('did-fail-load', (_event, code, description, url, mainFrame) => {
      // -3 is a load stopped by another one starting.
      if (mainFrame && code !== -3) state({ error: { code, description, url } });
    });
    // Only web pages; nothing a page does takes it to app:// or file://.
    page.on('will-navigate', (event, url) => { if (!web(url)) event.preventDefault(); });
    page.on('will-redirect', (event, url) => { if (!web(url)) event.preventDefault(); });
    // Sign-in flows open popups: they get their own window on the same profile.
    page.setWindowOpenHandler(({ url }) => (web(url)
      ? { action: 'allow', overrideBrowserWindowOptions: { parent: win, webPreferences: { partition: PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false } } }
      : { action: 'deny' }));
    page.on('did-create-window', (child) => {
      child.webContents.on('will-navigate', (event, url) => { if (!web(url)) event.preventDefault(); });
    });
    // The deck's own shortcuts work while the page has focus.
    page.on('before-input-event', (event, input) => {
      if (!deckKey(input, mac)) return;
      event.preventDefault();
      send('browser:shortcut', { code: input.code, key: input.key, metaKey: input.meta, ctrlKey: input.control, shiftKey: input.shift, altKey: input.alt });
    });
    const entry = { view, shown: false, url: '' };
    panes.set(pane, entry);
    return entry;
  }

  const load = (entry, url) => {
    entry.url = url;
    entry.view.webContents.loadURL(url).catch(() => {});
  };

  return {
    /** Put the pane's page at `bounds` and show it, loading `url` the first time or when it changed. */
    show(pane, bounds, url) {
      const entry = panes.get(pane) ?? create(pane);
      // Bounds before the view joins the window: a view added with none
      // stays blank, and hidden from accessibility, until the next resize.
      entry.view.setBounds(bounds);
      if (!entry.shown) {
        win.contentView.addChildView(entry.view);
        entry.shown = true;
      }
      if (url && url !== entry.url && loadable(url)) {
        load(entry, url);
        entry.view.webContents.focus();
      }
    },
    bounds(pane, bounds) {
      panes.get(pane)?.view.setBounds(bounds);
    },
    /** Take the view out of the window, keeping its page. With `snapshot`, a picture of it first. */
    async hide(pane, snapshot) {
      const entry = panes.get(pane);
      if (!entry?.shown) return null;
      // A window that isn't on screen has nothing to capture; the pane is left empty then.
      const picture = snapshot ? (await entry.view.webContents.capturePage().catch(() => null))?.toDataURL() ?? null : null;
      win.contentView.removeChildView(entry.view);
      entry.shown = false;
      return picture;
    },
    navigate(pane, url) {
      const entry = panes.get(pane);
      if (entry && loadable(url)) load(entry, url);
    },
    reload: (pane) => panes.get(pane)?.view.webContents.reload(),
    back: (pane) => panes.get(pane)?.view.webContents.navigationHistory.goBack(),
    forward: (pane) => panes.get(pane)?.view.webContents.navigationHistory.goForward(),
    close(pane) {
      const entry = panes.get(pane);
      if (!entry) return;
      if (entry.shown) win.contentView.removeChildView(entry.view);
      entry.view.webContents.close();
      panes.delete(pane);
    },
    /** Take every page out of the window, keeping them, as the window reloads; it shows them again. */
    hideAll() {
      for (const entry of panes.values()) {
        if (entry.shown) win.contentView.removeChildView(entry.view);
        entry.shown = false;
      }
    },
    openExternal: (url) => { if (web(url)) void shell.openExternal(url); },
    /** Whether the pane's page is in the window, where, and its contents; for the smoke test. */
    inspect(pane) {
      const entry = panes.get(pane);
      return entry ? { shown: entry.shown, bounds: entry.view.getBounds(), contents: entry.view.webContents } : null;
    },
    /** Write cookies and other saved state to disk before the app exits. */
    async flush() {
      await profile.cookies.flushStore().catch(() => {});
      profile.flushStorageData();
    },
  };
}
