import test from 'node:test';
import assert from 'node:assert/strict';
import * as appearance from '../src/identicon.ts';

test('new identities avoid occupied colors and patterns and survive serialization', () => {
  assert.equal(typeof appearance.createAppearance, 'function');
  const used = [];
  for (let i = 0; i < 24; i++) {
    const next = appearance.createAppearance(used);
    assert.ok(appearance.AGENT_COLORS.includes(next.color));
    assert.ok(!used.some(a => JSON.stringify(appearance.identiconCells(a.seed)) === JSON.stringify(appearance.identiconCells(next.seed))));
    if (i < appearance.AGENT_COLORS.length) assert.ok(!used.some(a => a.color === next.color));
    assert.deepEqual(JSON.parse(JSON.stringify(next)), next);
    used.push(next);
  }
});
