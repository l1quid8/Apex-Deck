'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const modulePath = path.join(__dirname, 'coordination-state.js');
assert.ok(fs.existsSync(modulePath), 'The coordination state module must exist');
const { create } = require(modulePath);

function memoryStorage() {
  const records = new Map();
  return {
    writes: 0,
    getItem(key) { return records.get(key) ?? null; },
    setItem(key, value) { records.set(key, String(value)); this.writes += 1; },
  };
}
function open(storage = memoryStorage()) {
  return create({ storage, primaryId: 'assistant-primary', secondaryId: 'assistant-secondary' });
}
const tests = [];
function test(name, run) { tests.push({ name, run }); }

test('task context never leaks another assistant or another project notebook', () => {
  const api = open();
  api.saveNote({ scope: 'assistant', ownerId: 'assistant-secondary', title: 'Private', text: 'Secondary only' });
  api.saveNote({ scope: 'project', ownerId: 'REA', title: 'REA only', text: 'Do not share with Deck' });
  const context = api.contextForTask('t-deck');
  assert.ok(context.assistantNotes.length > 0);
  assert.ok(context.assistantNotes.every(note => note.scope === 'assistant' && note.ownerId === 'assistant-primary'));
  assert.ok(context.projectNotes.length > 0);
  assert.ok(context.projectNotes.every(note => note.scope === 'project' && note.ownerId === 'apex-deck'));
  assert.equal(context.brief, api.task('t-deck').brief);
  assert.equal(api.tasksForAssistant('assistant-primary').length, 4);
  assert.equal(api.project('REA').host, 'This Mac');
  assert.equal(api.project('apex_terminal').host, 'APEX-TERMINAL');
});

test('three projects progress concurrently while paused and finished work stays still', () => {
  const api = open();
  const fixed = ['t-review', 't-failed', 't-done'].map(id => JSON.stringify(api.task(id)));
  assert.deepEqual(new Set(api.state.tasks.filter(task => task.status === 'working').map(task => task.projectId)), new Set(['apex-deck', 'REA', 'apex_terminal']));
  const updates = [];
  const unsubscribe = api.subscribe(state => updates.push(state.revision));
  assert.equal(api.advance().length, 3);
  assert.equal(api.task('t-deck').step, 1);
  api.advance();
  for (const id of ['t-deck', 't-rea', 't-terminal']) {
    assert.equal(api.task(id).status, 'needs_review');
    assert.equal(api.task(id).step, 2);
    assert.ok(api.task(id).scratch.text);
  }
  assert.deepEqual(['t-review', 't-failed', 't-done'].map(id => JSON.stringify(api.task(id))), fixed);
  assert.equal(updates.length, 2);
  unsubscribe();
  api.transition('t-review', 'approve');
  assert.equal(updates.length, 2);
});

test('assistant pause does not affect another owner or resume manual pauses', () => {
  const api = open();
  api.transition('t-deck', 'pause');
  api.syncAssistant('assistant-primary', true);
  assert.equal(api.task('t-deck').pauseReason, 'manual');
  assert.equal(api.task('t-rea').pauseReason, 'assistant');
  assert.equal(api.task('t-terminal').status, 'working');
  api.advance();
  assert.equal(api.task('t-deck').step, 0);
  assert.equal(api.task('t-rea').step, 0);
  assert.equal(api.task('t-terminal').step, 1);
  api.syncAssistant('assistant-primary', false);
  assert.equal(api.task('t-deck').status, 'paused');
  assert.equal(api.task('t-rea').status, 'working');
  api.transition('t-deck', 'resume');
  assert.equal(api.task('t-deck').pauseReason, null);
});

test('cancel and retry preserve task lineage with a unique attempt worktree', () => {
  const api = open();
  const before = api.task('t-terminal');
  const previousPath = before.worktree;
  const previousThread = before.threadId;
  api.transition('t-terminal', 'cancel');
  const eventCount = api.task('t-terminal').events.length;
  const retried = api.transition('t-terminal', 'retry');
  assert.equal(retried.attempt, 2);
  assert.equal(retried.status, 'working');
  assert.equal(retried.step, 0);
  assert.equal(retried.threadId, previousThread);
  assert.notEqual(retried.worktree, previousPath);
  assert.ok(retried.events.length > eventCount);
  assert.throws(() => api.transition('t-done', 'pause'));
  assert.throws(() => api.transition('t-terminal', 'approve'));
  assert.throws(() => api.transition('missing', 'retry'));
});

test('delegation owns its task, thread, brief and pause state', () => {
  const api = open();
  const task = api.delegate({ ownerId: 'assistant-primary', projectId: 'REA', title: 'Inspect navigation', worker: 'Sol', brief: 'Inspect without edits', paused: true });
  assert.equal(task.status, 'paused');
  assert.equal(task.pauseReason, 'assistant');
  assert.equal(api.contextForTask(task.id).brief, 'Inspect without edits');
  assert.equal(api.task(task.id).ownerId, 'assistant-primary');
  assert.ok(task.threadId && task.worktree);
  api.syncAssistant('assistant-primary', false);
  assert.equal(api.task(task.id).status, 'working');
  assert.throws(() => api.delegate({ ownerId: 'assistant-primary', projectId: 'unknown', title: 'No project', worker: 'Sol', brief: '' }));
});

