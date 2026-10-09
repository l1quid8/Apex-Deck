import test from 'node:test';
import assert from 'node:assert/strict';
import { compatibleMonitorProfiles, defaultMonitorProfileId, parseProjectFiles } from '../src/apexAgentModel.ts';

test('ApexAgent offers text API and Claude Code profiles, not Codex, Grok, Gemini or plain CLIs', () => {
  const profiles = [
    { id: 'api', display_name: 'API', backend: { kind: 'open_ai_compatible', base_url: 'https://api.example', model: 'model', api_key_env: null }, media: null },
    { id: 'cli', display_name: 'CLI', backend: { kind: 'cli', program: 'tool', args: [] } },
    { id: 'claude', display_name: 'Claude', backend: { kind: 'agent', tool: 'claude_code', model: null } },
    { id: 'agent', display_name: 'Agent', backend: { kind: 'agent', tool: 'codex', model: null } },
    { id: 'grok', display_name: 'Grok', backend: { kind: 'agent', tool: 'grok', model: null } },
    { id: 'gemini', display_name: 'Gemini', backend: { kind: 'agent', tool: 'gemini', model: null } },
    { id: 'video', display_name: 'Video API', backend: { kind: 'open_ai_compatible', base_url: 'https://api.example', model: 'video', api_key_env: null }, media: { duration: '5s' } },
  ];
  assert.deepEqual(compatibleMonitorProfiles(profiles).map(p => p.id), ['api', 'claude']);
});

test('ApexAgent prefers its saved compatible profile and otherwise uses the first compatible text profile', () => {
  const profiles = [
    { id: 'cli', backend: { kind: 'cli' } },
    { id: 'api', backend: { kind: 'open_ai_compatible' }, media: null },
    { id: 'video', backend: { kind: 'open_ai_compatible' }, media: { duration: '5s' } },
    { id: 'api-2', backend: { kind: 'open_ai_compatible' }, media: null },
  ];
  assert.equal(defaultMonitorProfileId(profiles, 'api-2'), 'api-2');
  assert.equal(defaultMonitorProfileId(profiles, 'video'), 'api');
  assert.equal(defaultMonitorProfileId(profiles, null), 'api');
});

test('ApexAgent source file paths are explicit, relative, de-duplicated, and safe', () => {
  assert.deepEqual(parseProjectFiles('src/App.tsx\n README.md \nsrc/App.tsx\n../secrets\n/etc/passwd\n'), ['src/App.tsx', 'README.md']);
});

test('remote ApexAgent mutations are rejected while the owning host is offline', async () => {
  const { guardHostWrites } = await import('../src/hostBackends.ts');
  const { hostConnectionStore } = await import('../src/hostConnections.ts');
  const connection = hostConnectionStore('project-host', 'Project Host');
  let calls = 0;
  const guarded = guardHostWrites({ call: async () => { calls++; return null; } }, connection);
  await assert.rejects(guarded.call('monitor_message', { workspaceId: 'project' }), /Not connected/);
  assert.equal(calls, 0);
  connection.setStatus({ kind: 'connected', hostId: 'daemon' });
  await guarded.call('monitor_get', { workspaceId: 'project' });
  assert.equal(calls, 1);
});
