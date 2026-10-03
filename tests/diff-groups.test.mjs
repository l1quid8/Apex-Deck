import test from 'node:test';
import assert from 'node:assert/strict';
import { groupDiff } from '../src/diffGroups.ts';

const f = (path, by) => ({ path, added: 1, removed: 0, patch: '', by });

test('files group under each agent in room order, shared files under both', () => {
  const groups = groupDiff([f('a.rs', ['null']), f('b.rs', ['jigga', 'null']), f('c.rs', [])], ['jigga', 'null']);
  assert.deepEqual(groups.map((g) => [g.by, g.files.map((x) => x.path)]), [
    ['jigga', ['b.rs']],
    ['null', ['a.rs', 'b.rs']],
    [null, ['c.rs']],
  ]);
});

test('agents no longer in the room still get a group, after current ones', () => {
  const groups = groupDiff([f('a.rs', ['gone']), f('b.rs', ['jigga'])], ['jigga']);
  assert.deepEqual(groups.map((g) => g.by), ['jigga', 'gone']);
});

test('no files, no groups', () => {
  assert.deepEqual(groupDiff([], ['jigga']), []);
});
