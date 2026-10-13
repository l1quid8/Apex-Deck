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

test('a linked file is not editable, and an older daemon that omits the flag still is', () => {
  assert.equal(isEditable(text({ editable: false }), 'file', false), false);
  assert.equal(isEditable(text({ editable: true }), 'file', false), true);
});

test('the editor keeps the line ending, so a CRLF file saves back byte-for-byte', async () => {
  const { EditorState } = await import('@codemirror/state');
  const { lineSeparatorFor } = await import('../src/fileEditorModel.ts');
  assert.equal(lineSeparatorFor('a\r\nb\n'), '\r\n');
  assert.equal(lineSeparatorFor('a\nb'), '\n');
  assert.equal(lineSeparatorFor('abc'), undefined);
  for (const original of ['a\r\nb\r\n\r\nc\r\n', 'a\nb\n', 'a\r\nb\nc\r\n', 'x\ry\n']) {
    const sep = lineSeparatorFor(original);
    const state = EditorState.create({ doc: original, extensions: sep ? [EditorState.lineSeparator.of(sep)] : [] });
    assert.equal(state.sliceDoc(), original);
    // an edit then undo-equivalent: appending and removing text keeps the endings
    const edited = state.update({ changes: { from: 0, insert: 'Z' } }).state;
    assert.equal(edited.sliceDoc(), 'Z' + original);
    const back = edited.update({ changes: { from: 0, to: 1 } }).state;
    assert.equal(back.sliceDoc(), original);
  }
});
