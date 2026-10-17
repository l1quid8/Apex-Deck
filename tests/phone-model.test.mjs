import test from 'node:test';
import assert from 'node:assert/strict';
import { toPicture, gesture, keyAction, holderLine } from '../src/phoneModel.ts';

test('a click maps into the picture, letterboxing included', () => {
  // A 603×1311 picture in a 400×600 box is height-limited: about 276 wide, with 62 px bars each side.
  const box = { left: 0, top: 0, width: 400, height: 600 };
  assert.deepEqual(toPicture(250, 300, box, 603, 1311), { x: 410, y: 655 });
  assert.equal(toPicture(10, 300, box, 603, 1311), null);
  assert.equal(toPicture(250, 601, box, 603, 1311), null);
  assert.deepEqual(toPicture(63, 1, box, 603, 1311), { x: 2, y: 2 });
  assert.equal(toPicture(1, 1, { left: 0, top: 0, width: 0, height: 0 }, 603, 1311), null);
});

test('a short press taps, a drag swipes', () => {
  assert.deepEqual(gesture({ x: 10, y: 10, at: 0 }, { x: 15, y: 12, at: 80 }), { kind: 'tap', x: 10, y: 10 });
  assert.deepEqual(gesture({ x: 100, y: 900, at: 0 }, { x: 100, y: 300, at: 40 }), { kind: 'swipe', x1: 100, y1: 900, x2: 100, y2: 300, ms: 100 });
  assert.equal(gesture({ x: 0, y: 0, at: 0 }, { x: 0, y: 50, at: 5000 }).ms, 1000);
});

test('keys become typing or key presses', () => {
  const k = (key, extra = {}) => keyAction({ key, metaKey: false, ctrlKey: false, altKey: false, ...extra });
  assert.deepEqual(k('a'), { text: 'a' });
  assert.deepEqual(k(' '), { text: ' ' });
  assert.deepEqual(k('Enter'), { key: 'enter' });
  assert.deepEqual(k('ArrowUp'), { key: 'up' });
  assert.deepEqual(k('Backspace'), { key: 'backspace' });
  assert.equal(k('v', { metaKey: true }), null);
  assert.equal(k('é'), null);
  assert.equal(k('Shift'), null);
});

test('who has the phone, in plain words', () => {
  const base = { on: true, starting: false, device: 'Apex Deck Phone 1a2b', udid: 'U', width: 603, height: 1311, problem: null };
  assert.equal(holderLine({ ...base, on: false, holder: { kind: 'free' } }), 'Off');
  assert.equal(holderLine({ ...base, on: false, starting: true, holder: { kind: 'free' } }), 'Turning on…');
  assert.equal(holderLine({ ...base, holder: { kind: 'free' } }), 'Free. Tap the screen to take it.');
  assert.equal(holderLine({ ...base, holder: { kind: 'human', secondsLeft: 7 } }), 'You have the phone. The bots get it back after 7s without a tap.');
  assert.equal(holderLine({ ...base, holder: { kind: 'bot', name: 'Jigga' } }), 'Jigga is using the phone. Tap the screen to take over.');
});
