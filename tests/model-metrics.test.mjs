import test from 'node:test';
import assert from 'node:assert/strict';
import { ageText, borrowedNote, columns, credits, isLocalServer, metricsRequest, money, pillParts, refreshNote, rowText, tier } from '../src/modelMetrics.ts';

/** GPT-6.1 Sol as the daemon sends it, trimmed. */
const sol = {
  name: 'GPT-6.1 Sol',
  current: 'medium',
  rows: [
    { effort: 'low', state: 'measured', scores: { arc: 76.67 } },
    { effort: 'medium', state: 'measured', scores: { arc: 86.67, code: 50.23 } },
    { effort: 'high', state: 'not_measured', scores: {} },
  ],
  pills: { arc: { value: 86.67, from_level: 'medium' }, code: { value: 50.23, from_level: 'medium' } },
  best: { arc: 86.67 },
  top: { arc: { value: 95, model: 'GPT-6 Astra max' }, code: { value: 54.64, model: 'Claude Opus 5.5 medium' }, eci: { value: 168.83, model: 'Claude Opus 5.5' } },
  eci: 168.37,
  price: [2, 10],
  local_note: false,
  fetched_at: 1000,
  last_error: null,
};

test('pill tag names the borrowed level', () => {
  assert.deepEqual(pillParts('arc', { value: 60.56, from_level: 'low' }, 'medium'), { value: '61%', at: 'low', borrowed: true });
  assert.deepEqual(pillParts('arc', { value: 86.67, from_level: 'medium' }, 'medium'), { value: '87%', at: null, borrowed: false });
});

test('the Code pill always names its one tested level', () => {
  assert.deepEqual(pillParts('code', { value: 50.23, from_level: 'medium' }, 'medium'), { value: '50%', at: 'medium', borrowed: false });
  assert.deepEqual(pillParts('code', { value: 54.64, from_level: 'medium' }, 'high'), { value: '55%', at: 'medium', borrowed: true });
  assert.deepEqual(pillParts('code', undefined, 'high'), { value: 'none published', at: null, borrowed: false });
});

test('a model with no levels never tags one', () => {
  assert.deepEqual(pillParts('code', { value: 30, from_level: 'default' }, 'default'), { value: '30%', at: null, borrowed: false });
});

test('row text by state', () => {
  assert.equal(rowText('not_measured'), 'not tested at this level');
  assert.equal(rowText('measured'), '');
});

test('age text', () => {
  const now = 1_000_000;
  assert.equal(ageText(0, now), 'never downloaded');
  assert.equal(ageText(now - 120, now), 'updated just now');
  assert.equal(ageText(now - 2 * 3600 - 5, now), 'updated 2h ago');
  assert.equal(ageText(now - 86_400 - 5, now), '1 day old');
  assert.equal(ageText(now - 3 * 86_400, now), '3 days old');
});

test('credits name only the groups whose numbers this card shows', () => {
  assert.equal(credits(sol), 'ARC Prize, Cognition');
  assert.equal(credits({ ...sol, rows: [{ effort: 'default', state: 'not_measured', scores: {} }] }), '');
});

test('the DeepSWE column is always there, Cursor only with scores', () => {
  assert.deepEqual(columns(sol).map(c => c.id), ['arc', 'code', 'deepswe']);
  const opus = { ...sol, rows: [...sol.rows, { effort: 'max', state: 'measured', scores: { cursor: 57.8 } }] };
  assert.deepEqual(columns(opus).map(c => [c.id, c.label]), [['arc', 'Puzzles'], ['code', 'Code'], ['deepswe', 'DeepSWE'], ['cursor', 'Cursor']]);
  assert.deepEqual(columns({ ...sol, rows: [{ effort: 'low', state: 'measured', scores: { code: 40 } }] }).map(c => c.id), ['code', 'deepswe']);
});

test('the dot compares a score with the top score today', () => {
  assert.equal(tier('arc', 86.67, sol.top), 't3');
  assert.equal(tier('arc', 72, sol.top), 't2');
  assert.equal(tier('arc', 60.56, sol.top), 't1');
  assert.equal(tier('eci', 168.37, sol.top), 't3');
  assert.equal(tier('eci', 155.93, sol.top), 't2');
  assert.equal(tier('eci', 139.32, sol.top), 't1');
  assert.equal(tier('deepswe', 50, sol.top), null, 'no top score, no dot');
});

test('prices read as dollars in and out', () => {
  assert.equal(money([2, 10]), '$2 / $10');
  assert.equal(money([0.14, 0.42]), '$0.14 / $0.42');
});

test('the borrowed note appears only when a level-split pill borrows', () => {
  assert.equal(borrowedNote(sol), null);
  const deepgeek = { ...sol, pills: { arc: { value: 60.56, from_level: 'low' }, code: { value: 43.87, from_level: 'high' } } };
  assert.equal(borrowedNote(deepgeek), 'Some tests never ran at “medium”, so the pills borrow the nearest tested level and name it.');
  const codeOnly = { ...sol, pills: { code: { value: 54.64, from_level: 'medium' } }, current: 'high' };
  assert.equal(borrowedNote(codeOnly), null, 'the Code pill names its level anyway');
});

test('a failed refresh says why', () => {
  assert.equal(refreshNote(sol), null);
  assert.equal(refreshNote({ ...sol, last_error: 'timed out' }), 'Couldn’t refresh: timed out');
});

test('local servers are this Mac or its network', () => {
  for (const url of ['http://127.0.0.1:8765/v1', 'http://localhost:11434/v1', 'http://192.168.1.20:8000/v1', 'http://10.0.0.5/v1', 'http://172.20.1.1/v1', 'http://studio.local:8080/v1']) {
    assert.equal(isLocalServer(url), true, url);
  }
  for (const url of ['https://api.deepseek.com/', 'https://api.venice.ai/api/v1', 'http://172.32.0.1/v1', 'not a url']) {
    assert.equal(isLocalServer(url), false, url);
  }
});

test('the card asks by model, offered levels and the level the bot runs at', () => {
  const bot = (backend, effort = null) => ({ id: 'b', display_name: 'B', backend, effort });
  const levels = ['low', 'medium', 'high'];
  assert.deepEqual(metricsRequest(bot({ kind: 'agent', tool: 'claude_code', model: 'claude-opus-5-5' }, 'high'), levels, 'medium'),
    { model: 'claude-opus-5-5', efforts: levels, current: 'high', local: false });
  assert.equal(metricsRequest(bot({ kind: 'agent', tool: 'claude_code', model: 'claude-opus-5-5' }), levels, 'medium').current, 'medium', 'an unset level is the default one');
  assert.deepEqual(metricsRequest(bot({ kind: 'open_ai_compatible', base_url: 'http://127.0.0.1:8765/v1', model: '/models/Qwen3.5-9B-MLX-4bit', api_key_env: null }), [], null),
    { model: '/models/Qwen3.5-9B-MLX-4bit', efforts: [], current: null, local: true });
  assert.equal(metricsRequest(bot({ kind: 'open_ai_compatible', base_url: 'https://api.deepseek.com/', model: 'deepseek-flash', api_key_env: 'K' }), levels, 'high').local, false);
  assert.equal(metricsRequest(bot({ kind: 'agent', tool: 'codex', model: null }), levels, 'medium'), null, 'no model picked, nothing to look up');
  assert.equal(metricsRequest(bot({ kind: 'cli', program: 'x', args: [] }), [], null), null);
});
