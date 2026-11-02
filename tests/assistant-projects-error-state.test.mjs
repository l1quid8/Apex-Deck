import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const source = await fs.readFile(new URL('../src/AssistantProjects.tsx', import.meta.url), 'utf8');

test('AssistantProjects has separate dialog and watch error states', () => {
  assert.ok(source.includes('dialogError'), 'should have dialogError state');
  assert.ok(source.includes('watchError'), 'should have watchError state');
  // Top-level alert and dialog backdrop must use dialogError, not generic error
  assert.ok(source.includes('{dialogError&&'), 'top alert should use dialogError');
  // Watch dialog receives watchError
  assert.ok(source.includes('error={watchError}'), 'Watch dialog should receive watchError');
  // Closing watch clears watchError, not dialogError
  assert.ok(source.includes("setWatchError('')"), 'should clear watchError on close');
  assert.ok(source.includes("setDialogError('')"), 'should clear dialogError on close');
});

test('run and runWatch separate error handling', () => {
  assert.ok(source.includes('async function runWatch'), 'should have separate runWatch function');
  assert.ok(source.includes('setWatchError(message(cause))'), 'runWatch should set watchError');
  assert.ok(source.includes('setDialogError(message(cause))'), 'run should set dialogError');
});

test('openWatch uses runWatch and delegation uses run', () => {
  // openWatch should not leak errors to dialog
  assert.match(source, /openWatch[\s\S]*?runWatch/, 'openWatch should use runWatch');
  // saveWatch and stopWatch also use runWatch
  assert.match(source, /saveWatch[\s\S]*?runWatch/, 'saveWatch should use runWatch');
  assert.match(source, /stopWatch[\s\S]*?runWatch/, 'stopWatch should use runWatch');
  // openDelegate and openAssignments use dialog flow
  assert.match(source, /openDelegate[\s\S]*?setDialogError/, 'openDelegate clears dialogError');
});

test('no shared single error state leaks between dialogs', () => {
  // Ensure we no longer have a single `const [error,setError]` that is used for both dialogs
  const singleErrorCount = (source.match(/const \[error,setError\]/g) || []).length;
  assert.equal(singleErrorCount, 0, 'should not have single shared error state');
  // Ensure dialog close clears only dialogError
  assert.ok(source.includes("setDialog(null);setDialogError('')") || source.includes('setDialog(null);setDialogError'), 'dialog close should clear dialogError');
});
