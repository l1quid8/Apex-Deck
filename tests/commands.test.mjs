import test from 'node:test';
import assert from 'node:assert/strict';
import { parseComposer, postable } from '../src/commands.ts';

test('known commands parse with their arguments', () => {
  assert.deepEqual(parseComposer('/clear'), { command: { name: 'clear' } });
  assert.deepEqual(parseComposer('/compact'), { command: { name: 'compact' } });
  assert.deepEqual(parseComposer('/pin  we are on Tauri 2 '), { command: { name: 'unknown', typed: '/pin' } });
  assert.deepEqual(parseComposer('/pin'), { command: { name: 'unknown', typed: '/pin' } });
  assert.deepEqual(parseComposer('/fork Try SQLite'), { command: { name: 'fork', title: 'Try SQLite' } });
  assert.deepEqual(parseComposer('/fork'), { command: { name: 'fork', title: '' } });
  assert.deepEqual(parseComposer('/export'), { command: { name: 'export', format: 'markdown' } });
  assert.deepEqual(parseComposer('/export json'), { command: { name: 'export', format: 'json' } });
  assert.deepEqual(parseComposer('/diff'), { command: { name: 'diff' } });
  assert.deepEqual(parseComposer('/DIFF'), { command: { name: 'diff' } });
});

test('removed pin command is rejected even with multiline arguments', () => {
  assert.deepEqual(parseComposer('/pin line one\nline two'), { command: { name: 'unknown', typed: '/pin' } });
});

test('unknown commands and bad arguments are flagged, not sent', () => {
  assert.deepEqual(parseComposer('/foo bar'), { command: { name: 'unknown', typed: '/foo' } });
  assert.deepEqual(parseComposer('/clear now'), { command: { name: 'unknown', typed: '/clear now' } });
  assert.deepEqual(parseComposer('/export pdf'), { command: { name: 'unknown', typed: '/export pdf' } });
});

test('paths and slashes inside words are plain text', () => {
  assert.deepEqual(parseComposer('/Users/me/file.txt is broken'), { text: '/Users/me/file.txt is broken' });
  assert.deepEqual(parseComposer('see src/App.tsx'), { text: 'see src/App.tsx' });
  assert.deepEqual(parseComposer('hello'), { text: 'hello' });
});

test('a doubled slash escapes and is sent with one slash', () => {
  assert.deepEqual(parseComposer('//compact'), { text: '//compact' });
  assert.equal(postable('//compact'), '/compact');
  assert.equal(postable('@jigga //compact'), '@jigga //compact');
  assert.equal(postable('plain'), 'plain');
});

test('escape is normalized before adding quote context', async () => {
  const { replyText } = await import('../src/reply.ts');
  const parsed = parseComposer('//compact');
  assert.equal(replyText(postable(parsed.text), {id:'bot',name:'Bot',text:'previous'}).split('\n')[0], '@bot /compact');
});

test('queued edits follow composer command and escape rules', async () => {
  const { parseQueueEdit } = await import('../src/commands.ts');
  for (const text of ['/pin fact', '/diff', '/export', '/foo', '/compact', '/clear']) {
    assert.deepEqual(parseQueueEdit(text), parseComposer(text));
  }
  assert.deepEqual(parseQueueEdit('//compact'), {text:'/compact'});
});
