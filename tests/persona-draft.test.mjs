import test from 'node:test';
import assert from 'node:assert/strict';
import { personaWriters, defaultWriter, applyPersona, DraftRun } from '../src/personaDraft.ts';

const presets = [
  { key: 'claude_code', label: 'Claude Code', tool: 'claude_code', installed: true },
  { key: 'codex', label: 'Codex', tool: 'codex', installed: true },
  { key: 'gemini', label: 'Gemini CLI', tool: 'gemini', installed: false },
];
const saved = (id, backend, extra = {}) => ({ id, display_name: id, backend, persona: 'mine', access: 'full', effort: null, ...extra });

test('writers are installed, enabled agents, then saved chat agents', () => {
  const profiles = [
    saved('venice', { kind: 'open_ai_compatible', base_url: 'https://api.venice.ai/api/v1', model: 'llama', api_key_env: 'VENICE_API_KEY' }),
    saved('pics', { kind: 'open_ai_compatible', base_url: 'https://api.venice.ai/api/v1', model: 'flux', api_key_env: 'VENICE_API_KEY' }, { media: {} }),
    saved('script', { kind: 'scripted', lines: [] }),
    saved('cmd', { kind: 'cli', program: 'sh', args: [] }),
  ];
  const writers = personaWriters(presets, profiles, ['codex']);
  assert.deepEqual(writers.map((w) => w.key), ['agent:claude_code', 'saved:venice']);
  assert.deepEqual(writers[0].config.backend, { kind: 'agent', tool: 'claude_code', model: null });
  assert.equal(writers[1].logo, 'api');
});

test('writers never carry their own persona or more than read access', () => {
  const writers = personaWriters(presets, [saved('opus', { kind: 'agent', tool: 'claude_code', model: 'opus' })], []);
  for (const w of writers) {
    assert.equal(w.config.persona, '');
    assert.equal(w.config.access, 'read');
  }
});

test('a disabled provider hides saved agents that use it', () => {
  const writers = personaWriters(presets, [saved('opus', { kind: 'agent', tool: 'claude_code', model: 'opus' })], ['claude']);
  assert.deepEqual(writers.map((w) => w.key), ['agent:codex']);
});

test('default writer follows the form, else the first', () => {
  const writers = personaWriters(presets, [], []);
  assert.equal(defaultWriter(writers, 'codex'), 'agent:codex');
  assert.equal(defaultWriter(writers, 'ollama'), 'agent:claude_code');
  assert.equal(defaultWriter([], 'codex'), '');
});

test('applyPersona fills an empty name and replaces the persona', () => {
  assert.deepEqual(applyPersona({ name: '', persona: 'old' }, { name: 'Vex', persona: 'You are Vex.' }, null), { name: 'Vex', persona: 'You are Vex.' });
});

test('applyPersona keeps a name the person typed', () => {
  assert.deepEqual(applyPersona({ name: 'Mine', persona: '' }, { name: 'Vex', persona: 'p' }, null), { name: 'Mine', persona: 'p' });
});

test('applyPersona replaces a name the AI wrote last time', () => {
  assert.deepEqual(applyPersona({ name: 'Vex', persona: 'p' }, { name: 'Nova', persona: 'q' }, 'Vex'), { name: 'Nova', persona: 'q' });
});

test('a late answer after cancel is dropped', () => {
  const run = new DraftRun();
  const first = run.start();
  run.cancel();
  assert.equal(run.current(first), false);
  const second = run.start();
  assert.equal(run.current(second), true);
  assert.equal(run.current(first), false);
});
