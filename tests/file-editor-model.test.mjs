import test from 'node:test';
import assert from 'node:assert/strict';
import { isEditable, isDirty, saveErrorKind, saveErrorMessage, languageName } from '../src/fileEditorModel.ts';

const text = (extra = {}) => ({ kind: 'text', text: 'a', size: 1, truncated: false, version: '1-1', ...extra });

test('only whole text files in the file view that still exist are editable', () => {
  assert.equal(isEditable(text(), 'file', false), true);
  assert.equal(isEditable(text({ truncated: true }), 'file', false), false);
  assert.equal(isEditable(text(), 'changes', false), false);
  assert.equal(isEditable(text(), 'file', true), false);
  assert.equal(isEditable(null, 'file', false), false);
  for (const kind of ['binary', 'too_large']) assert.equal(isEditable({ kind, size: 1 }, 'file', false), false);
  assert.equal(isEditable({ kind: 'image', mime: 'image/png', data: '', size: 1 }, 'file', false), false);
});

test('dirty means the text differs from the last saved text', () => {
  assert.equal(isDirty('a', 'a'), false);
  assert.equal(isDirty('a ', 'a'), true);
});

test('save errors are sorted into conflict, old daemon and other', () => {
  assert.equal(saveErrorKind('changed-on-disk'), 'conflict');
  assert.equal(saveErrorKind(new Error('changed-on-disk')), 'conflict');
  assert.equal(saveErrorKind('unknown variant `file_write`, expected one of'), 'outdated-daemon');
  assert.equal(saveErrorKind('Could not save file: permission denied'), 'other');
  assert.equal(saveErrorMessage('unknown variant `file_write`'), "This machine's Deck needs an update to edit files.");
  assert.equal(saveErrorMessage(new Error('File is too large to edit here.')), 'File is too large to edit here.');
});

test('the language comes from the file name', async () => {
  assert.equal(await languageName('main.rs'), 'Rust');
  assert.equal(await languageName('notes.unknownext'), null);
});
