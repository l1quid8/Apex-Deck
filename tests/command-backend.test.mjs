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

test('backend capability checks follow the current host without sending probe commands', () => {
  const transport = recording();
  const advertised = new Set();
  transport.supports = capability => advertised.has(capability);
  const backend = commandBackend(transport, stubShell());
  assert.equal(backend.supports('assistant_workspace_v4'), false);
  advertised.add('assistant_workspace_v4');
  assert.equal(backend.supports('assistant_workspace_v4'), true);
  advertised.clear();
  assert.equal(backend.supports('assistant_workspace_v4'), false);
  assert.deepEqual(transport.calls, []);
  assert.equal(commandBackend(recording(), stubShell()).supports('assistant_workspace_v4'), false);
});

const options = { policy: 'mention', max_bot_hops: 3 };
const participant = { id: 'p', display_name: 'P', backend: { kind: 'scripted', lines: [] } };
const rule = { kind: 'command', command: 'ls' };

// Every command-backed method: how it's called, and the exact command and
// arguments the host expects for it.
const COMMANDS = [
  ['voiceCapabilities', [], 'voice_capabilities', {}],
  ['roomStopRequest', ['r','p','v1'], 'room_stop_request', {id:'r',participant:'p',client_turn_id:'v1'}],
  ['roomPostTo', ['r','hello',['p'],false,{client_turn_id:'v1',max_bot_hops:0}], 'room_post_to', {id:'r',text:'hello',targets:['p'],interactive_answers:false,client_turn_id:'v1',max_bot_hops:0}],
  ['roomState', ['r'], 'room_state', { id: 'r' }],
  ['listToolServers', ['r', 'a'], 'list_tool_servers', { room: 'r', agent: 'a' }],
  ['detectAgents', [], 'agents_detect', undefined],
  ['sessionLoad', [], 'session_load', undefined],
  ['sessionSave', [{ version: 1 }], 'session_save', { session: { version: 1 } }],
  ['settingsLoad', [], 'settings_load', undefined],
  ['settingsSave', [{ a: 1 }], 'settings_save', { settings: { a: 1 } }],
  ['artifactsLoad', ['r'], 'artifacts_load', { room: 'r' }],
  ['artifactsSave', ['r', [1]], 'artifacts_save', { room: 'r', artifacts: [1] }],
  ['answersLoad', ['r'], 'answers_load', { room: 'r' }],
  ['roomSteps', ['r', 7], 'room_steps', { room: 'r', seq: 7 }],
  ['answerSave', ['r', '1:c', '0a1b2c3d', { budget: 1 }, 0], 'answer_save', { room: 'r', key: '1:c', fingerprint: '0a1b2c3d', inputs: { budget: 1 }, revision: 0 }],
  ['dataFolder', [], 'data_folder', undefined],
  ['envPresent', [['A']], 'env_present', { names: ['A'] }],
  ['apiKeyStatus', [['A']], 'api_key_status', { names: ['A'] }],
  ['apiKeySave', ['A', 'k'], 'api_key_save', { name: 'A', key: 'k' }],
  ['apiKeyRemove', ['A'], 'api_key_remove', { name: 'A' }],
  ['previewProbe', ['localhost:5173'], 'preview_probe', { address: 'localhost:5173' }],
  ['ptySpawn', [{ id: 'p1', cols: 80, rows: 24 }], 'pty_spawn', { id: 'p1', agent: null, cwd: null, name: null, cols: 80, rows: 24 }],
  ['ptySpawn', [{ id: 'p1', agent: 'codex', cwd: '/w', name: 'dev server', cols: 80, rows: 24 }], 'pty_spawn', { id: 'p1', agent: 'codex', cwd: '/w', name: 'dev server', cols: 80, rows: 24 }],
  ['ptyList', [], 'pty_list', { query: null }],
  ['ptyList', ['ok'], 'pty_list', { query: 'ok' }],
  ['ptyRename', ['p1', 'tests'], 'pty_rename', { id: 'p1', name: 'tests' }],
  ['ptyAttach', ['p1'], 'pty_attach', { id: 'p1' }],
  ['ptyWrite', ['p1', 'ls\n'], 'pty_write', { id: 'p1', data: 'ls\n' }],
  ['ptyResize', ['p1', 100, 30], 'pty_resize', { id: 'p1', cols: 100, rows: 30 }],
  ['ptyKill', ['p1'], 'pty_kill', { id: 'p1' }],
  ['roomCreate', ['t', [participant], options, ''], 'room_create', { id: 't', participants: [participant], options, cwd: null }],
  ['roomCreate', ['t', [], options, '/w'], 'room_create', { id: 't', participants: [], options, cwd: '/w' }],
  ['agentModels', ['codex'], 'agent_models', { tool: 'codex' }],
  ['personaDraft', [participant, 'a reviewer', ['Ada']], 'persona_draft', { writer: participant, idea: 'a reviewer', taken: ['Ada'] }],
  ['workspaceRead', ['a.txt', '/w'], 'workspace_read', { target: 'a.txt', cwd: '/w' }],
  ['pathsExist', [['a'], null], 'paths_exist', { targets: ['a'], cwd: null }],
  ['listFolder', ['/srv'], 'folder_list', { path: '/srv' }],
  ['listFolder', [null], 'folder_list', { path: null }],
  ['fileRead', ['/srv/app', '/srv/app/README.md'], 'file_read', { root: '/srv/app', path: '/srv/app/README.md' }],
  ['fileFind', ['/srv/app', 'readme'], 'file_find', { root: '/srv/app', query: 'readme' }],
  ['fileSearch', ['/srv/app', 'TODO', false, '/srv/app/src'], 'file_search', { root: '/srv/app', query: 'TODO', case_sensitive: false, folder: '/srv/app/src' }],
  ['fileCreate', ['/srv/app', '/srv/app', 'new.txt', false], 'file_create', { root: '/srv/app', parent: '/srv/app', name: 'new.txt', folder: false }],
  ['fileRename', ['/srv/app', '/srv/app/old.txt', 'new.txt'], 'file_rename', { root: '/srv/app', path: '/srv/app/old.txt', name: 'new.txt' }],
  ['fileDuplicate', ['/srv/app', '/srv/app/a.txt'], 'file_duplicate', { root: '/srv/app', path: '/srv/app/a.txt' }],
  ['fileTrash', ['/srv/app', '/srv/app/a.txt'], 'file_trash', { root: '/srv/app', path: '/srv/app/a.txt' }],
  ['fileWrite', ['/srv/app', '/srv/app/a.txt', 'hi', 'v1'], 'file_write', { root: '/srv/app', path: '/srv/app/a.txt', text: 'hi', expected: 'v1' }],
  ['botCopiesSetCheck', ['/repo', 'cargo check'], 'bot_copies_set_check', { root: '/repo', cmd: 'cargo check' }],
  ['botCopiesSetCheck', ['/repo', null], 'bot_copies_set_check', { root: '/repo', cmd: null }],
  ['worktreeList', ['/repo'], 'worktree_list', { path: '/repo' }],
  ['worktreeAdd', ['/repo', { branch: 'feature/x', newBranch: true, base: 'main', folder: '/repo-wt' }], 'worktree_add', { path: '/repo', branch: 'feature/x', newBranch: true, base: 'main', folder: '/repo-wt' }],
  ['worktreeRemove', ['/repo', '/repo-wt', true], 'worktree_remove', { path: '/repo', worktree: '/repo-wt', force: true }],
  ['worktreeForget', ['/repo', '/repo-wt', true], 'worktree_forget', { path: '/repo', worktree: '/repo-wt', force: true }],
  ['worktreePrune', ['/repo'], 'worktree_prune', { path: '/repo' }],
  ['roomPost', ['t', 'hi'], 'room_post', { id: 't', text: 'hi' }],
  ['roomPost', ['t', 'hi', true], 'room_post', { id: 't', text: 'hi', interactive_answers: true }],
  ['roomTargets', ['t', 'hi'], 'room_targets', { id: 't', text: 'hi' }],
  ['roomPostTo', ['t', 'hi', ['p']], 'room_post_to', { id: 't', text: 'hi', targets: ['p'] }],
  ['roomPostTo', ['t', 'hi', ['p'], true], 'room_post_to', { id: 't', text: 'hi', targets: ['p'], interactive_answers: true }],
  ['roomTurn', ['t', ['p'], null], 'room_turn', { id: 't', participants: ['p'], hops: null }],
  ['roomTurn', ['t', ['p'], null, false], 'room_turn', { id: 't', participants: ['p'], hops: null, interactive_answers: false }],
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
  ['importReplyImage', ['t', '/x.png', 'Null'], 'import_reply_image', { room: 't', path: '/x.png', by: 'Null' }],
  ['libraryList', [], 'library_list', {}],
  ['libraryRemove', ['a.png'], 'library_remove', { file: 'a.png' }],
  ['libraryRename', ['a.png', 'New name'], 'library_rename', { file: 'a.png', name: 'New name' }],
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
  await backend.onPtyData((id, data, cursor) => heard.push(['data', id, data, cursor]));
  await backend.onPtyExit((id, code) => heard.push(['exit', id, code]));
  await backend.onPtyRenamed((id, name) => heard.push(['renamed', id, name]));
  await backend.onRoomEvent((room, event) => heard.push(['room', room, event]));
  await backend.onAssistantTasksChanged((snapshot) => heard.push(['tasks', snapshot]));
  assert.deepEqual(transport.listens.map(l => l.event), ['pty-data', 'pty-exit', 'pty-renamed', 'room-event', 'assistant-tasks-changed']);
  transport.listens[0].cb({ id: 'p1', data: 'x', cursor: 2 });
  transport.listens[1].cb({ id: 'p1', code: 0 });
  transport.listens[2].cb({ id: 'p1', name: 'tests' });
  transport.listens[3].cb({ room: 't', event: { type: 'turn_started', id: 'p' } });
  transport.listens[4].cb({ workspaceId: 'w', revision: 12 });
  assert.deepEqual(heard, [['data', 'p1', 'x', 2], ['exit', 'p1', 0], ['renamed', 'p1', 'tests'], ['room', 't', { type: 'turn_started', id: 'p' }], ['tasks', { workspaceId: 'w', revision: 12 }]]);
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

test('apiModels normalizes old string and new object replies', async () => {
  const transport = recording();
  transport.call = async (cmd, args) => { transport.calls.push({ cmd, args }); return ['llama3', { id: 'glm', context_tokens: 1000000 }, { nope: 1 }]; };
  const backend = commandBackend(transport, stubShell());
  assert.deepEqual(await backend.apiModels('http://x', null), [{ id: 'llama3' }, { id: 'glm', context_tokens: 1000000 }]);
  assert.deepEqual(transport.calls, [{ cmd: 'api_models', args: { baseUrl: 'http://x', apiKeyEnv: null } }]);
});

test('apiBalance returns a finite number or null', async () => {
  for (const [reply, want] of [[12.5, 12.5], [null, null], ['x', null], [Infinity, null]]) {
    const transport = recording();
    transport.call = async () => reply;
    assert.equal(await commandBackend(transport, stubShell()).apiBalance('http://x', 'KEY'), want);
  }
});

test('a bot\'s models and balance are asked for by thread and bot, never by address', async () => {
  const transport = recording();
  transport.call = async (cmd, args) => { transport.calls.push({ cmd, args }); return cmd === 'room_bot_models' ? ['deepseek-flash', { nope: 1 }] : 9.87; };
  const backend = commandBackend(transport, stubShell());
  assert.deepEqual(await backend.roomBotModels('r', 'deep'), [{ id: 'deepseek-flash' }]);
  assert.equal(await backend.roomBotBalance('r', 'deep'), 9.87);
  assert.deepEqual(transport.calls, [
    { cmd: 'room_bot_models', args: { room: 'r', participant: 'deep' } },
    { cmd: 'room_bot_balance', args: { room: 'r', participant: 'deep' } },
  ]);
  assert.equal(await commandBackend({ ...transport, call: async () => 'x' }, stubShell()).roomBotBalance('r', 'deep'), null);
});

test('a usage reset is asked for by thread and provider', async () => {
  const transport = recording();
  transport.call = async (cmd, args) => { transport.calls.push({ cmd, args }); return 'reset'; };
  const backend = commandBackend(transport, stubShell());
  assert.equal(await backend.roomPlanReset('r', 'codex', 'c1', 'k1'), 'reset');
  await backend.roomPlanReset('r', 'codex', null, 'k2');
  assert.deepEqual(transport.calls, [
    { cmd: 'room_plan_reset', args: { room: 'r', tool: 'codex', credit: 'c1', key: 'k1' } },
    { cmd: 'room_plan_reset', args: { room: 'r', tool: 'codex', credit: null, key: 'k2' } },
  ]);
});

test('phone methods send the phone commands', async () => {
  const transport = recording();
  const { phone } = commandBackend(transport, stubShell());
  await phone.status(); await phone.start(); await phone.stop(); await phone.view(4);
  await phone.input({ kind: 'tap', x: 1, y: 2 }); await phone.giveBack(); await phone.chatQueued('r');
  assert.deepEqual(transport.calls, [
    { cmd: 'phone_status', args: undefined }, { cmd: 'phone_start', args: undefined }, { cmd: 'phone_stop', args: undefined },
    { cmd: 'phone_view', args: { since: 4 } }, { cmd: 'phone_human', args: { input: { kind: 'tap', x: 1, y: 2 } } },
    { cmd: 'phone_give_back', args: undefined }, { cmd: 'phone_chat_queued', args: { room: 'r' } },
  ]);
});

test('every method is accounted for in this file', () => {
  const backend = commandBackend(recording(), stubShell());
  const known = new Set([...COMMANDS.map(c => c[0]), ...SHELL_KEYS, 'onPtyData', 'onPtyExit', 'onRoomEvent', 'onSessionChanged', 'onAssistantTasksChanged',
    'saveAttachment', 'readAttachment', 'call', 'demo', 'supports', 'quitStopsWork', 'apiModels', 'apiBalance', 'apiQuote', 'roomBotModels', 'roomBotBalance', 'roomPlanReset', 'ptyList', 'ptyAttach', 'ptyRename', 'onPtyRenamed', 'phone']);
  assert.deepEqual(Object.keys(backend).filter(k => !known.has(k)), []);
});

test('simulator catalog, controls and gesture geometry use the shared phone API', async () => {
  const transport = recording();
  const { phone } = commandBackend(transport, stubShell());
  const geometry = { generation: 2, display: 3, orientation: 1, width: 1000, height: 600 };
  await phone.devices();
  await phone.control({ kind: 'fold', folded: true });
  await phone.input({ kind: 'tap', x: 1, y: 2 }, geometry);
  assert.deepEqual(transport.calls, [
    { cmd: 'phone_devices', args: undefined },
    { cmd: 'phone_control', args: { control: { kind: 'fold', folded: true } } },
    { cmd: 'phone_human', args: { input: { kind: 'tap', x: 1, y: 2 }, geometry } },
  ]);
});
