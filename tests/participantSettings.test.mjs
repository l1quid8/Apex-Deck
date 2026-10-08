import test from 'node:test';
import assert from 'node:assert/strict';
import { withTurnSettings } from '../src/participantSettings.ts';
const bot = { id: 'null', display_name: 'Null', persona: 'Engineer', access: 'read', effort: 'ultra', backend: { kind: 'agent', tool: 'codex', model: 'gpt-6-astra' } };
test('changing models keeps identity and clears unsupported reasoning', () => {
  const next = withTurnSettings(bot, 'gpt-6-luna', 'ultra', ['low', 'medium', 'high', 'max']);
  assert.equal(next.effort, null);
  assert.equal(next.backend.model, 'gpt-6-luna');
  assert.equal(next.persona, bot.persona);
  assert.equal(bot.backend.model, 'gpt-6-astra');
});
test('supported reasoning persists and default model stays null for agents', () => {
  assert.equal(withTurnSettings(bot, '', 'high', ['high']).backend.model, null);
  assert.equal(withTurnSettings(bot, '', 'high', ['high']).effort, 'high');
});

import { applyTurnChange } from '../src/participantSettings.ts';
test('Auto preserves the current level as its backup and a manual level turns Auto off', () => {
  const auto = applyTurnChange(bot, { auto_effort: true });
  assert.equal(auto.auto_effort, true);
  assert.equal(auto.effort, 'ultra');
  const manual = applyTurnChange(auto, { effort: 'high' });
  assert.equal(manual.auto_effort, false);
  assert.equal(manual.effort, 'high');
  assert.equal(bot.auto_effort, undefined);
});
test('changing only the Auto backup keeps Auto on', () => {
  const auto = applyTurnChange({ ...bot, auto_effort: true }, { effort: 'medium', auto_effort: true });
  assert.equal(auto.effort, 'medium');
  assert.equal(auto.auto_effort, true);
});

test('picture and video choices merge into the saved ones', () => {
  const picture = applyTurnChange({ ...bot, backend: { kind: 'open_ai_compatible', base_url: 'https://x', model: 'pic', api_key_env: null }, effort: null, media: { aspect_ratio: '1:1', resolution: '1K' } }, { media: { quality: 'high' } });
  assert.deepEqual(picture.media, { aspect_ratio: '1:1', resolution: '1K', quality: 'high' });
  assert.equal(picture.effort, null);
  const bare = applyTurnChange({ ...bot, effort: null }, { media: { build_on_last: false } });
  assert.deepEqual(bare.media, { build_on_last: false });
  assert.equal(bot.media, undefined);
});
