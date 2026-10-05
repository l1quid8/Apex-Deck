import test from 'node:test';
import assert from 'node:assert/strict';
import { AGENT_EFFORTS, effortsFor, modelGroups } from '../src/models.ts';

test('grok catalog order is shown least reasoning first', () => {
  const reported = [
    { id: 'grok-4.7', label: 'Grok 4.7', efforts: ['xhigh', 'high', 'medium', 'low'] },
    { id: 'grok-4.5', label: 'Grok 4.5', efforts: ['high', 'medium', 'low'] },
  ];
  const groups = modelGroups('grok', reported, 'Grok');
  assert.deepEqual(effortsFor(AGENT_EFFORTS.grok, groups, 'grok-4.7'), ['low', 'medium', 'high', 'xhigh']);
  assert.deepEqual(effortsFor(AGENT_EFFORTS.grok, groups, 'grok-4.5'), ['low', 'medium', 'high']);
  assert.deepEqual(effortsFor(AGENT_EFFORTS.grok, groups, ''), ['low', 'medium', 'high', 'xhigh']);
  assert.deepEqual(reported[0].efforts, ['xhigh', 'high', 'medium', 'low']);
});

test('unknown reasoning levels stay after the known ones', () => {
  const groups = [{ label: 'Grok', models: [{ id: 'grok-4.7', efforts: ['custom', 'high', 'low', 'other'] }] }];
  assert.deepEqual(effortsFor([], groups, 'grok-4.7'), ['low', 'high', 'custom', 'other']);
});

test('a model with no effort setting stays empty', () => {
  const groups = modelGroups('grok', [{ id: 'grok-4.7-fast', efforts: [] }], 'Grok');
  assert.deepEqual(effortsFor(AGENT_EFFORTS.grok, groups, 'grok-4.7-fast'), []);
});
