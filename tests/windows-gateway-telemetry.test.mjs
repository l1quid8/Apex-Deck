import test from 'node:test';
import assert from 'node:assert/strict';
import { tokenLine } from '../src/battery.ts';

test('a gateway with no reported token totals remains unknown', () => {
  assert.equal(tokenLine(undefined), 'Not reported');
});

test('a missing input total is distinct from an explicitly reported zero', () => {
  const missing = { input: 0, output: 7, turns: 1, input_reported_turns: 0, output_reported_turns: 1 };
  assert.match(tokenLine(missing), /Not reported in, 7 out/);
  assert.match(tokenLine({ ...missing, input_reported_turns: 1 }), /0 in, 7 out/);
});
