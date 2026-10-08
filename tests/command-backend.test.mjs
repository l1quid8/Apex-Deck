import test from 'node:test';
import assert from 'node:assert/strict';
import { commandBackend } from '../src/commandBackend.ts';

/** A transport that writes down what it's asked. */
function recording() {
  const calls = []; const listens = []; const saved = []; const read = [];
  return {
    calls, listens, saved, read,
    call: async (cmd, args) => { calls.push({ cmd, args }); return `reply to ${cmd}`; },
    listen: async (event, cb) => { listens.push({ event, cb }); return () => {}; },
    saveAttachment: async (room, name, bytes) => { saved.push({ room, name, bytes }); return '/a/b.png'; },
    readAttachment: async (path) => { read.push(path); return new ArrayBuffer(2); },
  };
}

const SHELL_KEYS = ['pickFolder', 'pickPath', 'startupFolders', 'artifactSave', 'artifactOpenExternal', 'exportThread', 'exportPdf', 'openTarget',
  'copyAttachment', 'flagAttention', 'requestCriticalAttention', 'onFileDrop', 'onQuitRequested', 'quitHeard', 'quitApp'];

function stubShell() {
  const shell = { quitStopsWork: true };
  for (const key of SHELL_KEYS) shell[key] = async (...args) => `shell ${key} ${JSON.stringify(args)}`;
  return shell;
}

const options = { policy: 'mention', max_bot_hops: 3 };
const participant = { id: 'p', display_name: 'P', backend: { kind: 'scripted', lines: [] } };
const rule = { kind: 'command', command: 'ls' };

// Every command-backed method: how it's called, and the exact command and
// arguments the host expects for it.
const COMMANDS = [
  ['roomState', ['r'], 'room_state', { id: 'r' }],
  ['listToolServers', ['r', 'a'], 'list_tool_servers', { room: 'r', agent: 'a' }],
  ['detectAgents', [], 'agents_detect', undefined],
  ['sessionLoad', [], 'session_load', undefined],
  ['sessionSave', [{ version: 1 }], 'session_save', { session: { version: 1 } }],
  ['settingsLoad', [], 'settings_load', undefined],
  ['decisionKeyStatus', [], 'decision_key_status', {}],
  ['decisionKeySave', ['jev', 'fake-key'], 'decision_key_save', { provider: 'jev', key: 'fake-key' }],
  ['settingsSave', [{ a: 1 }], 'settings_save', { settings: { a: 1 } }],
  ['artifactsLoad', ['r'], 'artifacts_load', { room: 'r' }],
  ['artifactsSave', ['r', [1]], 'artifacts_save', { room: 'r', artifacts: [1] }],
  ['dataFolder', [], 'data_folder', undefined],
  ['envPresent', [['A']], 'env_present', { names: ['A'] }],
  ['previewProbe', ['localhost:5173'], 'preview_probe', { address: 'localhost:5173' }],
  ['ptySpawn', [{ id: 'p1', cols: 80, rows: 24 }], 'pty_spawn', { id: 'p1', agent: null, cwd: null, cols: 80, rows: 24 }],
  ['ptySpawn', [{ id: 'p1', agent: 'codex', cwd: '/w', cols: 80, rows: 24 }], 'pty_spawn', { id: 'p1', agent: 'codex', cwd: '/w', cols: 80, rows: 24 }],
  ['ptyWrite', ['p1', 'ls\n'], 'pty_write', { id: 'p1', data: 'ls\n' }],
  ['ptyResize', ['p1', 100, 30], 'pty_resize', { id: 'p1', cols: 100, rows: 30 }],
  ['ptyKill', ['p1'], 'pty_kill', { id: 'p1' }],
  ['roomCreate', ['t', [participant], options, ''], 'room_create', { id: 't', participants: [participant], options, cwd: null }],
  ['roomCreate', ['t', [], options, '/w'], 'room_create', { id: 't', participants: [], options, cwd: '/w' }],
  ['apiModels', ['http://x', null], 'api_models', { baseUrl: 'http://x', apiKeyEnv: null }],
  ['agentModels', ['codex'], 'agent_models', { tool: 'codex' }],
  ['workspaceRead', ['a.txt', '/w'], 'workspace_read', { target: 'a.txt', cwd: '/w' }],
  ['pathsExist', [['a'], null], 'paths_exist', { targets: ['a'], cwd: null }],
  ['listFolder', ['/srv'], 'folder_list', { path: '/srv' }],
  ['listFolder', [null], 'folder_list', { path: null }],
  ['roomPost', ['t', 'hi'], 'room_post', { id: 't', text: 'hi' }],
  ['roomTargets', ['t', 'hi'], 'room_targets', { id: 't', text: 'hi' }],
  ['roomPostTo', ['t', 'hi', ['p']], 'room_post_to', { id: 't', text: 'hi', targets: ['p'], routed: false }],
  ['roomTurn', ['t', ['p'], null], 'room_turn', { id: 't', participants: ['p'], hops: null }],
  ['roomStop', ['t', undefined], 'room_stop', { id: 't', participant: null }],
  ['roomStop', ['t', 'p'], 'room_stop', { id: 't', participant: 'p' }],
  ['roomDecide', ['t', 'r-1', true], 'room_decide', { id: 't', request: 'r-1', approve: true, always: false }],
  ['roomDecide', ['t', 'r-1', false, true], 'room_decide', { id: 't', request: 'r-1', approve: false, always: true }],
  ['roomAnswer', ['t', 'ask-1', [['blue'], ['apple', 'pear']]], 'room_answer', { id: 't', request: 'ask-1', answers: [['blue'], ['apple', 'pear']] }],
  ['roomAnswer', ['t', 'ask-2', null], 'room_answer', { id: 't', request: 'ask-2', answers: null }],
  ['roomSetPlan', ['t', true], 'room_set_plan', { id: 't', on: true }],
  ['roomSetOptions', ['t', options], 'room_set_options', { id: 't', options }],
  ['roomForgetAllowed', ['t', rule], 'room_forget_allowed', { id: 't', rule }],
  ['roomAddParticipant', ['t', participant], 'room_add_participant', { id: 't', participant }],
  ['roomUpdateParticipant', ['t', participant], 'room_update_participant', { id: 't', participant }],
  ['roomRemoveParticipant', ['t', 'p'], 'room_remove_participant', { id: 't', participant: 'p' }],
  ['roomClear', ['t'], 'room_clear', { id: 't' }],
  ['roomRewind', ['t', 3], 'room_rewind', { id: 't', upto: 3 }],
  ['roomRevertPlan', ['t', 2, null], 'room_revert_plan', { id: 't', at: 2, bot: null }],
  ['roomRevert', ['t', 2, 'p', true, ['a']], 'room_revert', { id: 't', at: 2, bot: 'p', chat: true, files: ['a'] }],
  ['roomDiff', ['t'], 'room_diff', { id: 't' }],
  ['generateImage', ['t', 'grok', 'a cat'], 'generate_image', { room: 't', provider: 'grok', prompt: 'a cat' }],
  ['importReplyImage', ['t', '/x.png'], 'import_reply_image', { room: 't', path: '/x.png' }],
  ['roomPin', ['t', 'fact'], 'room_pin', { id: 't', fact: 'fact' }],
  ['roomUnpin', ['t', 0], 'room_unpin', { id: 't', index: 0 }],
  ['roomFork', ['t', 'u', null], 'room_fork', { source: 't', target: 'u', upto: null }],
  ['roomImport', ['f', { transcript: [] }, '/srv/x'], 'room_import', { id: 'f', snapshot: { transcript: [] }, cwd: '/srv/x', replace: false }],
  ['roomImport', ['f', { transcript: [] }, '', true], 'room_import', { id: 'f', snapshot: { transcript: [] }, cwd: null, replace: true }],
  ['roomCompact', ['t'], 'room_compact', { id: 't' }],
  ['roomClose', ['t'], 'room_close', { id: 't' }],
  ['roomDelete', ['t'], 'room_delete', { id: 't' }],
];

