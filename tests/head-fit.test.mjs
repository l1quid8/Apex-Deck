import test from 'node:test';
import assert from 'node:assert/strict';
import { headFit } from '../src/headFit.ts';

const parts = [
  { id: 'dot', width: 8 }, { id: 'project', width: 70 }, { id: 'title', width: 56 },
  { id: 'host', width: 50 }, { id: 'status', width: 60 }, { id: 'server', width: 40 },
  { id: 'counts', width: 34 }, { id: 'maximize', width: 20 }, { id: 'menu', width: 20 }, { id: 'close', width: 20 },
];
const visible = width => parts.filter(part => !headFit(width, parts).has(part.id)).map(part => part.id);

test('at 190px the title, dot, and all three controls keep their place', () => {
  assert.deepEqual(visible(190), ['dot', 'title', 'maximize', 'menu', 'close']);
});

test('at 125px maximize and menu yield before the dot, title, or Close', () => {
  assert.deepEqual(visible(125), ['dot', 'title', 'close']);
  assert.deepEqual(visible(30), ['dot', 'title', 'close']);
});

test('parts shed in priority order only after the title reaches its minimum', () => {
  for (const [width, hidden] of [
    [430, []], [429, ['status']], [365, ['status', 'server']],
    [321, ['status', 'server', 'host']], [267, ['status', 'server', 'host', 'counts']],
    [229, ['status', 'server', 'host', 'counts', 'project']],
    [155, ['status', 'server', 'host', 'counts', 'project', 'maximize']],
    [131, ['status', 'server', 'host', 'counts', 'project', 'maximize', 'menu']],
  ]) assert.deepEqual([...headFit(width, parts)], hidden, `width ${width}`);
});

test('missing optional parts take no width or gap', () => {
  const simple = parts.filter(part => ['dot', 'title', 'close'].includes(part.id));
  assert.deepEqual([...headFit(108, simple)], []);
});
