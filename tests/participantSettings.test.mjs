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
