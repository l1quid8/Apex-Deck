import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const { transform } = createRequire(import.meta.url)('sucrase');
const source = fs.readFileSync(new URL('../src/ChatPane.tsx', import.meta.url), 'utf8');
const quickMenu = () => source.slice(source.indexOf('const quickAddMenu = ('), source.indexOf('const quickAddButton = ('));
const agentTile = () => source.slice(source.indexOf('function AgentTile('), source.indexOf('\n}\n', source.indexOf('function AgentTile(')));

test('the add menu grows out of the message box instead of floating', () => {
  const box = source.match(/<div className=\{`composer-box\$\{[^\n]*?\}`\} ref=\{field\}>\n\s*(.*)/);
  assert.ok(box, 'the composer box render exists');
  assert.match(box[0], /quickAdd === "dock" \? " adding" : ""/, 'the box is marked while the menu is open');
  assert.match(box[1], /\{quickAdd === "dock" && quickAddMenu\}/, 'the menu is the first thing in the box');
  assert.doesNotMatch(source, /rosterAnchor|roster-pop|quickAddButton\("empty"/, 'no floating copy of the menu is left');
  const seat = source.match(/className="chip-add"[^\n]*/)?.[0] ?? '';
  assert.match(seat, /openQuickAdd\("dock", e\.currentTarget\)/, 'the composer seat opens the same menu');
});

test('the welcome block steps aside while the add menu is open', () => {
  assert.match(source, /<div className=\{`empty\$\{quickAdd === "dock" \? " away" : ""\}`\}/);
  assert.match(source, /onClick=\{\(e\) => openQuickAdd\("dock", e\.currentTarget\)\}>\+ Add bots<\/button>/, 'the welcome button opens the menu in the message box');
  const css = fs.readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
  assert.match(css, /\.transcript \.empty\.away \{[^}]*pointer-events: none;/);
  assert.match(css, /\.composer-box\.adding > :not\(\.quick-add\) \{ display: none; \}/, 'the message box hides its own controls while it is the menu');
});

test('saved agents are tiles with their own avatar, and the menu can be closed', () => {
  const menu = quickMenu();
  assert.match(agentTile(), /className="quick-add-tile"/);
  assert.match(agentTile(), /<Avatar seed=\{seed\} color=\{color\}/);
  assert.match(menu, /<AgentTile key=\{p\.id\} name=\{p\.display_name\} seed=\{look\.seed\} color=\{look\.color\}/);
  assert.match(menu, /aria-label="Close menu" onClick=\{\(\) => setQuickAdd\(null\)\}/);
  assert.match(menu, /lineupText\(/, 'the bottom strip says who will join');
});

test('an empty thread keeps an Add bot seat after a kick notice', () => {
  const guard = source.match(/const botChips = \([\s\S]*?\{\((participants\.length > 0 \|\| entries\.length > 0)\) && \(/)?.[1];
  assert.ok(guard, 'the composer add chip guard exists');
  const shows = new Function('participants', 'entries', `return (${guard});`);
  assert.equal(shows([], [{ kind: 'notice' }]), true, 'a kick notice must not leave the thread with no way to add a bot');
  assert.equal(shows([], []), false, 'the empty state already offers the button on a fresh thread');
  assert.equal(shows([{ id: 'a' }], []), true);
});

test('quick add names a second bot after the queued ones', () => {
  const effect = source.match(/In the quick add menu the name follows the model[\s\S]*?\}, \[([^\]]*)\]\);/);
  assert.ok(effect, 'the name-follows-model effect exists');
  const taken = effect[0].match(/uniqueName\([^\n]*?,\s*(\[[^\n]*?\]),\s*slug\)/)?.[1];
  assert.ok(taken, 'uniqueName gets a taken list');
  assert.match(taken, /queued/, 'bots waiting in the batch count as taken names');
  assert.match(effect[1], /queued/, 'the effect re-runs when the batch changes');
});

test('the quick add menu has effort, persona and API fields', () => {
  const menu = source.slice(source.indexOf('const quickAddMenu = ('), source.indexOf('const quickAddButton = ('));
  for (const name of ['quick-effort', 'quick-persona', 'quick-base-url', 'quick-key-env', 'quick-api-key']) {
    assert.match(menu, new RegExp(`name="${name}"`), `${name} field`);
  }
  assert.match(menu, /type="password"/, 'the API key is a password field');
});

test('the key lookup also runs for the quick add menu', () => {
  assert.match(source, /const keyName = \(adding \|\| quickAdd\) && takesKey\(draft\.preset\)/);
});

test('saved agents in the quick add menu are toggles, not instant adds', () => {
  const menu = quickMenu();
  assert.match(agentTile(), /role="checkbox" aria-checked=\{picked\}/);
  assert.match(menu, /picked=\{pickedAgents\.has\(p\.id\)\} onToggle=\{\(\) => togglePicked\(p\.id\)\}/);
  assert.doesNotMatch(source, /addSaved\(/, 'clicking a saved agent no longer adds it straight away');
});

test('the quick add submit counts the batch', () => {
  assert.match(quickMenu(), /batchLabel\(/);
  assert.match(quickMenu(), /\+ Another bot/);
});

test('a queued row never keeps a typed key', () => {
  assert.match(source, /setQueuedBots\(\(list\) => \[\.\.\.list, \{ \.\.\.ready, apiKey: ""/);
});

test('the quick add menu scrolls inside itself and keeps its button visible', () => {
  const css = fs.readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
  assert.match(css, /\.quick-add \{[^}]*max-height:[^}]*overflow: hidden;/);
  assert.match(css, /\.quick-add-scroll \{[^}]*min-height: 0;[^}]*overflow-y: auto;/);
  const menu = quickMenu();
  assert.ok(menu.indexOf('className="quick-add-foot"') > menu.lastIndexOf('</div>{/* end quick-add-scroll */}'), 'the Add button sits outside the scrolling part');
});

test('the quick add menu opens a new bot only when there are no saved agents to pick', () => {
  assert.match(source, /const \[editorOpen, setEditorOpen\] = useState\(false\);/);
  assert.match(source, /const pickableAgents = availableProfiles\.filter\(\(p\) => !participants\.some\(\(own\) => own\.id === p\.id\)\);/);
  const open = source.slice(source.indexOf('const openQuickAdd = '), source.indexOf('const openQuickAdd = ') + 400);
  assert.match(open, /setEditorOpen\(pickableAgents\.length === 0\);/, 'saved agents to pick: start empty; none: start with a new bot open');
  assert.doesNotMatch(open, /setEditorOpen\(true\)/);
});

test('the landing texture stays while the welcome text fades for the add menu', () => {
  const css = fs.readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
  const away = css.match(/\.transcript \.empty\.away \{([^}]*)\}/)?.[1] ?? '';
  assert.doesNotMatch(away, /opacity|transform/, 'the block itself must not fade, or the texture inside it fades too');
  const kids = css.match(/\.transcript \.empty\.away > :not\(\.landing-texture-wrap\) \{([^}]*)\}/)?.[1] ?? '';
  assert.match(kids, /opacity: 0;/);
  assert.match(kids, /visibility: hidden;/, 'hidden welcome buttons leave the tab order');
});

test('the lineup is plain text and only errors are announced', () => {
  const menu = quickMenu();
  assert.doesNotMatch(menu, /className="quick-add-say" role="status"/, 'the lineup must not be read out on every keystroke');
  assert.match(menu, /<span role="status">\{formError && <span className="form-error">\{formError\}<\/span>\}<\/span>/);
});

test('the docked menu is a dialog and takes focus when it opens', () => {
  assert.match(quickMenu(), /<form ref=\{quickAddForm\} className="quick-add" role="dialog"/);
  assert.match(source, /const quickAddForm = useRef<HTMLFormElement>\(null\);/);
  assert.match(source, /quickAddForm\.current\?\.querySelector<HTMLElement>\("\.quick-add-tile, \.quick-add-another"\)\?\.focus\(\)/);
});

test('saved agent avatars play a fresh random move on hover or focus', async () => {
  const start = source.indexOf('export function playTileMove(');
  assert.ok(start >= 0, 'playTileMove exists');
  const code = source.slice(source.indexOf('export const TILE_MOVES'), source.indexOf('\n}\n', start) + 3);
  const js = transform(code, { transforms: ['typescript', 'imports'] }).code;
  const mod = {};
  new Function('exports', js)(mod);
  const tile = { dataset: {}, offsetWidth: 0 };
  let last = '';
  for (let i = 0; i < 40; i++) {
    mod.playTileMove(tile);
    assert.ok(mod.TILE_MOVES.includes(tile.dataset.move), 'plays a known move');
    assert.notEqual(tile.dataset.move, last, 'never repeats the move it just played');
    last = tile.dataset.move;
  }
  const button = agentTile().match(/className="quick-add-tile"[^\n]*/)?.[0] ?? '';
  assert.match(agentTile(), /const play = \(tile: HTMLElement\) => \{ playTileMove\(tile\);/);
  assert.match(button, /onPointerEnter=\{\(e\) => play\(e\.currentTarget\)\}/);
  assert.match(button, /onFocus=\{\(e\) => \{ if \(e\.currentTarget\.matches\(":focus-visible"\)\) play\(e\.currentTarget\); \}\}/);
  assert.match(button, /onAnimationEnd=\{\(e\) => \{ if \(e\.animationName\.startsWith\("tile-"\)\) delete e\.currentTarget\.dataset\.move; \}\}/);
  const css = fs.readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
  for (const move of mod.TILE_MOVES) assert.match(css, new RegExp(`\\.quick-add-tile\\[data-move="${move}"\\] \\.identicon \\{ animation: tile-${move} `));
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{[^@]*\.quick-add-tile\[data-move\] \.identicon \{\s*animation: none;\s*\}/);
});

test('hovering or keyboard-focusing a saved agent scrambles its avatar dots', () => {
  const avatar = fs.readFileSync(new URL('../src/Avatar.tsx', import.meta.url), 'utf8');
  assert.match(avatar, /scramble\?: number/, 'Avatar takes a scramble counter');
  assert.match(avatar, /scrambleFrames\(/, 'Avatar draws scramble frames from identicon.ts');
  assert.match(avatar, /prefers-reduced-motion: reduce/, 'Reduce Motion turns the scramble off');
  const tile = source.slice(source.indexOf('function AgentTile('), source.indexOf('\n}\n', source.indexOf('function AgentTile(')));
  assert.ok(tile.length > 0, 'saved agents render through AgentTile, which keeps its own counter');
  assert.match(tile, /<Avatar [^>]*scramble=\{scramble\}/);
  assert.match(tile, /onPointerEnter=/);
  assert.match(tile, /matches\(":focus-visible"\)/, 'focus from opening the menu or a click stays quiet');
  assert.match(tile, /animationName\.startsWith\("tile-"\)/, 'only a tile move clears data-move');
  assert.match(quickMenu(), /<AgentTile /);
  const css = fs.readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
  assert.match(css, /\.identicon i \{[^}]*transition: background-color/, 'dots fade between frames');
});

test('closing the add menu puts focus back where it was opened', () => {
  assert.match(source, /const quickAddOpener = useRef<HTMLElement \| null>\(null\);/);
  assert.match(source, /const openQuickAdd = \(where: "dock" \| "details", opener\?: HTMLElement\) =>/);
  assert.match(source, /quickAddOpener\.current = opener \?\? null;/);
  assert.match(source, /if \(quickAdd \|\| !back\) return;[\s\S]*back\.isConnected \? back : input\.current/);
  assert.doesNotMatch(source, /openQuickAdd\("(dock|details)"\)\}/, 'every opener passes the button it came from');
});

test('the composer floats over the chat with no strip behind it', () => {
  assert.match(source, /root\.current\?\.style\.setProperty\("--composer-h", `\$\{[^`]*\}px`\)/, 'the composer height is measured live');
  const css = fs.readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
  const box = css.match(/\.thread-chat > \.composer \{([^}]*)\}/)?.[1] ?? '';
  assert.match(box, /border-top: 0;/);
  assert.match(box, /background: transparent;/);
  const scroll = css.match(/\.thread-chat \.chat-body > \.transcript \{([^}]*)\}/)?.[1] ?? '';
  assert.match(scroll, /margin-bottom: calc\(-1 \* var\(--composer-h, 0px\)\);/, 'the transcript runs on behind the composer');
  assert.match(scroll, /padding-bottom: calc\(24px \+ var\(--composer-h, 0px\)\);/, 'the last message still clears it');
  const texture = fs.readFileSync(new URL('../src/landing/landing-texture.css', import.meta.url), 'utf8');
  assert.match(texture, /\.thread-chat \.landing-texture-wrap \{ bottom: calc\(-1 \* var\(--composer-h, 0px\)\); \}/, 'the texture reaches under the composer');
});
