import test from 'node:test';
import assert from 'node:assert/strict';
import { planProvider, planModel, gatewayPlan } from '../src/gatewayTelemetry.ts';
const remote = (base='https://gateway.example/model-gateway/v1', key='GATEWAY_KEY', model='claude/default') => ({ backend:{kind:'open_ai_compatible',base_url:base,api_key_env:key,model} });
test('remote subscription plans use endpoint, credential reference and model namespaces', () => {
  assert.equal(planProvider(remote()), 'claude_code');
  assert.notEqual(planModel(remote()), planModel({backend:{kind:'agent',tool:'claude_code',model:'default'}}));
  assert.notEqual(planModel(remote()), planModel(remote('https://other.example/v1')));
  assert.notEqual(planModel(remote()), planModel(remote(undefined,'OTHER_KEY')));
  assert.notEqual(planModel(remote()), planModel(remote(undefined,undefined,'claude/opus')));
  assert.equal(planModel(remote()), planModel(remote('https://gateway.example/model-gateway/v1/')));
  assert.equal(gatewayPlan(remote(undefined,undefined,'deepseek/model')), false);
  assert.equal(planProvider(remote(undefined,undefined,'unknown/model')), null);
});
import { addTokenUsage } from '../src/tokenUsage.ts';
import { tokenLine } from '../src/battery.ts';
import { tokenWords } from '../src/phoneRules.ts';
test('missing token sides stay unknown; explicit zero remains reported', () => {
  const use = addTokenUsage(undefined, { input_tokens: null, output_tokens: 4, cached_input_tokens: null });
  assert.match(tokenLine(use), /Not reported in, 4 out/);
  assert.match(tokenWords(use), /Not reported in/);
  const next = addTokenUsage(use, { input_tokens: 0, output_tokens: 3, cached_input_tokens: 0 });
  assert.match(tokenLine(next), /0 in, 7 out/);
  assert.match(tokenLine(next), /partial/i);
  assert.equal(next.cached_input, 0);
  assert.equal(tokenLine(undefined), 'Not reported');
});
import { planOf } from '../src/plans.ts';
test('remote accounts never fall back to a local provider quota', () => {
  assert.equal(planOf({claude_code:{windows:[]}}, 'claude_code', planModel(remote())), undefined);
});
import { planKey } from '../src/plans.ts';
test('gateway quota namespaces preserve case-sensitive paths and key references', () => {
  const upper = planModel(remote('https://gateway.example/A/v1', 'KEY'));
  const lower = planModel(remote('https://gateway.example/a/v1', 'key'));
  assert.notEqual(planKey('claude_code',upper),planKey('claude_code',lower));
});
