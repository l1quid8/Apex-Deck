import test from 'node:test';
import assert from 'node:assert/strict';

// These imports will fail until implementation exists – intentional RED
import { parseRunnerCommand } from '../src/runner/commands.ts';

test('reserved words only match alone', () => {
  const cmd = parseRunnerCommand('goal', 'pause the old servers');
  assert.equal(cmd.kind, 'start');
  // objective should be the full phrase, not treated as control
  assert.equal(cmd.objective, 'pause the old servers');
});

test('/goal start pause starts with objective pause', () => {
  const cmd = parseRunnerCommand('goal', 'start pause');
  assert.equal(cmd.kind, 'start');
  assert.equal(cmd.objective, 'pause');
});

test('//goal stays text - parsed as escape outside', async () => {
  const { parseComposer } = await import('../src/commands.ts');
  const parsed = parseComposer('//goal fix bug');
  assert.ok('text' in parsed);
  if ('text' in parsed) {
    assert.equal(parsed.text, '//goal fix bug');
  }
});

test('loop interval parsing - valid cases', async () => {
  const { parseIntervalSeconds } = await import('../src/runner/types.ts');
  assert.equal(parseIntervalSeconds('10s'), 10);
  assert.equal(parseIntervalSeconds('24h'), 24 * 3600);
  assert.equal(parseIntervalSeconds('10m'), 600);
});

test('loop interval parsing - invalid cases', async () => {
  const { parseIntervalSeconds } = await import('../src/runner/types.ts');
  assert.throws(() => parseIntervalSeconds('9s'), /interval/i);
  assert.throws(() => parseIntervalSeconds('0m'), /interval/i);
  assert.throws(() => parseIntervalSeconds('1.5m'), /interval/i);
  assert.throws(() => parseIntervalSeconds('25h'), /interval/i);
  assert.throws(() => parseIntervalSeconds(''), /interval/i);
});

test('loop start requires prompt', () => {
  const cmd = parseRunnerCommand('loop', '10m');
  assert.equal(cmd.kind, 'error');
  const ok = parseRunnerCommand('loop', '10m check build');
  assert.equal(ok.kind, 'start');
  assert.equal(ok.prompt, 'check build');
});
