import test from 'node:test';
import assert from 'node:assert/strict';
import { AGENT_EFFORTS, apiModelGroups, apiModelList, contextSize, defaultEffortFor, effortsFor, modelGroups } from '../src/models.ts';

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

test('api model lists accept old string names and new objects', () => {
  assert.deepEqual(apiModelList(['llama3', '']), [{ id: 'llama3' }]);
  assert.deepEqual(apiModelList([{ id: 'glm', label: 'GLM 5.2', efforts: ['none'] }, { label: 'no id' }, 3, null]), [{ id: 'glm', label: 'GLM 5.2', efforts: ['none'] }]);
  assert.deepEqual(apiModelList({ data: [] }), []);
});

test('context sizes read as K and M', () => {
  assert.equal(contextSize(128000), '128K');
  assert.equal(contextSize(1000000), '1M');
  assert.equal(contextSize(1500000), '1.5M');
  assert.equal(contextSize(null), '');
});

test('provider models are one group labelled with context size', () => {
  const groups = apiModelGroups([
    { id: 'glm-5.2', label: 'GLM 5.2', context_tokens: 1000000, efforts: ['none', 'high'] },
    { id: 'llama-3.3', label: 'Llama 3.3', context_tokens: 128000 },
    { id: 'plain' },
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].label, 'Offered by this provider');
  assert.deepEqual(groups[0].models, [
    { id: 'glm-5.2', label: 'GLM 5.2 · 1M context', efforts: ['none', 'high'] },
    { id: 'llama-3.3', label: 'Llama 3.3 · 128K context', efforts: undefined },
    { id: 'plain', label: 'plain', efforts: undefined },
  ]);
  assert.deepEqual(apiModelGroups([]), []);
});

test('new bots start on medium, else the nearest level above it, else below', () => {
  assert.equal(defaultEffortFor(['low', 'medium', 'high']), 'medium');
  assert.equal(defaultEffortFor(['none', 'high', 'max']), 'high');
  assert.equal(defaultEffortFor(['none', 'low']), 'low');
  assert.equal(defaultEffortFor(['minimal', 'low']), 'low');
  assert.equal(defaultEffortFor([]), '');
});

test('picture and video models get their own sections, text first', () => {
  const groups = apiModelGroups([
    { id: 'glm-5.2', label: 'GLM 5.2', efforts: ['none', 'high'] },
    { id: 'pic-1', label: 'Picture 1', kind: 'image', media: { prices: { '1K': 0.03 } } },
    { id: 'vid-1', kind: 'video', efforts: ['high'] },
    { id: 'pic-2', kind: 'image' },
  ]);
  assert.deepEqual(groups.map(g => g.label), ['Text', 'Image', 'Video']);
  assert.deepEqual(groups[0].models, [{ id: 'glm-5.2', label: 'GLM 5.2', efforts: ['none', 'high'] }]);
  assert.deepEqual(groups[1].models.map(m => m.id), ['pic-1', 'pic-2']);
  assert.deepEqual(groups[2].models, [{ id: 'vid-1', label: 'vid-1', efforts: [] }]);
});

test('a list with only pictures shows only the Image section', () => {
  const groups = apiModelGroups([{ id: 'pic-1', kind: 'image' }]);
  assert.deepEqual(groups.map(g => g.label), ['Image']);
});

test('a text-only list keeps the single unlabelled-by-kind group', () => {
  assert.deepEqual(apiModelGroups([{ id: 'a' }, { id: 'b', kind: 'text' }]).map(g => g.label), ['Offered by this provider']);
});
