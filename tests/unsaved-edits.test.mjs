import test from 'node:test';
import assert from 'node:assert/strict';
import { setUnsavedEdit, unsavedEditName } from '../src/unsavedEdits.ts';

test('a file with unsaved edits is reported until it is cleared', () => {
  const owner = Symbol('tab');
  assert.equal(unsavedEditName(), null);
  setUnsavedEdit(owner, 'a.ts');
  assert.equal(unsavedEditName(), 'a.ts');
  setUnsavedEdit(owner, null);
  assert.equal(unsavedEditName(), null);
});

test('two tabs are tracked separately', () => {
  const a = Symbol('a'), b = Symbol('b');
  setUnsavedEdit(a, 'a.ts'); setUnsavedEdit(b, 'b.ts');
  setUnsavedEdit(a, null);
  assert.equal(unsavedEditName(), 'b.ts');
  setUnsavedEdit(b, null);
});
