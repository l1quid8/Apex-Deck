import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('only the main pane map opts into composer docking', () => {
  assert.match(fs.readFileSync('src/App.tsx', 'utf8'), /<ChatPane[^>]*dock=/);
  for (const file of ['TalkOnlyChat', 'PopoutApp', 'AgentsSection']) {
    assert.doesNotMatch(fs.readFileSync(`src/${file}.tsx`, 'utf8'), /\bdock=/);
  }
});
