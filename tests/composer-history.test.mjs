import test from 'node:test';
import assert from 'node:assert/strict';
import { createComposerHistory, assistantHistoryTexts, threadHistoryTexts } from '../src/composerHistory.ts';

const field = (value = 'draft', start = 0, end = start) => ({ value, selectionStart: start, selectionEnd: end, selectionDirection: 'none' });
const key = (name = 'ArrowUp', extra = {}) => ({ key: name, ...extra });
function browse(history = ['old', 'new'], draft = field()) {
  const navigation = createComposerHistory();
  let current = draft;
  return {
    navigation,
    press(event = key(), entries = history, scope = 'a') {
      const result = navigation.navigate(scope, entries, current, event);
      if (result) current = { ...result };
      return result;
    },
    move(start) { current.selectionStart = current.selectionEnd = start; },
    replace(value) { current = field(value); },
  };
}

test('recalls newest first, stops at oldest, and restores exact draft and selection', () => {
  const b = browse([' old ', 'same', 'same'], field('unfinished', 3));
  assert.equal(b.press().value, 'same');
  assert.equal(b.press().value, 'same');
  assert.deepEqual(b.press(), field(' old ', 5));
  assert.equal(b.press().value, ' old ');
  assert.equal(b.press(key('ArrowDown')).value, 'same');
  assert.equal(b.press(key('ArrowDown')).value, 'same');
  assert.deepEqual(b.press(key('ArrowDown')), field('unfinished', 3));
  assert.equal(b.press(key('ArrowDown')), null);
});

test('empty and blank history do not consume arrows; blank entries are skipped', () => {
  assert.equal(browse([]).press(), null);
  assert.equal(browse([' ', '\n']).press(), null);
  assert.equal(browse(['old', ' ', 'new', '\n']).press().value, 'new');
  assert.equal(browse().press(key('ArrowDown')), null);
});

test('history snapshot stays stable until draft restoration', () => {
  const b = browse();
  b.press();
  assert.equal(b.press(key(), ['later']).value, 'old');
  b.press(key('ArrowDown'));
  b.press(key('ArrowDown'));
  assert.equal(b.press(key(), ['later']).value, 'later');
});

test('edits, external replacement, reset on send and conversation changes end browsing', () => {
  for (const replacement of ['edited', '', 'voice replacement']) {
    const b = browse(); b.press(); b.replace(replacement);
    assert.equal(b.press(key('ArrowDown')), null);
    assert.equal(b.press().value, 'new');
    assert.equal(b.press(key('ArrowDown')).value, replacement);
  }
  const b = browse(); b.press(); b.navigation.reset();
  assert.equal(b.press(key('ArrowDown')), null);
  b.press();
  assert.equal(b.press(key('ArrowDown'), ['other'], 'b'), null);
  assert.equal(b.press(key(), ['other'], 'b').value, 'other');
});

test('only unmodified collapsed non-IME arrow events can browse', () => {
  for (const extra of [{ shiftKey: true }, { ctrlKey: true }, { altKey: true }, { metaKey: true }, { isComposing: true }, { keyCode: 229 }, { defaultPrevented: true }]) {
    assert.equal(browse().press(key('ArrowUp', extra)), null);
  }
  assert.equal(browse(['old'], field('draft', 0, 2)).press(), null);
  assert.equal(browse().press(key('Enter')), null);
});

test('first and last newline-delimited line boundaries preserve native movement', () => {
  const b = browse(['old\nnew'], field('a\nb', 2));
  assert.equal(b.press(), null);
  b.move(1);
  assert.equal(b.press().value, 'old\nnew');
  assert.equal(b.press(), null, 'recalled multiline caret starts at end');
  b.move(0); assert.equal(b.press().value, 'old\nnew');
  b.move(0); assert.equal(b.press(key('ArrowDown')), null);
  b.move(7); assert.deepEqual(b.press(key('ArrowDown')), field('a\nb', 1));
});

test('thread history includes only exact nonblank human text in message order', () => {
  assert.deepEqual(threadHistoryTexts([
    { speaker: { kind: 'human' }, text: ' first ' },
    { speaker: { kind: 'bot' }, text: 'reply' },
    { speaker: { kind: 'human' }, text: ' ' },
    { speaker: { kind: 'human' }, text: ' first ' },
  ]), [' first ', ' first ']);
});

test('aggregate assistant recall is limited to the current conversation lane', () => {
  const entries = [
    { workspaceId: 'a', message: { role: 'human', text: 'a1' } },
    { workspaceId: 'personal', message: { role: 'human', text: 'private' } },
    { workspaceId: 'b', message: { role: 'human', text: 'b1' } },
    { workspaceId: 'a', message: { role: 'assistant', text: 'reply' } },
    { workspaceId: 'a', message: { role: 'human', text: 'a2' } },
  ];
  assert.deepEqual(assistantHistoryTexts(entries, 'a'), ['a1', 'a2']);
  assert.deepEqual(assistantHistoryTexts(entries, 'personal'), ['private']);
  assert.deepEqual(assistantHistoryTexts(entries, null), []);
});
