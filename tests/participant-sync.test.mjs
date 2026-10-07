import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeParticipant } from '../src/participantSettings.ts';
const base = { id: 'null', display_name: 'Null', persona: '', access: 'ask', effort: 'high', backend: { kind: 'agent', tool: 'claude_code', model: 'sonnet' } };
test('a stale desktop reasoning edit preserves a model saved by the phone', () => {
  const current = { ...base, backend: { ...base.backend, model: 'opus' }, persona: 'new persona' };
  const merged = mergeParticipant(current, base, { ...base, effort: 'low' });
  assert.equal(merged.backend.model, 'opus');
  assert.equal(merged.effort, 'low');
  assert.equal(merged.persona, 'new persona');
});
test('a model edit preserves external reasoning, while an explicit default clears it', () => {
  const current = { ...base, effort: 'low' };
  const next = { ...base, backend: { ...base.backend, model: 'opus' } };
  assert.equal(mergeParticipant(current, base, next).effort, 'low');
  assert.equal(mergeParticipant(current, base, { ...next, effort: null }).effort, null);
});
test('an explicit queued pick can return to the original model while preserving remote reasoning', async () => {
  const { applyTurnChange } = await import('../src/participantSettings.ts');
  assert.equal(typeof applyTurnChange, 'function');
  const current = { ...base, backend: { ...base.backend, model: 'opus' }, effort: 'low' };
  const next = applyTurnChange(current, { model: 'sonnet' });
  assert.equal(next.backend.model, 'sonnet');
  assert.equal(next.effort, 'low');
});
