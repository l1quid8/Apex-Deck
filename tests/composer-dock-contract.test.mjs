import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { transform } from 'sucrase';

test('only the main pane map opts into composer docking', () => {
  // Parse JSX before checking props: `>` also occurs in arrow callbacks in
  // earlier props, so it cannot delimit the opening tag in the source.
  const { code } = transform(fs.readFileSync('src/App.tsx', 'utf8'), { transforms: ['typescript', 'jsx'] });
  assert.match(code, /React\.createElement\(ChatPane,\s*\{[\s\S]*?\bdock:/);
  for (const file of ['TalkOnlyChat', 'PopoutApp', 'AgentsSection']) {
    assert.doesNotMatch(fs.readFileSync(`src/${file}.tsx`, 'utf8'), /\bdock=/);
  }
});

test('pop-out and move reserve ownership synchronously and move suspends an empty queue', () => {
  const source = fs.readFileSync('src/App.tsx', 'utf8');
  const pop = source.slice(source.indexOf('const popOutPane ='), source.indexOf('const popOutTab ='));
  assert.match(pop, /ownerRefusal\("pop out"/);
  assert.match(pop, /leaveRefusal\(sendApis.get\(paneId\)/);
  assert.ok(pop.indexOf('setOutside(paneId, true)') < pop.indexOf('bridge.open(snapshot'));
  const move = source.slice(source.indexOf('const moveDraft ='), source.indexOf('const forkTo ='));
  assert.match(move, /ownerRefusal\("move"/);
  assert.match(move, /leaveRefusal\(sendApis.get\(pane.id\)/);
  assert.ok(move.indexOf('.suspend(') < move.indexOf('await flushAnswerStores'));
  assert.match(move, /finally\s*\{\s*release\?\.\(\)/);
});
