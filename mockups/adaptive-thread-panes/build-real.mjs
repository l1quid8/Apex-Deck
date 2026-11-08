// Builds mockups/adaptive-thread-panes.html from a frozen capture of Deck's
// real UI (base-real.html, made by capture-real.mjs with the user's own
// Clay Black appearance). Every visible piece — title bar, sidebar, pane
// head, messages, composer, bot chips, Details panel, menus — is a clone of
// the real DOM; only the pane arrangement, the shared composer's "To" line
// and the free-resize dividers are new (mk- prefix).
//
//   node mockups/adaptive-thread-panes/build-real.mjs
import { chromium } from '../../node_modules/playwright/index.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { identiconCells } from '../../src/identicon.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(here, '..', 'adaptive-thread-panes.html');
const base = fs.readFileSync(path.join(here, 'base-real.html'), 'utf8');
const data = fs.readFileSync(path.join(here, 'data.js'), 'utf8');
const bots = JSON.parse(fs.readFileSync(path.join(here, 'bots-real.json'), 'utf8'));
const cells = Object.fromEntries(Object.values(bots).map((b) => [b.seed, identiconCells(b.seed).map((c) => c.on)]));
cells.__fallback = identiconCells('apex-agent').map((c) => c.on);
// Agents made with "+ Another agent" get one of these seeds, so each has its own face.
const SPARE_SEEDS = Array.from({ length: 12 }, (_, i) => `mk-new-agent-${i}`);
for (const seed of SPARE_SEEDS) cells[seed] = identiconCells(seed).map((c) => c.on);
const mkCss = fs.readFileSync(path.join(here, 'real-mk.css'), 'utf8');
const runtime = fs.readFileSync(path.join(here, 'real-app.js'), 'utf8');
// The "Who's in this thread?" add menu, captured from the live preview after
// + Add bots in a new group chat (capture of 2026-11-08, Claude Code editor open).
const quickAdd = fs.readFileSync(path.join(here, 'quick-add-real.html'), 'utf8');

// The pane ⋯ menu and the layout picker popover, captured from the live preview (probe3).
const PANE_MENU = `<span class="pane-menu deck-menu" role="menu"><button role="menuitem" data-key="rename"><span class="label">Rename</span><span class="keys">⌥⌘R</span></button><button role="menuitem" data-key="pin"><span class="label">Pin</span><span class="keys">⌥⌘P</span></button><button role="menuitem" data-key="mark_unread"><span class="label">Mark as unread</span><span class="keys">⇧⌘U</span></button><button role="menuitem" data-key="project" aria-haspopup="menu" aria-expanded="false"><span class="label">Project</span><span class="more" aria-hidden="true">›</span></button><span class="pane-menu-sep" role="separator"></span><button role="menuitem" data-key="share_pdf"><span class="label">Share as PDF</span></button><button role="menuitem" data-key="copy" aria-haspopup="menu" aria-expanded="false"><span class="label">Copy</span><span class="more" aria-hidden="true">›</span></button><button role="menuitem" data-key="fork"><span class="label">Fork</span></button><button role="menuitem" data-key="export"><span class="label">Export</span></button><button role="menuitem" data-key="popout"><span class="label">Open in new window</span></button><span class="pane-menu-sep" role="separator"></span><button role="menuitem" data-key="archive"><span class="label">Archive</span><span class="keys">⇧⌘A</span></button><button role="menuitem" class="danger-text" data-key="delete"><span class="label">Delete…</span></button></span>`;
const LAYOUT_POPOVER = `<div class="layout-picker-popover" role="menu" aria-label="Pane layout"><div class="layout-picker-heading">Arrange panes</div><button class="layout-choice" role="menuitemradio" data-layout="horizontal"><span class="layout-preview mk-layout-preview-rows" aria-hidden="true"><i></i><i></i><i></i></span><span class="layout-choice-copy"><strong>Horizontal <span class="mk-new">new</span></strong><small>Wide rows, scroll down</small></span></button><button class="layout-choice" role="menuitemradio" data-layout="vertical"><span class="layout-preview mk-layout-preview-cols" aria-hidden="true"><i></i><i></i><i></i></span><span class="layout-choice-copy"><strong>Vertical <span class="mk-new">new</span></strong><small>Tall columns, scroll sideways</small></span></button><button class="layout-choice" role="menuitemradio" data-layout="grid"><span class="layout-preview layout-preview-grid" aria-hidden="true"><i></i><i></i><i></i><i></i></span><span class="layout-choice-copy"><strong>Even grid</strong><small>Give every pane equal space</small></span></button><button class="layout-choice" role="menuitemradio" data-layout="left"><span class="layout-preview layout-preview-left" aria-hidden="true"><i></i><i></i><i></i></span><span class="layout-choice-copy"><strong>Focus left</strong><small>One tall pane on the left</small></span></button><button class="layout-choice" role="menuitemradio" data-layout="right"><span class="layout-preview mk-layout-preview-right" aria-hidden="true"><i></i><i></i><i></i></span><span class="layout-choice-copy"><strong>Focus right <span class="mk-new">new</span></strong><small>One tall pane on the right</small></span></button></div>`;

