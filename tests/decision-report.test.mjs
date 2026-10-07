import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

test('thinking entries do not alter the week-one routing grades', () => {
  const dir = mkdtempSync(join(tmpdir(), 'deck-thinking-report-'));
  try {
    const log = join(dir, 'decisions.jsonl');
    writeFileSync(log, [
      { deck_targets: ['null'], suggested_targets: ['null'], result: { latency_ms: 100, usage: { cost: 0.01 } } },
      { kind: 'thinking', agent: 'null', usage: { cost: 0.02 }, thinking: { choice: 'high', probabilities: { low: 0.1, medium: 0.2, high: 0.7 } } },
      { kind: 'thinking', agent: 'null', error: 'Decision request timed out' },
    ].map(row => JSON.stringify(row)).join('\n'));
    const result = spawnSync('python3', ['scripts/decision-report.py', log], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Observations: 1; usable: 1; stale: 0; errors: 0/);
    assert.match(result.stdout, /Agreement with Deck: 1\/1/);
    assert.match(result.stdout, /Reported cost: \$0.030000/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
