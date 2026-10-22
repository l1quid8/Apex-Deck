import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { CALL_VOICES, defaultVoiceOf, readVoiceSettings } from '../src/voice/settings.ts';
import { voiceLabel } from '../src/voice/callView.ts';

const { transform } = createRequire(import.meta.url)('sucrase');
const source = fs.readFileSync(new URL('../src/ChatPane.tsx', import.meta.url), 'utf8');

/** The agent form's Voice field, rendered from the real source with a stand-in React. */
function renderVoice({ draft = {}, voice = {}, set = () => {} }) {
  const start = source.indexOf('<label className="voice-field">');
  assert.ok(start > 0, 'the agent form has a Voice field');
  const end = source.indexOf('</label>', start) + '</label>'.length;
  const compiled = transform(`return (${source.slice(start, end)});`, { transforms: ['typescript', 'jsx'], jsxRuntime: 'classic' }).code;
  const React = { createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() }) };
  const VoiceSampleButton = () => null;
  return new Function('React', 'CALL_VOICES', 'defaultVoiceOf', 'voiceLabel', 'VoiceSampleButton', 'draft', 'voiceConfig', 'set', compiled)(
    React, CALL_VOICES, defaultVoiceOf, voiceLabel, VoiceSampleButton, draft, readVoiceSettings(voice), set);
}
const isSample = (node) => typeof node?.type === 'function';
const find = (node, type) => node?.type === type ? node : (node?.children ?? []).map((c) => find(c, type)).find(Boolean);
const options = (select) => select.children.filter((c) => c?.type === 'option').map((o) => ({ value: o.props.value, text: o.children.join('') }));

test('Voice field: Default names the Settings voice, then every call voice', () => {
  const select = find(renderVoice({ voice: { defaultVoice: 'af_heart' } }), 'select');
  assert.equal(select.props.value, '');
  const list = options(select);
  assert.deepEqual(list[0], { value: '', text: 'Default · Heart · US' });
  assert.equal(list.length, 1 + CALL_VOICES.length);
});
test('Voice field: picking a voice sets the draft; an old saved voice stays listed', () => {
  const calls = [];
  const select = find(renderVoice({ draft: { voice: 'zf_xiaoxiao' }, set: (k, v) => calls.push([k, v]) }), 'select');
  assert.equal(select.props.value, 'zf_xiaoxiao');
  assert.ok(options(select).some((o) => o.value === 'zf_xiaoxiao'));
  select.props.onChange({ target: { value: 'bf_emma' } });
  assert.deepEqual(calls, [['voice', 'bf_emma']]);
});
test('Voice field: the play button samples the picked voice, else the Settings voice', () => {
  const sample = (args) => {
    const walk = (n) => isSample(n) ? n : (n?.children ?? []).map(walk).find(Boolean);
    return walk(renderVoice(args)).props.voice;
  };
  assert.equal(sample({ voice: { defaultVoice: 'af_heart' } }), 'af_heart');
  assert.equal(sample({ draft: { voice: 'bf_emma' }, voice: { defaultVoice: 'af_heart' } }), 'bf_emma');
  assert.equal(sample({}), 'am_michael');
});
test('the agent form loads and saves the voice; empty saves none', () => {
  assert.match(source, /voice: config\.voice \?\? ""/);
  assert.match(source, /\.\.\.\(draft\.voice \? \{ voice: draft\.voice \} : \{\}\)/);
});
test('calls hear the agent voice from the chat participant', () => {
  assert.match(source, /agentVoice:p\.voice/);
});
