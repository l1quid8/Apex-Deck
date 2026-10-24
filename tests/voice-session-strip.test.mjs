import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const { transform } = createRequire(import.meta.url)('sucrase');

const tsxSource = fs.readFileSync(new URL('../src/voice/VoiceCallControls.tsx', import.meta.url), 'utf8');
const compiled = transform(
  tsxSource
    .replace(/^import .*;\n/gm, '')
    .replace(/^export /gm, ''),
  { transforms: ['typescript', 'jsx'], jsxRuntime: 'classic' }
).code;

test('VoiceSessionStrip and Clock are defined in VoiceCallControls', () => {
  assert.ok(tsxSource.includes('export function VoiceSessionStrip'));
  assert.ok(tsxSource.includes('export function Clock'));
});

test('VoiceSessionStrip returns null when call is not live or look is not capsule', () => {
  assert.ok(tsxSource.includes('call.look !== "capsule"'));
  assert.ok(tsxSource.includes('voice-session-strip'));
  assert.ok(tsxSource.includes('dot-strip-ctrls'));
});

test('VoiceSessionStrip stops propagation on clicks and pointer down', () => {
  assert.ok(tsxSource.includes('onPointerDown={(e) => e.stopPropagation()}'));
  assert.ok(tsxSource.includes('onClick={(e) => e.stopPropagation()}'));
});

test('VoiceSessionStrip end button uses round class and restrained red style', () => {
  const css = fs.readFileSync(new URL('../src/assistant-workspace.css', import.meta.url), 'utf8');
  assert.ok(css.includes('.voice-session-strip .voice-end.round'));
  assert.ok(css.includes('color-mix(in srgb,var(--danger) 14%,transparent)!important'));
});

test('VoiceSessionStrip reveals on hover/focus and hides 200ms after leave', () => {
  assert.ok(tsxSource.includes('.assistant-session'));
  assert.ok(tsxSource.includes('show-ctrls'));
  assert.ok(tsxSource.includes('200'));
});

// Picking a look moves the controls, so the popup that offered the choice has to
// close wherever it was opened — regular threads included, not just the
// assistant's strip. Enforced by making the prop required: a new call site that
// forgets it fails to type-check, so this counts them and checks each one.
test('every call settings popup closes when a look is picked', () => {
  const sites = tsxSource.split('<CallSettings').slice(1);
  assert.ok(sites.length >= 4, `expected the bar, capsule, strip and pill popups, found ${sites.length}`);
  for (const site of sites) {
    const element = site.slice(0, site.indexOf('/>'));
    assert.ok(element.includes('onPickLook'), `a call settings popup offers a look change without closing itself: ${element.slice(0, 80)}`);
  }
  assert.ok(!tsxSource.includes('onPickLook?:'), 'the prop stays required so no site can opt out silently');
  assert.ok(tsxSource.includes('onPickLook();'), 'the pick actually closes the popup');
});

test('AssistantWorkspace displays italic Listening status and Clock when in call', () => {
  const source = fs.readFileSync(new URL('../src/AssistantWorkspace.tsx', import.meta.url), 'utf8');
  assert.ok(source.includes("<em>{voiceState.muted?'Muted':'Listening'}</em>"));
  assert.ok(source.includes('<Clock since={voiceState.startedAt}/>'));
  assert.ok(source.includes('assistant-strip-phone'));
  assert.ok(source.includes('!inCall&&'));
});

test('ApexAgentAll hides composer call button when in capsule call', () => {
  const source = fs.readFileSync(new URL('../src/ApexAgentAll.tsx', import.meta.url), 'utf8');
  assert.ok(source.includes("!(voice.slot.live && voice.slot.look === 'capsule')"));
  assert.ok(source.includes('<VoiceSessionStrip'));
});
