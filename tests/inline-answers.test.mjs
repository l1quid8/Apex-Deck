import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readCard } from '../src/interactiveAnswers/schema.ts';
import { withCardSummaries } from '../src/interactiveAnswers/share.ts';

const prompt = readFileSync(new URL('../crates/apex-core/src/view.rs', import.meta.url), 'utf8');
const examples = prompt.split('\n').filter(line => /^\{"schemaVersion":1,"kind":"(flowchart|scale|bars)"/.test(line)).map(line => JSON.parse(line));

test('phone prompt examples parse and export as readable answers', () => {
  assert.deepEqual(examples.map(card => card.kind), ['flowchart', 'scale', 'bars']);
  for (const example of examples) {
    const source = JSON.stringify(example);
    assert.deepEqual(readCard(source), { ok: true, card: example });
    const exported = withCardSummaries(['```apex-ui', source, '```'].join('\n'), 1);
    assert.ok(exported.includes(example.title));
    assert.ok(!exported.includes('schemaVersion'));
  }
});

test('invalid controls cannot produce empty stages, invalid ranges or overflowing chart arithmetic', () => {
  const [flow, scale, bars] = examples;
  for (const card of [
    { ...flow, stages: [] },
    { ...scale, input: { ...scale.input, step: 0 } },
    { ...scale, input: { ...scale.input, step: 200, default: 1 } },
    { ...scale, input: { ...scale.input, default: 30.5 } },
    { ...scale, factor: Number.MAX_VALUE },
    { ...bars, points: [{ label: 'A', value: 1e308 }, { label: 'B', value: -1e308 }] },
  ]) assert.equal(readCard(JSON.stringify(card)).ok, false);
});
