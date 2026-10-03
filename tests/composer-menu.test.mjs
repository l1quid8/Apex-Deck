import test from 'node:test';
import assert from 'node:assert/strict';
import { findTrigger, insertAt, menuItems } from '../src/composerMenu.ts';

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
  assert.deepEqual(all, ['@all', '@null', '@jigga', '/compact', '/clear', '/pin', '/diff', '/fork', '/export', '/export json']);
});

test('picking replaces the trigger, or inserts at the caret from "+"', () => {
  assert.deepEqual(insertAt('hey @nu what', findTrigger('hey @nu what', 7), 7, '@null '), { text: 'hey @null what', caret: 10 });
  assert.deepEqual(insertAt('hey', null, 3, '@all '), { text: 'hey @all ', caret: 9 });
  assert.deepEqual(insertAt('', null, 0, '@all '), { text: '@all ', caret: 5 });
});
