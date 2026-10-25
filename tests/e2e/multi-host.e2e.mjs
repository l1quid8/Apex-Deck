import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DaemonClient } from '../../src/daemon/client.ts';
import { daemonTransport } from '../../src/electronShell.ts';
import { commandBackend } from '../../src/commandBackend.ts';
import { createHostBackends } from '../../src/hostBackends.ts';
import { createEventHub } from '../../src/eventHub.ts';
import { socketLink } from './link.mjs';
import { FolderMoveUnsupported, MoveRefused, placeThread } from '../../src/threadMove.ts';
import { createHash } from 'node:crypto';
import { workspaceFixture, eventually, readAssistant, ref, configure, assertOfflinePixelFallback } from './workspace-fixture.mjs';
import { createAvatarEditor, reduceAvatarEditor } from '../../src/assistantAvatar.ts';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await check()) return; await pause(20); }
  throw new Error('timed out');
}
async function daemon(t) {
  const data = fs.mkdtempSync('/tmp/adm-');
  const binary = process.env.APEX_DAEMON_BIN ?? path.resolve('target/debug/apex-daemon');
  const child = spawn(binary, ['serve', '--exit-on-stdin-close', '--data-dir', data],
    { stdio: ['pipe', 'ignore', 'pipe'] });
  let exit = null; let error = ''; let spawnError = ''; let link; let client;
  child.once('error', e => { spawnError = e.message; });
  child.once('exit', code => { exit = code; });
  child.stderr.on('data', bytes => { error += bytes; });
  t.after(async () => {
    client?.close();
    if (exit === null && !spawnError) {
      const stopped = new Promise(resolve => child.once('exit', resolve));
      child.stdin.end();
      const finished = await Promise.race([stopped.then(() => true), pause(5000).then(() => false)]);
      if (!finished) { child.kill('SIGKILL'); await Promise.race([stopped, pause(1000)]); }
    }
    // Checkpoint git runs started by the daemon can still be finishing in its data folder.
    fs.rmSync(data, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  await until(() => {
    if (spawnError || exit !== null) throw new Error(spawnError || error || 'daemon exited');
    return fs.existsSync(path.join(data, 'daemon.json'));
  });
  let status = { kind: 'connecting' };
  const listeners = new Set();
  client = new DaemonClient(async () =>
    (link = await socketLink(path.join(data, 'daemon.sock'))), { delay: () => 60000 });
  client.onStatus(next => { status = next; listeners.forEach(cb => cb()); });
  const connection = {
    get: () => ({ status }),
    subscribe: cb => { listeners.add(cb); return () => listeners.delete(cb); },
    retryNow: () => client.retryNow(),
  };
  const welcome = await client.start();
  const backend = commandBackend(daemonTransport(client), { quitStopsWork: false });
  return { data, welcome, client, backend, connection, breakLink: () => link.socket.destroy() };
}
const options = { policy: 'mention', max_bot_hops: 0 };
const bot = label => ({
  id: 'bot', display_name: label,
  backend: { kind: 'cli', program: 'sh', args: ['-c', 'echo ' + label] },
});

test('same local assistant IDs retain independent runtime, applied generated avatars and spend receipts across host restart', { timeout: 60_000 }, async t => {
  const f = await workspaceFixture(t, 'adw-avatars');
  const hosts = [await f.host('alpha'), await f.host('beta')];
  assert.notEqual(hosts[0].hostId, hosts[1].hostId);
  const saved = [];
  for (const [index, host] of hosts.entries()) {
    await host.client.call('session_save', { session: { version: 1, profiles: [f.profile] } });
    const creation = { kind: 'creation', hostId: host.hostId, draftId: `draft-${index}` };
    const create = { name: index ? 'Beta' : 'Alpha', folder: path.join(f.root, `assistant-${index}`), profile: f.profile, workspaceVersion: 4, look: { seed: `seed-${index}`, color: index ? '#3355aa' : '#aa5533', shape: 'pixel' } };
    let assistant;
    let owner;
    if (index) {
      assistant = await host.client.call('personal_create', create);
      owner = { kind: 'assistant', assistant: ref(assistant) };
    } else owner = creation;
    const offered = await host.client.call('personal_avatar_options', { owner });
    assert.deepEqual(offered.options.map(({ providerProfileId, modelId, estimatedCostMicros }) => ({ providerProfileId, modelId, estimatedCostMicros })), [{ providerProfileId: 'fixture-avatar-provider', modelId: 'fixture-avatar-image', estimatedCostMicros: 40_000 }]);
    const input = { owner, generationId: 'same-generation', editorToken: 'same-editor', providerProfileId: 'fixture-avatar-provider', modelId: 'fixture-avatar-image', prompt: 'A geometric compass' };
    let editor = reduceAvatarEditor(createAvatarEditor(owner, input.editorToken), { type: 'generate', generationId: input.generationId, editorToken: input.editorToken });
    const pending = await host.client.call('personal_avatar_generate', input);
    assert.equal(pending.state, 'pending');
    const preview = await eventually('real normalized avatar preview', async () => {
      const job = await host.client.call('personal_avatar_status', { owner, generationId: input.generationId });
      if (job.state === 'error') throw new Error(job.error);
      return job.state === 'preview' ? job : null;
    });
    assert.deepEqual((await host.client.call('personal_avatar_generate', input)).candidate, preview.candidate, 'same generation reconciles without another paid dispatch');
    editor = reduceAvatarEditor(editor, { type: 'result', job: preview });
    assert.equal(editor.selection, undefined, 'preview is not Apply');
    if (assistant) assert.notEqual((await readAssistant(host)).look.kind, 'image', 'Generate cannot apply an avatar');
    else assert.deepEqual(await host.client.call('personal_list', {}), [], 'creation preview cannot create an assistant');
    editor = reduceAvatarEditor(editor, { type: 'apply' });
    if (!index) assistant = await host.client.call('personal_create', { ...create, avatarDraftId: creation.draftId, avatarGenerationId: editor.selection.generationId, avatarAssetId: editor.selection.assetId });
    else assistant = await configure(host, assistant.id, { avatar: editor.selection });
    assert.equal(assistant.id, 'asst-1');
    assistant = await configure(host, assistant.id, { settings: { name: `${create.name} saved` }, profile: { ...f.profile, id: `owned-${index}`, display_name: `Owned ${index}`, access: 'full', effort: null } });
    assert.equal(assistant.profile.access, 'full'); assert.equal(assistant.profile.backend.model, 'fixture-text'); assert.equal(assistant.profile.effort ?? null, null);
    assert.equal(assistant.look.kind, 'image'); assert.equal(assistant.look.seed, create.look.seed); assert.equal(assistant.look.color, create.look.color);
    const images = assistant.costs.filter(cost => cost.kind === 'image');
    assert.equal(images.length, 1); assert.equal(images[0].micros, 40_000);
    assert.deepEqual((await host.client.call('session_load', {})).profiles, [f.profile], 'assistant-owned settings never edit source Agents profiles');
    saved.push({ assistant, input, preview, editor, owner });
  }
  assert.notEqual(saved[0].assistant.look.image.sha256, saved[1].assistant.look.image.sha256);
  const wrongHost = { kind: 'assistant', assistant: ref(saved[0].assistant) };
  await assert.rejects(hosts[1].client.call('personal_avatar_status', { owner: wrongHost, generationId: 'same-generation' }), /host|owner/i);
  await assert.rejects(hosts[1].client.call('personal_avatar_asset', { assistantId: 'asst-1', assetId: saved[0].assistant.look.image.assetId, sha256: saved[0].assistant.look.image.sha256 }), /asset|owner|applied/i);
  for (const [index, host] of hosts.entries()) {
    const before = saved[index].assistant;
    await host.stop(); await host.start();
    assert.equal(host.hostId, before.hostId);
    const second = await host.connect();
    const restored = await second.call('personal_get', { assistantId: before.id });
    assert.deepEqual(restored.look, before.look); assert.deepEqual(restored.profile, before.profile);
    const { assetId, sha256 } = restored.look.image;
    const asset = await second.call('personal_avatar_asset', { assistantId: restored.id, assetId, sha256 });
    const bytes = Buffer.from(asset.base64, 'base64');
    assert.equal(createHash('sha256').update(bytes).digest('hex'), sha256);
    assert.equal(bytes.readUInt32BE(16), 512); assert.equal(bytes.readUInt32BE(20), 512);
    assert.equal(restored.costs.filter(cost => cost.kind === 'image').length, 1, 'restart does not regenerate or rebill');
  }
  const host = hosts[1], before = await readAssistant(host), owner = { kind: 'assistant', assistant: ref(before) };
  const cancelInput = { ...saved[1].input, owner, generationId: 'cancelled', editorToken: 'cancelled' };
  await host.client.call('personal_avatar_generate', cancelInput);
  await host.client.call('personal_avatar_cancel', { owner, generationId: cancelInput.generationId });
  const cancelled = await host.client.call('personal_avatar_status', { owner, generationId: cancelInput.generationId });
  assert.equal(cancelled.state, 'cancelled');
  await assert.rejects(configure(host, before.id, { avatar: { kind: 'image', generationId: cancelInput.generationId, assetId: before.look.image.assetId } }), /cancelled|stale/i);
  assert.deepEqual((await readAssistant(host)).look, before.look);
  const newer = reduceAvatarEditor(saved[1].editor, { type: 'generate', generationId: 'newer', editorToken: 'newer' });
  assert.equal(reduceAvatarEditor(newer, { type: 'result', job: saved[1].preview }), newer, 'late actual completion cannot replace a newer editor');
  await assertOfflinePixelFallback(before, before.look.image);
  const current = await readAssistant(host);
  await assert.rejects(host.client.call('personal_workspace_configure', { assistantId: current.id, expectedRevision: current.revision - 1, settings: { name: 'stale rename' }, avatar: { kind: 'pixel' } }), /changed|revision/i);
  assert.deepEqual((await readAssistant(host)).look, before.look);
  const reset = await configure(host, before.id, { avatar: { kind: 'pixel' } });
  assert.equal(reset.look.kind, 'pixel'); assert.equal(reset.look.image, undefined); assert.equal(reset.look.seed, before.look.seed); assert.equal(reset.look.color, before.look.color);
  assert.equal(reset.costs.filter(cost => cost.kind === 'image').length, 2, 'cancel after dispatch retains its cost reservation');
  await host.stop(); await host.start();
  assert.deepEqual((await readAssistant(host)).look, reset.look);
  assert.equal((await host.client.call('personal_avatar_status', { owner, generationId: cancelInput.generationId })).state, 'cancelled');
  assert.deepEqual((await readAssistant(hosts[0])).look, saved[0].assistant.look, 'other same-ID owner remains unchanged');
});
test('real host backends isolate a drop and do not replay rejected text', { timeout: 30000 }, async t => {
  const mac = await daemon(t); const server = await daemon(t);
  assert.notEqual(mac.welcome.host_id, server.welcome.host_id);
  const registry = createHostBackends({
    local: mac.backend,
    hosts: [{ id: 'h-at', name: 'Apex-Terminal', remote: true }],
    make: () => ({
      backend: server.backend, connection: server.connection,
      start: () => server.client.start(), close: () => server.client.close(),
    }),
  });
  const remote = registry.get('h-at');
  const heard = [];
  const hub = createEventHub({});
  t.after(() => registry.dispose('h-at'));
  const offMac = await hub.start(mac.backend, 'local');
  const offServer = await hub.start(remote, 'h-at');
  t.after(() => { offMac(); offServer(); });
  hub.registerRoom('same-id', e => heard.push(['local', e]), 'local');
  hub.registerRoom('same-id', e => heard.push(['h-at', e]), 'h-at');
  await mac.backend.roomCreate('same-id', [bot('mac-reply')], options, '');
  await remote.roomCreate('same-id', [bot('server-reply')], options, '');
  await Promise.all([
    mac.backend.roomPost('same-id', '@bot first'),
    remote.roomPost('same-id', '@bot first'),
  ]);
  await until(() => heard.some(([host, e]) => host === 'local' && e.type === 'message_added' && e.message.text === 'mac-reply'));
  await until(() => heard.some(([host, e]) => host === 'h-at' && e.type === 'message_added' && e.message.text === 'server-reply'));
  server.breakLink();
  await until(() => server.connection.get().status.kind === 'reconnecting');
  await assert.rejects(remote.roomPost('same-id', '@bot offline-draft'));
  await mac.backend.roomPost('same-id', '@bot second');
  assert.equal(mac.connection.get().status.kind, 'connected');
  server.connection.retryNow();
  await until(() => server.connection.get().status.kind === 'connected');
  const state = await remote.roomState('same-id');
  assert.equal(state.snapshot.transcript.some(m => m.text.includes('offline-draft')), false);
  assert.equal(heard.some(([host, e]) => host === 'local' &&
    e.type === 'message_added' && e.message.text === 'server-reply'), false);
  assert.equal(heard.some(([host, e]) => host === 'h-at' &&
    e.type === 'message_added' && e.message.text === 'mac-reply'), false);
});

test('creation draft charges survive cancel or reset to pixel and consumed drafts cannot dispatch again', { timeout: 30_000 }, async t => {
  const f = await workspaceFixture(t, 'adw-draft'), host = await f.host('host');
  await host.client.call('session_save', { session: { version: 1, profiles: [f.profile] } });
  for (const action of ['cancel', 'reset']) {
    const owner = { kind: 'creation', hostId: host.hostId, draftId: `draft-${action}` };
    const input = { owner, generationId: 'generation', editorToken: 'editor', providerProfileId: 'fixture-avatar-provider', modelId: 'fixture-avatar-image', prompt: `${action} candidate` };
    await host.client.call('personal_avatar_generate', input);
    if (action === 'cancel') await host.client.call('personal_avatar_cancel', { owner, generationId: input.generationId });
    else await eventually('unapplied creation preview', async () => (await host.client.call('personal_avatar_status', { owner, generationId: input.generationId })).state === 'preview');
    // draftId carries bookkeeping, while omission of generation/asset expresses
    // the user's explicit pixel selection. It cannot attach an unapplied image.
    const create = { name: `Pixel ${action}`, folder: path.join(f.root, action), profile: f.profile, workspaceVersion: 4, avatarDraftId: owner.draftId, look: { seed: `pixel-${action}`, color: '#336699', kind: 'pixel' } };
    const assistant = await host.client.call('personal_create', create);
    assert.equal(assistant.look.kind, 'pixel'); assert.equal(assistant.look.image, undefined);
    assert.deepEqual(assistant.costs.filter(cost => cost.kind === 'image').map(cost => cost.micros), [40_000]);
    await assert.rejects(host.client.call('personal_create', create), /already|draft/i);
    await assert.rejects(host.client.call('personal_avatar_generate', { ...input, generationId: 'late-reservation' }), /consumed|draft/i);
    await assert.rejects(host.client.call('personal_avatar_status', { owner, generationId: 'late-reservation' }), /not found|missing|unknown/i);
    assert.equal((await readAssistant(host, assistant.id)).costs.filter(cost => cost.kind === 'image').length, 1);
  }
  await host.stop(); await host.start();
  for (const assistant of await host.client.call('personal_list', {})) {
    assert.equal(assistant.look.kind, 'pixel'); assert.equal(assistant.look.image, undefined);
    assert.equal(assistant.costs.filter(cost => cost.kind === 'image').length, 1);
  }
});

// Moving a thread that hasn't started: what it had must still be somewhere whole.
const page = { version: 1, artifacts: [{ id: 'a1', title: 'Page', kind: 'html', versions: [{ n: 1, source: '<p>hi</p>', by: 'bot', seq: 2, at: 1 }] }] };
const savedRoom = (data, id) => path.join(data, 'saved-chats-v1', 'rooms', `${Buffer.from(id).toString('hex')}.json`);
function folders(t) {
  const root = fs.mkdtempSync('/tmp/adf-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return ['a', 'b'].map(name => { const dir = path.join(root, name); fs.mkdirSync(dir); return dir; });
}
/** A cleared thread: no messages, but its bot, a pin and an artifact. */
async function cleared(backend, folder) {
  await backend.roomCreate('t', [bot('kept')], options, folder);
  await backend.roomPin('t', 'use pnpm');
  await backend.artifactsSave('t', page);
  return (await backend.roomState('t')).snapshot;
}
test('an older helper keeps a thread whole when it cannot move it to another folder', { timeout: 30000 }, async t => {
  const server = await daemon(t); const [a, b] = folders(t);
  // An apex-daemon from before room_import: the same daemon without that command.
  const older = { ...server.backend, roomImport: async () => { throw new Error('unknown variant `room_import`, expected one of `session_load`'); } };
  const snapshot = await cleared(server.backend, a);
  await assert.rejects(placeThread({ from: older, to: older, id: 't', snapshot, cwd: b, sameHost: true, hostName: 'AT' }), FolderMoveUnsupported);
  const after = (await server.backend.roomState('t')).snapshot;
  assert.deepEqual(after.participants.map(p => p.display_name), ['kept']);
  assert.deepEqual(after.pins, ['use pnpm']);
  assert.deepEqual(await server.backend.artifactsLoad('t'), page);
  assert.equal(JSON.parse(fs.readFileSync(savedRoom(server.data, 't'), 'utf8')).cwd, a);
});
test('a thread moved to another machine takes its bot, pins and artifacts, and the old copy goes', { timeout: 30000 }, async t => {
  const mac = await daemon(t); const server = await daemon(t); const [a, b] = folders(t);
  const snapshot = await cleared(mac.backend, a);
  assert.equal(await placeThread({ from: mac.backend, to: server.backend, id: 't', snapshot, cwd: b, sameHost: false, hostName: 'AT' }), 'imported');
  const there = await server.backend.roomCreate('t', [], options, b);
  assert.deepEqual(there.participants.map(p => p.display_name), ['kept']);
  assert.deepEqual(there.pins, ['use pnpm']);
  assert.deepEqual(await server.backend.artifactsLoad('t'), page);
  assert.equal(fs.existsSync(savedRoom(mac.data, 't')), false);
  assert.equal(await mac.backend.artifactsLoad('t'), null);
});
test('a move whose artifacts cannot be saved there leaves the thread whole where it was', { timeout: 30000 }, async t => {
  const mac = await daemon(t); const server = await daemon(t); const [a, b] = folders(t);
  const full = { ...server.backend, artifactsSave: async () => { throw new Error('No space left on device'); } };
  const snapshot = await cleared(mac.backend, a);
  await assert.rejects(placeThread({ from: mac.backend, to: full, id: 't', snapshot, cwd: b, sameHost: false, hostName: 'AT' }), /No space left/);
  assert.equal(fs.existsSync(savedRoom(server.data, 't')), false);
  assert.deepEqual((await mac.backend.roomState('t')).snapshot.pins, ['use pnpm']);
  assert.deepEqual(await mac.backend.artifactsLoad('t'), page);
});
test('an older helper that still has a copy of the thread from an earlier move keeps it, and the thread stays whole here', { timeout: 30000 }, async t => {
  const mac = await daemon(t); const server = await daemon(t); const [a, b] = folders(t);
  // Left on the server by an earlier move whose delete never arrived.
  await server.backend.roomCreate('t', [bot('left')], options, a);
  await server.backend.roomClose('t');
  await mac.backend.roomCreate('t', [bot('moved')], options, b);
  await mac.backend.artifactsSave('t', page);
  const snapshot = (await mac.backend.roomState('t')).snapshot;
  // Its artifacts can't be saved there either, as when that disk is full.
  const older = { ...server.backend,
    roomImport: async () => { throw new Error('unknown variant `room_import`, expected one of `session_load`'); },
    artifactsSave: async () => { throw new Error('No space left on device'); } };
  await assert.rejects(placeThread({ from: mac.backend, to: older, id: 't', snapshot, cwd: b, sameHost: false, hostName: 'AT' }), MoveRefused);
  const left = JSON.parse(fs.readFileSync(savedRoom(server.data, 't'), 'utf8'));
  assert.equal(left.cwd, a);
  assert.deepEqual(left.snapshot.participants.map(p => p.display_name), ['left']);
  assert.deepEqual((await mac.backend.roomState('t')).snapshot.participants.map(p => p.display_name), ['moved']);
  assert.deepEqual(await mac.backend.artifactsLoad('t'), page);
});
test('an older helper with nothing under that id takes a thread that has not started, with its bot and artifacts', { timeout: 30000 }, async t => {
  const mac = await daemon(t); const server = await daemon(t); const [a, b] = folders(t);
  await mac.backend.roomCreate('t', [bot('moved')], options, a);
  await mac.backend.artifactsSave('t', page);
  const snapshot = (await mac.backend.roomState('t')).snapshot;
  const older = { ...server.backend, roomImport: async () => { throw new Error('unknown variant `room_import`, expected one of `session_load`'); } };
  assert.equal(await placeThread({ from: mac.backend, to: older, id: 't', snapshot, cwd: b, sameHost: false, hostName: 'AT' }), 'recreated');
  const there = JSON.parse(fs.readFileSync(savedRoom(server.data, 't'), 'utf8'));
  assert.equal(there.cwd, b);
  assert.deepEqual(there.snapshot.participants.map(p => p.display_name), ['moved']);
  assert.deepEqual(await server.backend.artifactsLoad('t'), page);
  assert.equal(fs.existsSync(savedRoom(mac.data, 't')), false);
});
