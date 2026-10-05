import test from 'node:test';
import assert from 'node:assert/strict';
import { viewBounds, covered } from '../src/browserGeometry.ts';
import { DECK_KEYS } from '../desktop/browser-keys.mjs';
import { shortcutList, shortcutFor } from '../src/shortcuts.ts';

const rect = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height });

test('view bounds are the placeholder in window pixels, whole and never negative', () => {
  assert.deepEqual(viewBounds(rect(10.4, 20.6, 300.5, 200.2), 1), { x: 10, y: 21, width: 301, height: 200 });
  assert.deepEqual(viewBounds(rect(10, 20, 300, 200), 1.25), { x: 13, y: 25, width: 375, height: 250 });
  assert.deepEqual(viewBounds(rect(10, 20, -5, -1), 1), { x: 10, y: 20, width: 0, height: 0 });
});

test('an overlay covers the pane when it overlaps by a pixel or more, not when it only touches', () => {
  const pane = rect(100, 100, 200, 200);
  assert.equal(covered(pane, []), false);
  assert.equal(covered(pane, [rect(0, 0, 100, 100)]), false, 'touching at a corner');
  assert.equal(covered(pane, [rect(300, 100, 50, 50)]), false, 'touching on the right');
  assert.equal(covered(pane, [rect(0, 0, 101, 101)]), true, 'one pixel in');
  assert.equal(covered(pane, [rect(400, 400, 10, 10), rect(150, 150, 10, 10)]), true);
  assert.equal(covered(pane, [rect(150, 150, 0, 0)]), false, 'an empty overlay covers nothing');
});

test('the docked browser hands the deck its own shortcuts and nothing else', () => {
  const mac = DECK_KEYS.every(({ code, shift }) => shortcutFor({ code, metaKey: true, ctrlKey: false, shiftKey: shift, altKey: false }, true));
  assert.ok(mac, 'every key the browser passes on is a deck shortcut');
  assert.equal(DECK_KEYS.length, shortcutList(true).filter((s) => !s.composer).length, 'and every deck shortcut is passed on');
  for (const code of ['KeyC', 'KeyV', 'KeyX', 'KeyA', 'KeyZ', 'KeyF']) assert.ok(!DECK_KEYS.some((k) => k.code === code), code);
});

import { deckKey } from '../desktop/browser-keys.mjs';

test('a key press in the page goes to the deck only when it is a deck shortcut', () => {
  const press = (code, mods = {}) => ({ type: 'keyDown', code, meta: false, control: false, shift: false, alt: false, ...mods });
  assert.equal(deckKey(press('KeyT', { meta: true }), true), true);
  assert.equal(deckKey(press('Enter', { meta: true, shift: true }), true), true);
  assert.equal(deckKey(press('Enter', { meta: true }), true), false, '⌘↩ stays with the page');
  assert.equal(deckKey(press('KeyC', { meta: true }), true), false);
  assert.equal(deckKey(press('KeyT'), true), false);
  assert.equal(deckKey({ ...press('KeyT', { meta: true }), type: 'keyUp' }, true), false);
  assert.equal(deckKey(press('KeyT', { control: true, shift: true }), false), true);
  assert.equal(deckKey(press('KeyT', { control: true }), false), false, 'Ctrl+T stays with the page off macOS');
});