test('scratch promotion is explicit, scoped, idempotent and may be dismissed', () => {
  const api = open();
  const count = api.notesFor('project', 'apex-deck').length;
  const note = api.promote('t-review');
  assert.equal(note.scope, 'project');
  assert.equal(note.ownerId, 'apex-deck');
  assert.equal(note.sourceTaskId, 't-review');
  assert.equal(api.promote('t-review').id, note.id);
  assert.equal(api.notesFor('project', 'apex-deck').length, count + 1);
  api.transition('t-review', 'approve');
  assert.equal(api.task('t-review').status, 'done');
  api.advance(); api.advance();
  api.dismissScratch('t-rea');
  assert.equal(api.task('t-rea').scratch.dismissed, true);
  assert.throws(() => api.promote('t-rea'));
  assert.throws(() => api.promote('t-failed'));
});

test('stale note edits fail without overwriting the newest saved version', () => {
  const storage = memoryStorage();
  const first = open(storage);
  const stale = open(storage);
  const original = first.notesFor('assistant', 'assistant-primary')[0];
  const changed = first.saveNote({ ...original, text: 'Newest revision', expectedVersion: original.version });
  assert.equal(changed.version, original.version + 1);
  assert.throws(() => stale.saveNote({ ...original, text: 'Stale replacement', expectedVersion: original.version }), /changed|version|stale/i);
  assert.equal(open(storage).notesFor('assistant', 'assistant-primary')[0].text, 'Newest revision');
  assert.throws(() => first.saveNote({ ...changed, text: 'Missing version check' }), /version/i);
});

test('stale tabs merge the latest state before independent mutations and reads do not write', () => {
  const storage = memoryStorage();
  const first = open(storage);
  const stale = open(storage);
  const task = first.delegate({ ownerId: 'assistant-primary', projectId: 'REA', title: 'New task', worker: 'Sol', brief: 'Keep me' });
  stale.saveNote({ scope: 'project', ownerId: 'apex_terminal', title: 'New note', text: 'Keep this too' });
  const reloaded = open(storage);
  assert.equal(reloaded.task(task.id).title, 'New task');
  assert.ok(reloaded.notesFor('project', 'apex_terminal').some(note => note.text === 'Keep this too'));
  const writes = storage.writes;
  reloaded.state; reloaded.available; reloaded.project('REA'); reloaded.task('t-deck'); reloaded.notesFor('project', 'REA'); reloaded.tasksForAssistant('assistant-primary'); reloaded.contextForTask('t-deck');
  assert.equal(storage.writes, writes);
  assert.equal(reloaded.state.revision, stale.state.revision);
});

test('storage failures and malformed saved records leave usable in-memory state', () => {
  const broken = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  const api = open(broken);
  assert.equal(api.available, false);
  api.transition('t-failed', 'retry');
  assert.equal(api.task('t-failed').status, 'working');
  assert.equal(api.available, false);
  const local = open(null);
  local.advance();
  assert.equal(local.task('t-deck').step, 1);
  assert.equal(local.available, false);
  const storage = memoryStorage();
  storage.setItem('apex-coordination-preview-v1', '{broken');
  assert.equal(open(storage).state.tasks.length, 6);
});

test('partial storage failures never claim durable persistence is available', () => {
  const unreadable = open({ getItem() { throw new Error('read blocked'); }, setItem() {} });
  assert.equal(unreadable.available, false);
  unreadable.transition('t-failed', 'retry');
  assert.equal(unreadable.task('t-failed').attempt, 2);
  assert.equal(unreadable.available, false);
  const unwritable = open({ getItem() { return null; }, setItem() { throw new Error('quota'); } });
  assert.equal(unwritable.available, false);
  unwritable.advance();
  assert.equal(unwritable.task('t-deck').step, 1);
  assert.equal(unwritable.available, false);
});

test('a classic browser script exposes the same factory without CommonJS', () => {
  const context = { console, Date, Math, JSON, Map, Set };
  vm.runInNewContext(fs.readFileSync(modulePath, 'utf8'), context);
  assert.equal(typeof context.ApexCoordination.create, 'function');
  assert.equal(context.ApexCoordination.create({ storage: null, primaryId: 'a', secondaryId: 'b' }).state.tasks.length, 6);
});

let failures = 0;
for (const { name, run } of tests) {
  try { run(); console.log('PASS ' + name); }
  catch (error) { failures += 1; console.error('FAIL ' + name); console.error(error); }
}
assert.equal(failures, 0, failures + ' coordination smoke test(s) failed');
console.log(tests.length + ' coordination state smoke tests passed.');
