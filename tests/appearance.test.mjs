import test from 'node:test';
import assert from 'node:assert/strict';
import * as appearance from '../src/identicon.ts';

test('new identities avoid occupied colors and patterns and survive serialization', () => {
  assert.equal(typeof appearance.createAppearance, 'function');
  const used = [];
  for (let i = 0; i < 24; i++) {
    const next = appearance.createAppearance(used);
    assert.ok(appearance.NEW_AGENT_COLORS.includes(next.color));
    assert.ok(!used.some(a => JSON.stringify(appearance.identiconCells(a.seed)) === JSON.stringify(appearance.identiconCells(next.seed))));
    if (i < appearance.NEW_AGENT_COLORS.length) assert.ok(!used.some(a => a.color === next.color));
    assert.deepEqual(JSON.parse(JSON.stringify(next)), next);
    used.push(next);
  }
});

test('new agents never get the attention colours, and take unused colours in order', () => {
  const attention = ['#f59e0b', '#fb7185', '#22d3ee'];
  const used = [];
  for (let i = 0; i < 12; i++) {
    const next = appearance.createAppearance(used);
    assert.ok(!attention.includes(next.color), next.color);
    if (i < 5) assert.equal(next.color, appearance.NEW_AGENT_COLORS[i]);
    used.push(next);
  }
});

test('older agents without a saved colour keep the colour they always had', () => {
  // Recorded from the code before the new-agent pool was added.
  const before = { opus: '#a78bfa', codex: '#60a5fa', reviewer: '#a78bfa', null: '#60a5fa', jigga: '#f59e0b' };
  for (const [id, color] of Object.entries(before)) assert.equal(appearance.legacyAppearance(id).color, color, id);
  assert.equal(appearance.AGENT_COLORS.length, 8);
});
