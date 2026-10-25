import test from 'node:test';
import assert from 'node:assert/strict';
import { planKey, planOf, planSnapshot, recordPlan } from '../src/plans.ts';

// Hosts stand in for machines, and each test uses its own: the table is kept
// for the whole app, so a shared host would leak figures between tests.
const win = (name, used, minutes = 10_080, resets = 1_800_000_000) => ({ name, used_percent: used, window_minutes: minutes, resets_at: resets });
const usedOf = (state) => state?.windows.map((w) => w.used_percent);

test('the key names the provider, and the model when it has a group of its own', () => {
  assert.equal(planKey('gemini'), 'gemini');
  assert.equal(planKey('gemini', null), 'gemini');
  assert.equal(planKey('gemini', '  '), 'gemini');
  assert.equal(planKey('gemini', 'gemini-4-argon'), 'gemini:gemini-4-argon');
  assert.equal(planKey('gemini', ' Gemini-4-Argon '), 'gemini:gemini-4-argon');
  assert.equal(planKey('claude_code', 'claude-opus-4'), 'claude_code:claude-opus-4');
});

test('two models of one provider keep their own figures', () => {
  recordPlan('gemini', 'gemini-4-argon', [win('seven_day', 100, 10_080, 1_792_829_128)], false, 'two-models');
  recordPlan('gemini', 'gemini-3.8-flash', [win('seven_day', 2), win('five_hour', 0, 300)], false, 'two-models');
  const plans = planSnapshot('two-models');
  // Argons's weekly group is empty; the Gemini figure is barely touched.
  assert.deepEqual(usedOf(planOf(plans, 'gemini', 'gemini-4-argon')), [100]);
  assert.deepEqual(usedOf(planOf(plans, 'gemini', 'gemini-3.8-flash')), [2, 0]);
  assert.ok(planOf(plans, 'gemini', 'gemini-4-argon') !== planOf(plans, 'gemini', 'gemini-3.8-flash'));
});

test('a model with no group of its own reads the provider\'s figure', () => {
  recordPlan('gemini', null, [win('seven_day', 2), win('five_hour', 0, 300)], false, 'fallback');
  const plans = planSnapshot('fallback');
  assert.deepEqual(usedOf(planOf(plans, 'gemini', 'gemini-2.5-pro')), [2, 0]);
  assert.deepEqual(usedOf(planOf(plans, 'gemini', 'gemini-3.1-pro-preview')), [2, 0]);
  assert.deepEqual(usedOf(planOf(plans, 'gemini', null)), [2, 0]);
});

test('one model\'s group never stands in for another\'s', () => {
  recordPlan('gemini', 'gemini-4-argon', [win('seven_day', 100, 10_080, 1_792_829_128)], false, 'no-leak');
  const plans = planSnapshot('no-leak');
  assert.deepEqual(usedOf(planOf(plans, 'gemini', 'gemini-4-argon')), [100]);
  // Nothing has reported for these, so their chips say "not reported yet"
  // rather than borrowing Argon's empty group.
  assert.equal(planOf(plans, 'gemini', 'gemini-2.5-pro'), undefined);
  assert.equal(planOf(plans, 'gemini'), undefined);
  assert.equal(planOf(plans, 'codex', 'gpt-5'), undefined);
});

test('a model\'s own group wins over the provider\'s figure', () => {
  recordPlan('gemini', null, [win('seven_day', 2)], false, 'prefers');
  recordPlan('gemini', 'gemini-4-argon', [win('seven_day', 100, 10_080, 1_792_829_128)], false, 'prefers');
  const plans = planSnapshot('prefers');
  assert.deepEqual(usedOf(planOf(plans, 'gemini', 'gemini-4-argon')), [100]);
  assert.deepEqual(usedOf(planOf(plans, 'gemini', 'gemini-3.8-flash')), [2]);
});

test('a partial report merges into that group only', () => {
  recordPlan('gemini', 'gemini-4-argon', [win('seven_day', 100, 10_080, 1_792_829_128), win('five_hour', 10, 300)], false, 'partial');
  recordPlan('gemini', 'gemini-3.8-flash', [win('seven_day', 2)], false, 'partial');
  recordPlan('gemini', 'gemini-4-argon', [win('five_hour', 40, 300)], true, 'partial');
  const plans = planSnapshot('partial');
  assert.deepEqual(usedOf(planOf(plans, 'gemini', 'gemini-4-argon')), [100, 40]);
  assert.deepEqual(usedOf(planOf(plans, 'gemini', 'gemini-3.8-flash')), [2]);
});

test('reset credits stay with the figure that reported them', () => {
  const credits = { available: 1, credits: [{ id: 'c1', granted_at: 1_790_000_000 }] };
  recordPlan('claude_code', null, [win('five_hour', 65, 300)], false, 'credits', credits);
  recordPlan('claude_code', null, [win('five_hour', 0, 300)], false, 'credits');
  const state = planOf(planSnapshot('credits'), 'claude_code', 'claude-opus-4');
  assert.equal(state?.windows[0].used_percent, 0);
  assert.deepEqual(state?.credits, credits);
});