const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1512, height: 945 } });
await page.setContent(base, { waitUntil: 'load' });
const html = await page.evaluate(({ PANE_MENU, LAYOUT_POPOVER, QUICK_ADD }) => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const template = (id, node) => { const t = document.createElement('template'); t.id = id; t.content.append(node); document.body.append(t); };
  const fromHtml = (markup) => { const t = document.createElement('template'); t.innerHTML = markup; return t.content.firstElementChild; };

  // Title bar: "Preview mode" becomes the mockup's Reset; Threads loses the preview's error flag.
  const reset = document.createElement('button');
  reset.type = 'button'; reset.id = 'mk-reset'; reset.className = 'badge mk-reset';
  reset.title = 'Mockup only: reset layout, drafts and test sends'; reset.textContent = 'Mockup · Reset';
  $('.titlebar-start .badge').replaceWith(reset);
  $('.section-button.threads').className = 'section-button threads selected';

  // Sidebar: keep Projects → This Mac → one project (apex-deck) and Trash, like the user's sidebar.
  const scroll = $('.rail-scroll');
  const kids = [...scroll.children];
  const projects = kids.find((el) => el.classList.contains('rail-sec') && /Projects/.test(el.textContent));
  for (const el of kids) { if (el === projects) break; el.remove(); }
  for (const el of $$(':scope > .rail-sec, :scope > .pane-row', scroll)) if (el !== projects) el.remove();
  $('.project-host-count').id = 'mk-host-count';
  const wsRow = $('.ws-row');
  const wsName = $('.ws-name', wsRow);
  wsName.title = 'apex-deck'; wsName.setAttribute('aria-label', 'apex-deck'); wsName.removeAttribute('data-workspace');
  const wsTitle = $('.ws-title', wsRow); wsTitle.textContent = 'apex-deck'; wsTitle.title = 'apex-deck'; wsTitle.setAttribute('aria-label', 'Rename apex-deck');
  $$('.row-acts button', wsRow).forEach((b) => { b.setAttribute('aria-label', b.getAttribute('aria-label').replace('Sample', 'apex-deck')); if (b.title) b.title = b.title.replace('Sample', 'apex-deck'); });
  const row = $('.ws .pane-row').cloneNode(true);
  row.className = 'pane-row'; row.removeAttribute('data-pane-row');
  template('mk-tpl-row', row);
  $$('.ws .pane-row').forEach((el) => el.remove());
  $('.ws').id = 'mk-ws';

  // New-thread landing (the captured "Group chat" pane with no bots yet).
  const landing = $$('.grid section.pane .transcript .empty').find((el) => $('.empty-copy', el));
  template('mk-tpl-empty', landing.cloneNode(true));

  // Pane, messages and composer pieces.
  const firstPane = $('.grid section.pane');
  const composer = $('.composer', firstPane);
  composer.remove();
  const human = $('.message-row.human-row', firstPane).cloneNode(true);
  human.removeAttribute('data-seq'); $$('time', human).forEach((t) => t.remove());
  template('mk-tpl-human', human);
  const bot = $('.bot-row', firstPane).cloneNode(true);
  $$('time', bot).forEach((t) => t.remove());
  $('.md', bot).replaceChildren();
  $('.bubble', bot).removeAttribute('data-seq');
  template('mk-tpl-bot', bot);
  const pane = firstPane.cloneNode(true);
  pane.className = 'pane'; pane.removeAttribute('style');
  $('.transcript', pane).replaceChildren();
  template('mk-tpl-pane', pane);
  const grid = $('.grid');
  grid.replaceChildren(); grid.id = 'mk-grid'; grid.className = 'grid mk-grid'; grid.removeAttribute('style');

  // One shared composer under the grid, built from the real one.
  const chip = $('.chip-wrap', composer).cloneNode(true);
  template('mk-tpl-chip', chip);
  $$('.chip-wrap', composer).forEach((el) => el.remove());
  $('textarea', composer).id = 'mk-input';
  $('textarea', composer).textContent = '';
  const to = document.createElement('div');
  to.className = 'mk-to'; to.id = 'mk-to';
  $('.composer-input', composer).prepend(to);
  const shared = document.createElement('div');
  shared.className = 'chat thread-chat mk-shared'; shared.id = 'mk-shared';
  shared.append(composer);
  grid.parentElement.after(shared);

  // Details panel follows the selected thread.
  $('.details-head strong').id = 'mk-det-title';
  $('.details-head p').id = 'mk-det-sub';
  const detBot = $('.details-bot').cloneNode(true);
  template('mk-tpl-detbot', detBot);
  $$('#details-bots-body .details-bot').forEach((el) => el.remove());

  // Add menu: the real form. With saved agents Deck starts with the new-bot
  // editor closed and the saved agents as tiles (ChatPane AgentTile), so drop
  // the editor and add the Saved agents section in Deck's own markup.
  const qa = fromHtml(QUICK_ADD);
  // Keep the captured new-agent editor as its own template; "+ Another agent"
  // clones it, the way Deck adds one editor per new agent (up to 4).
  const editor = $('.quick-add-editor', qa);
  editor.remove();
  template('mk-tpl-qaeditor', editor);
  const newSec = $('.quick-add-section', qa);
  newSec.before(fromHtml('<div class="quick-add-section"><span class="quick-add-label">Saved agents</span><span class="quick-add-count">0 picked</span></div>'), fromHtml('<div class="quick-add-saved"></div>'));
  $('.quick-add-faces', qa).replaceChildren();
  template('mk-tpl-quickadd', qa);
  const tile = fromHtml('<button type="button" class="quick-add-tile" role="checkbox" aria-checked="false"><span class="quick-add-tick" aria-hidden="true">✓</span><span class="quick-add-tile-name"></span></button>');
  const face = document.getElementById('mk-tpl-chip').content.querySelector('.identicon').cloneNode(true);
  face.className = 'identicon identicon-md';
  tile.insertBefore(face, $('.quick-add-tile-name', tile));
  template('mk-tpl-tile', tile);

  // "Bot" becomes "agent" everywhere a person can read it (labels, tooltips,
  // screen-reader names). Class names, styles and scripts are left alone.
  const agentify = (root) => {
    const swap = (txt) => txt.replace(/\b(an?\s+)?([Bb])ot(s?)\b/g, (m, art, b, pl) => (art ? (art[0] === 'A' ? 'An ' : 'an ') : '') + (b === 'B' ? 'Agent' : 'agent') + pl);
    const walk = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    for (let n = walk.currentNode; n; n = walk.nextNode()) {
      if (n.nodeType === 3) { if (!n.parentElement || !n.parentElement.closest('style, script')) n.nodeValue = swap(n.nodeValue); continue; }
      if (n.nodeType !== 1 || n.matches('style, script')) continue;
      for (const a of ['aria-label', 'title', 'placeholder']) if (n.hasAttribute(a)) n.setAttribute(a, swap(n.getAttribute(a)));
      if (n.localName === 'template') agentify(n.content);
    }
  };

  template('mk-tpl-menu', fromHtml(PANE_MENU));
  template('mk-tpl-layout', fromHtml(LAYOUT_POPOVER));
  agentify(document.body);
  for (const t of $$('template')) agentify(t.content);
  return '<!doctype html>\n' + document.documentElement.outerHTML;
}, { PANE_MENU, LAYOUT_POPOVER, QUICK_ADD: quickAdd });
await browser.close();

const inject = `<style id="mk-style">\n${mkCss}\n</style>\n<script>\n${data}\nwindow.MK_BOTS = ${JSON.stringify(bots)};\nwindow.MK_CELLS = ${JSON.stringify(cells)};\nwindow.MK_SPARE_SEEDS = ${JSON.stringify(SPARE_SEEDS)};\n</script>\n<script>\n${runtime}\n</script>\n`;
let out = html.replace('</body>', () => `${inject}</body>`).replace('<title>Apex Deck capture</title>', '<title>Adaptive thread panes · zoom map mockup</title>');
if (/\/Users\//.test(out)) throw new Error('output contains a /Users/ path');
fs.writeFileSync(OUT, out);
console.log('wrote', OUT, (out.length / 1024).toFixed(0) + ' KB');
