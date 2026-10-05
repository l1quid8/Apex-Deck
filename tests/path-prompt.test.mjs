import test from 'node:test';
import assert from 'node:assert/strict';
import { folderRows, listingUnsupported, pathPromptStore } from '../src/typedPath.ts';

const listing = { path: '/srv', parent: '/', folders: ['.git', 'app', 'logs'], files: ['.env', 'notes.md'], truncated: false };

test('picking a folder shows only folders, each with its full path', () => {
  assert.deepEqual(folderRows(listing, 'directory', false), [
    { name: 'app', path: '/srv/app', folder: true },
    { name: 'logs', path: '/srv/logs', folder: true },
  ]);
});

test('picking a file shows folders to open, then files', () => {
  assert.deepEqual(folderRows(listing, 'file', false).map(row => [row.name, row.folder]), [['app', true], ['logs', true], ['notes.md', false]]);
});

test('names starting with a dot show only when asked', () => {
  assert.deepEqual(folderRows(listing, 'file', true).map(row => row.name), ['.git', 'app', 'logs', '.env', 'notes.md']);
});

test('paths in the top folder have one slash', () => {
  assert.deepEqual(folderRows({ ...listing, path: '/', parent: null }, 'directory', false)[0], { name: 'app', path: '/app', folder: true });
});

test('a daemon from before folder listing is told apart from a folder that cannot be opened', () => {
  assert.equal(listingUnsupported(new Error('unknown variant `folder_list`, expected one of `session_load`, `session_save`')), true);
  assert.equal(listingUnsupported(new Error('Nothing is at /nope.')), false);
  assert.equal(listingUnsupported('unknown variant `folder_list`'), true);
});

test('one question at a time, answered or cancelled', async () => {
  const prompts = pathPromptStore();
  const seen = [];
  prompts.subscribe(() => seen.push(prompts.get()?.title ?? null));
  const first = prompts.ask({ kind: 'directory', title: 'Add a workspace folder' });
  assert.equal(prompts.get().kind, 'directory');
  // A second question replaces the first, which is cancelled.
  const second = prompts.ask({ kind: 'file', title: 'Pick a file' });
  assert.equal(await first, null);
  prompts.answer(' /srv/app ');
  assert.equal(await second, '/srv/app');
  assert.equal(prompts.get(), null);
  const third = prompts.ask({ kind: 'file', title: 'Again' });
  prompts.answer(null);
  assert.equal(await third, null);
  assert.deepEqual(seen, ['Add a workspace folder', 'Pick a file', null, 'Again', null]);
});

test('the next question opens where the last answer was', () => {
  const prompts = pathPromptStore();
  assert.equal(prompts.startAt(), null);
  prompts.ask({ kind: 'directory', title: 'Add a workspace folder' });
  prompts.answer('/home/me/projects/app');
  assert.equal(prompts.startAt(), '/home/me/projects');
  prompts.ask({ kind: 'directory', title: 'Add a workspace folder' });
  prompts.answer(null);
  assert.equal(prompts.startAt(), '/home/me/projects');
  prompts.ask({ kind: 'directory', title: 'Add a workspace folder' });
  prompts.answer('/srv');
  assert.equal(prompts.startAt(), '/');
});