for (const [method, args, cmd, expected] of COMMANDS) {
  test(`${method}(${JSON.stringify(args).slice(1, -1)}) sends ${cmd}`, async () => {
    const transport = recording();
    const backend = commandBackend(transport, stubShell());
    assert.equal(await backend[method](...args), `reply to ${cmd}`);
    assert.deepEqual(transport.calls, [{ cmd, args: expected }]);
  });
}

test('events come from the transport with the arguments the UI expects', async () => {
  const transport = recording();
  const backend = commandBackend(transport, stubShell());
  const heard = [];
  await backend.onPtyData((id, data) => heard.push(['data', id, data]));
  await backend.onPtyExit((id, code) => heard.push(['exit', id, code]));
  await backend.onRoomEvent((room, event) => heard.push(['room', room, event]));
  assert.deepEqual(transport.listens.map(l => l.event), ['pty-data', 'pty-exit', 'room-event']);
  transport.listens[0].cb({ id: 'p1', data: 'x' });
  transport.listens[1].cb({ id: 'p1', code: 0 });
  transport.listens[2].cb({ room: 't', event: { type: 'turn_started', id: 'p' } });
  assert.deepEqual(heard, [['data', 'p1', 'x'], ['exit', 'p1', 0], ['room', 't', { type: 'turn_started', id: 'p' }]]);
});

test('attachments go to the transport\'s own methods', async () => {
  const transport = recording();
  const backend = commandBackend(transport, stubShell());
  const bytes = new Uint8Array([1, 2]);
  assert.equal(await backend.saveAttachment('t', 'a.png', bytes), '/a/b.png');
  assert.equal((await backend.readAttachment('/a/b.png')).byteLength, 2);
  assert.deepEqual(transport.saved, [{ room: 't', name: 'a.png', bytes }]);
  assert.deepEqual(transport.read, ['/a/b.png']);
  assert.deepEqual(transport.calls, []);
});

test('shell methods pass through untouched', async () => {
  const shell = stubShell(); shell.quitStopsWork = false;
  const backend = commandBackend(recording(), shell);
  for (const key of SHELL_KEYS) assert.equal(backend[key], shell[key], key);
  assert.equal(backend.quitStopsWork, false);
  assert.equal(backend.demo, false);
});

test('call reaches the transport as it is, for mods', async () => {
  const transport = recording();
  const backend = commandBackend(transport, stubShell());
  assert.equal(await backend.call('mod_env_get', { name: 'HOME' }), 'reply to mod_env_get');
  assert.deepEqual(transport.calls, [{ cmd: 'mod_env_get', args: { name: 'HOME' } }]);
});

test('every method is accounted for in this file', () => {
  const backend = commandBackend(recording(), stubShell());
  const known = new Set([...COMMANDS.map(c => c[0]), ...SHELL_KEYS, 'onPtyData', 'onPtyExit', 'onRoomEvent',
    'saveAttachment', 'readAttachment', 'call', 'demo', 'quitStopsWork']);
  assert.deepEqual(Object.keys(backend).filter(k => !known.has(k)), []);
});
