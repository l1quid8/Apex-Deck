import test from 'node:test';
import assert from 'node:assert/strict';
import { GENERATED_UI_RUNTIME_POLICY, clientCapabilitiesForGeneratedRuntime, readGeneratedUiCapability } from '../shared/generatedUiCapability.mjs';

const claim = {
  protocolVersion: 1, adapterVersion: 'open-intelligent-ui-8391a94-deck-1',
  securityPolicyVersion: 'generated-ui-deny-all-1', electronVersion: '44.5.1', chromiumVersion: '152.0.7977.130',
};
const reviewed = {
  protocolVersion: 1, adapterVersion: 'open-intelligent-ui-8391a94-deck-2',
  securityPolicyVersion: 'generated-ui-deny-all-3', electronVersion: '44.5.1', chromiumVersion: '152.0.7977.130',
};
test('the registry approves only the runtime that passed the packaged gates', () => {
  assert.deepEqual(GENERATED_UI_RUNTIME_POLICY.verifiedRuntimeBuilds, [{ electronVersion: '44.5.1', chromiumVersion: '152.0.7977.130' }]);
  assert.deepEqual(readGeneratedUiCapability(reviewed), reviewed);
  assert.deepEqual(clientCapabilitiesForGeneratedRuntime({ enabled: true, reason: 'verified', guidance: reviewed }), { generated_ui: reviewed });
  for (const changed of [{ electronVersion: '44.5.2' }, { chromiumVersion: '152.0.7977.131' }, { adapterVersion: 'open-intelligent-ui-8391a94-deck-3' }, { securityPolicyVersion: 'generated-ui-deny-all-2' }]) {
    assert.equal(readGeneratedUiCapability({ ...reviewed, ...changed }), undefined, JSON.stringify(changed));
  }
});
test('standalone harness success cannot advertise an older adapter and policy', () => {
  assert.equal(readGeneratedUiCapability(claim), undefined);
  assert.equal(clientCapabilitiesForGeneratedRuntime({ enabled: true, reason: 'harness success', guidance: claim }), undefined);
  assert.equal(clientCapabilitiesForGeneratedRuntime({ enabled: true, reason: 'harness success' }), undefined);
});
test('old, browser, disabled, malformed and policy-mismatched clients retain comparison guidance', () => {
  for (const value of [undefined, {}, { enabled: false, guidance: reviewed }, { enabled: true, guidance: { ...reviewed, extra: true } },
    { enabled: true, guidance: { ...reviewed, protocolVersion: '1' } }, { enabled: true, guidance: { ...reviewed, securityPolicyVersion: 'old' } }]) {
    assert.equal(clientCapabilitiesForGeneratedRuntime(value), undefined);
  }
});
