import test from 'node:test';
import assert from 'node:assert/strict';
import { boxKeyGoesToMenu, clickCloses, findTrigger, insertAt, menuItems } from '../src/composerMenu.ts';

const people = [{ id: 'null', display_name: 'Null' }, { id: 'jigga', display_name: 'Jigga' }];

test('a slash at the very start opens commands', () => {
  assert.deepEqual(findTrigger('/', 1), { kind: 'command', query: '', start: 0, end: 1 });
  assert.deepEqual(findTrigger('/Co', 3), { kind: 'command', query: 'co', start: 0, end: 3 });
  assert.equal(findTrigger('see /co', 7), null);
  assert.equal(findTrigger('//co', 4), null);
  assert.equal(findTrigger('/Users/me', 9), null);
});

test('an @ at the start of a word opens mentions', () => {
  assert.deepEqual(findTrigger('hey @nu', 7), { kind: 'mention', query: 'nu', start: 4, end: 7 });
  assert.deepEqual(findTrigger('@', 1), { kind: 'mention', query: '', start: 0, end: 1 });
  assert.equal(findTrigger('me@mail', 7), null);
  assert.equal(findTrigger('@null ', 6), null);
});

test('items filter by kind and prefix', () => {
  assert.deepEqual(menuItems(findTrigger('/exp', 4), people).map(i => i.label), ['/export', '/export json']);
  assert.deepEqual(menuItems(findTrigger('/pin we', 7), people), []);
  assert.deepEqual(menuItems(findTrigger('@j', 2), people).map(i => i.label), ['@jigga']);
  assert.deepEqual(menuItems(findTrigger('@a', 2), people).map(i => i.label), ['@all']);
  const all = menuItems(null, people).map(i => i.label);
  assert.deepEqual(all, ['Photo or file', 'Folder', 'Tools', 'Plan', '@all', '@null', '@jigga', '/compact', '/clear', '/diff', '/fork', '/export', '/image', '/export json', '/plan']);
});

test('Plan sits in the + menu next to Tools and turns into Stop planning while on', () => {
  const plan = menuItems(null, people).find(i => i.label === 'Plan');
  assert.deepEqual(plan.command, { name: 'plan' });
  assert.match(plan.detail, /nothing gets changed/);
  const on = menuItems(null, people, [], [], true).map(i => i.label);
  assert.ok(on.includes('Stop planning') && !on.includes('Plan'));
  assert.deepEqual(menuItems(findTrigger('/pl', 3), people).map(i => i.label), ['/plan']);
});

test('picking replaces the trigger, or inserts at the caret from "+"', () => {
  assert.deepEqual(insertAt('hey @nu what', findTrigger('hey @nu what', 7), 7, '@null '), { text: 'hey @null what', caret: 10 });
  assert.deepEqual(insertAt('hey', null, 3, '@all '), { text: 'hey @all ', caret: 9 });
  assert.deepEqual(insertAt('', null, 0, '@all '), { text: '@all ', caret: 5 });
});

test('Tools in the "+" menu types the ! that opens the tool list', () => {
  const typed = insertAt('check', null, 5, '!');
  assert.deepEqual(typed, { text: 'check !', caret: 7 });
  assert.equal(findTrigger(typed.text, typed.caret)?.kind, 'server');
  assert.equal(findTrigger('!', 1)?.kind, 'server');
});

test('mod commands show up after the built-in ones and are inserted, not run', () => {
  const mods = [{ mod: 'hyperliquid', name: 'hl', description: 'Hyperliquid positions' }, { mod: 'dupe', name: 'clear', description: 'shadowed' }];
  assert.deepEqual(findTrigger('/h', 2), { kind: 'command', query: 'h', start: 0, end: 2 });
  const hl = menuItems(findTrigger('/h', 2), people, [], mods);
  assert.deepEqual(hl.map(i => [i.label, i.detail, i.command]), [['/hl', 'Hyperliquid positions', null]]);
  const all = menuItems(findTrigger('/', 1), people, [], mods).map(i => i.label);
  assert.deepEqual(all, ['/compact', '/clear', '/diff', '/fork', '/export', '/image', '/export json', '/plan', '/hl']);
  assert.deepEqual(findTrigger('/my-mod2', 8), { kind: 'command', query: 'my-mod2', start: 0, end: 8 });
});

test('a menu opened with "+" closes when you click in the message box', () => {
  assert.equal(clickCloses(true, false, true), true);
  assert.equal(clickCloses(true, false, false), true);
  assert.equal(clickCloses(true, true, false), false);
});

test('a menu typed open stays while you click in the message box', () => {
  assert.equal(clickCloses(false, false, true), false);
  assert.equal(clickCloses(false, false, false), true);
});

test('Enter in the message box only picks from a menu typed open', () => {
  assert.equal(boxKeyGoesToMenu(false), true);
  assert.equal(boxKeyGoesToMenu(true), false);
});

test("Tools in the Work bar adds !token at the end of what was typed", async () => {
  const { appendToolToken } = await import("../src/composerMenu.ts");
  assert.equal(appendToolToken("", "github"), "!github ");
  assert.equal(appendToolToken("look at the PR  ", "github"), "look at the PR !github ");
  assert.equal(appendToolToken("use !vercel ", "github"), "use !vercel !github ");
});
