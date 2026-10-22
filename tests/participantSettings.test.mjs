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
test('picture and video choices merge into the saved ones', () => {
  const picture = applyTurnChange({ ...bot, backend: { kind: 'open_ai_compatible', base_url: 'https://x', model: 'pic', api_key_env: null }, effort: null, media: { aspect_ratio: '1:1', resolution: '1K' } }, { media: { quality: 'high' } });
  assert.deepEqual(picture.media, { aspect_ratio: '1:1', resolution: '1K', quality: 'high' });
  assert.equal(picture.effort, null);
  const bare = applyTurnChange({ ...bot, effort: null }, { media: { build_on_last: false } });
  assert.deepEqual(bare.media, { build_on_last: false });
  assert.equal(bot.media, undefined);
});
test('speed is saved when picked and removed when set back to Default', () => {
  const fast = applyTurnChange(bot, { speed: 'fast' });
  assert.equal(fast.speed, 'fast');
  assert.equal(fast.effort, bot.effort, 'other settings stay');
  assert.equal('speed' in applyTurnChange(fast, { speed: null }), false);
  assert.equal(applyTurnChange(fast, { effort: 'high' }).speed, 'fast', 'a reasoning change keeps the speed');
});

test('access picks persist without overwriting another clients model or persona', () => {
  const current = { ...bot, persona: 'Updated elsewhere', backend: { ...bot.backend, model: 'updated-model' } };
  const full = applyTurnChange(current, { access: 'full' });
  assert.equal(full.access, 'full');
  assert.equal(full.backend.model, 'updated-model');
  assert.equal(full.persona, 'Updated elsewhere');
  assert.equal(applyTurnChange(full, { access: 'read' }).access, 'read');
  assert.equal(applyTurnChange(full, { effort: 'high' }).access, 'full');
  assert.equal(bot.access, 'read');
});
