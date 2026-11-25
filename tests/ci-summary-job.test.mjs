import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { load } from 'js-yaml';

test('daemon CI always summarizes every other job', () => {
  const workflow = readFileSync(new URL('../.github/workflows/daemon.yml', import.meta.url), 'utf8');
  const { jobs } = load(workflow);
  const { 'all-checks-passed': summary, ...otherJobs } = jobs;

  assert.ok(summary, 'daemon CI must define all-checks-passed');
  assert.equal(summary.if, 'always()');
  assert.deepEqual([...summary.needs].sort(), Object.keys(otherJobs).sort());
});
