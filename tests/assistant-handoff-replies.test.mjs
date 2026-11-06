import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyPlainHandoffReply } from '../src/assistantHandoffModel.ts';

// The client mirror is allowed to render a prediction, but it must never disagree with the host
// about what a message means. Both sides read tests/fixtures/assistant-handoff-replies.tsv;
// the host authority is crates/apex-host/src/assistant_handoff_reply.rs.
const here = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(here, 'fixtures', 'assistant-handoff-replies.tsv');

function fixtureCases() {
  const cases = [];
  const lines = fs.readFileSync(fixturePath, 'utf8').split('\n');
  lines.forEach((line, index) => {
    if (line === '' || line.trimStart().startsWith('#')) return;
    const tab = line.indexOf('\t');
    assert.ok(tab > 0, `line ${index + 1}: expected "bucket\\tmessage"`);
    const expected = line.slice(0, tab);
    const message = line.slice(tab + 1);
    assert.ok(['stop', 'continue', 'other'].includes(expected), `line ${index + 1}: bad bucket ${expected}`);
    cases.push({ expected, message });
  });
  return cases;
}

test('client mirror matches the shared host fixture', () => {
  const cases = fixtureCases();
  assert.ok(cases.length >= 40, `fixture shrank: ${cases.length} cases`);
  for (const bucket of ['stop', 'continue', 'other']) {
    assert.ok(cases.some((c) => c.expected === bucket), `fixture has no ${bucket} cases`);
  }
  const mismatches = [];
  for (const { expected, message } of cases) {
    const actual = classifyPlainHandoffReply(message);
    if (actual !== expected) mismatches.push(`${JSON.stringify(message)} -> ${actual}, host says ${expected}`);
  }
  assert.deepEqual(mismatches, [], `client/host disagree on ${mismatches.length} message(s)`);
});
