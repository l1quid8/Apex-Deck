import test from 'node:test';
import assert from 'node:assert/strict';
import { pathProblem, pathPromptStore } from '../src/typedPath.ts';

test('a typed path must be a full one', () => {
  assert.equal(pathProblem(''), 'Type a path.');
  assert.equal(pathProblem('   '), 'Type a path.');
  assert.equal(pathProblem('src/app'), 'Use a full path, starting with /.');
  assert.equal(pathProblem('~/app'), 'Use a full path, starting with /.');
  assert.equal(pathProblem('/srv/app'), null);
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
