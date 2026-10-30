import test from 'node:test';
import assert from 'node:assert/strict';
const mod=await import('../src/hostBackends.ts').catch(()=>({}));
const store=await import('../src/hostConnections.ts').catch(()=>({}));

test('curation methods and raw commands reject offline writes without replay', async () => {
  const connection = store.hostConnectionStore('server','Server');
  const calls = [];
  const guarded = mod.guardHostWrites({
    roomCurate:async id=>{calls.push(['curate',id]);return {by:'null',status:'nothing',unchecked:0};},
    roomCurateUndo:async id=>{calls.push(['undo',id]);return {restored:2,sealed:1};},
    call:async command=>{calls.push(command);},
  }, connection);
  for (const status of [{kind:'idle'},{kind:'resync'},{kind:'reconnecting',attempt:1}]) {
    connection.setStatus(status);
    await assert.rejects(guarded.roomCurate('r'), /nothing was queued/);
    await assert.rejects(guarded.roomCurateUndo('r'), /nothing was queued/);
    await assert.rejects(guarded.call('room_curate',{id:'r'}), /nothing was queued/);
    await assert.rejects(guarded.call('room_curate_undo',{id:'r'}), /nothing was queued/);
  }
  connection.setStatus({kind:'connected',hostId:'server'});
  assert.deepEqual(calls, []);
  assert.equal((await guarded.roomCurate('r')).status, 'nothing');
  assert.deepEqual(await guarded.roomCurateUndo('r'), {restored:2,sealed:1});
  assert.deepEqual(calls, [['curate','r'],['undo','r']]);
});

test('remote turns always carry card guidance without writing remote app preferences', async () => {
  const calls=[];
  const c=store.hostConnectionStore('at','AT');c.setStatus({kind:'connected',hostId:'at'});
  const remote={roomPost:async(...args)=>calls.push(['post',...args]),roomPostTo:async(...args)=>calls.push(['postTo',...args]),roomTurn:async(...args)=>calls.push(['turn',...args]),settingsSave:async()=>assert.fail('must not write remote preferences')};
  const registry=mod.createHostBackends({local:{},hosts:[{id:'at',name:'AT'}],make:()=>({backend:remote,connection:c,start:async()=>{},close(){}})});
  const backend=registry.get('at');
  await backend.roomPost('r','hello');
  await backend.roomPostTo('r','hello',['bot']);
  await backend.roomTurn('r',['bot'],null);
  assert.deepEqual(calls,[['post','r','hello',true],['postTo','r','hello',['bot'],true],['turn','r',['bot'],null,true]]);
});

test('local attachment readers stay stable across renders and check current connection state', async () => {
  const connection = store.hostConnectionStore('local', 'Mac');
  const target = { readAttachment: async () => new ArrayBuffer(3), roomPost: async () => 'sent' };
  const backend = mod.guardHostWrites(target, connection);
  const read = backend.readAttachment;
  const post = backend.roomPost;
  assert.equal(backend.readAttachment, read, 'rerender must not restart the thumbnail effect');
  assert.equal(backend.roomPost, post);
  connection.setStatus({ kind: 'connected', hostId: 'mac' });
  assert.equal(await post('r', 'hello'), 'sent');
  connection.setStatus({ kind: 'reconnecting', attempt: 1 });
  await assert.rejects(post('r', 'hello'), /queued/);
  assert.equal((await read('/shot.png')).byteLength, 3);
});

test('remote attachment readers stay stable across renders and reject removed hosts', async () => {
  const registry = mod.createHostBackends({ local: {}, hosts: [{ id: 'remote', name: 'Server' }],
    make: () => ({ backend: { readAttachment: async () => new ArrayBuffer(3) },
      connection: { get: () => ({ status: { kind: 'connected' } }) }, start: async () => {}, close() {} }) });
  const backend = registry.get('remote');
  const read = backend.readAttachment;
  assert.equal(backend.readAttachment, read, 'rerender must not restart the thumbnail effect');
  assert.equal((await read('/shot.png')).byteLength, 3);
  registry.dispose('remote');
  await assert.rejects(read('/shot.png'), /removed/);
});

test('source edits reject offline rather than saving after reconnection', async () => {
  const c = store.hostConnectionStore('at', 'AT'); let calls = 0;
  const guarded = mod.guardHostWrites({ call: async () => calls++ }, c);
  await assert.rejects(guarded.call('monitor_sources_update', { workspaceId: 'p' }), /queued/);
  await assert.rejects(guarded.call('personal_react', { assistantId: 'a', messageId: 'm', emoji: '👍', enabled: true }), /queued/);
  await assert.rejects(guarded.call('monitor_react', { workspaceId: 'p', messageId: 'm', emoji: '👍', enabled: true }), /queued/);
  assert.equal(calls, 0);
  c.setStatus({ kind: 'connected', hostId: 'a' });
  await guarded.call('monitor_sources_update', { workspaceId: 'p' });
  assert.equal(calls, 1);
});

test('versioned assistant settings reject disconnected writes without replaying after reconnect', async () => {
  const connection = store.hostConnectionStore('server', 'Server');
  const calls = [];
  const guarded = mod.guardHostWrites({ call: async (...args) => { calls.push(args); return { saved: true }; } }, connection);
  const args = { assistantId: 'asst-1', expectedRevision: 3, settings: { name: 'Null' } };
  for (const status of [{ kind: 'idle' }, { kind: 'resync' }, { kind: 'reconnecting', attempt: 1 }]) {
    connection.setStatus(status);
    await assert.rejects(guarded.call('personal_workspace_configure', args), /nothing was queued/);
  }
  connection.setStatus({ kind: 'connected', hostId: 'server' });
  assert.equal(calls.length, 0);
  assert.deepEqual(await guarded.call('personal_workspace_configure', args), { saved: true });
  assert.deepEqual(calls, [['personal_workspace_configure', args]]);
});

test('project notebook mutations reject disconnected delivery and never replay on reconnect', async () => {
  const connection = store.hostConnectionStore('server', 'Server');
  const calls = [];
  const guarded = mod.guardHostWrites({ call: async (...args) => { calls.push(args); return { saved: true }; } }, connection);
  const commands = ['project_memory_save', 'project_memory_forget', 'project_memory_stage', 'project_memory_promote'];
  const args = { assistant: { hostId: 'server', assistantId: 'asst-1' }, project: { hostId: 'server', workspaceId: 'w', cwd: '/repo' } };
  for (const status of [{ kind: 'idle' }, { kind: 'resync' }, { kind: 'reconnecting', attempt: 1 }]) {
    connection.setStatus(status);
    for (const command of commands) await assert.rejects(guarded.call(command, args), /nothing was queued/);
  }
  connection.setStatus({ kind: 'connected', hostId: 'server' });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, []);
  for (const command of commands) assert.deepEqual(await guarded.call(command, args), { saved: true });
  assert.deepEqual(calls, commands.map(command => [command, args]));
});

test('chat mutations wait for connected state while recovery reads remain available', async () => {
  const connection = store.hostConnectionStore('server', 'Server');
  const calls = [];
  const guarded = mod.guardHostWrites({call:async(command)=>{calls.push(command);return command;}},connection);
  const commands = ['chat_create','chat_update_meta','chat_add_participant','chat_update_participant','chat_remove_participant','chat_import','chat_message_claim','chat_merge_history','chat_promote'];
  for (const status of [{kind:'idle'},{kind:'resync'},{kind:'reconnecting',attempt:1}]) {
    connection.setStatus(status);
    for (const command of commands) await assert.rejects(guarded.call(command,{}),/nothing was queued/);
  }
  assert.deepEqual(calls,[]);
  assert.equal(await guarded.call('chat_list',{}),'chat_list');
  assert.equal(await guarded.call('chat_profiles',{}),'chat_profiles');
  connection.setStatus({kind:'connected'});
  for (const command of commands) await guarded.call(command,{});
  assert.deepEqual(calls,['chat_list','chat_profiles',...commands]);
});
test('stable host registry starts only requested hosts and keeps preferences on Mac',async()=>{
  assert.equal(typeof mod.createHostBackends,'function');
  const seen=[];let starts=0;
  const local={sessionSave:async()=>seen.push('local-save'),settingsSave:async()=>seen.push('local-settings')};
  const registry=mod.createHostBackends({local,hosts:[{id:'at',name:'AT',remote:true}],make:host=>({backend:{roomPost:async()=>seen.push(host.id),sessionLoad:async()=>({legacy:true})},connection:{get:()=>({status:{kind:'connected'}})},start:async()=>{starts++;},close(){}})});
  assert.equal(starts,0);const remote=registry.get('at');assert.equal(remote,registry.get('at'));assert.equal(starts,1);
  await remote.roomPost('r','hello');await remote.sessionSave({});await remote.settingsSave({});
  assert.deepEqual(seen,['at','local-save','local-settings']);assert.deepEqual(await registry.legacySession('at'),{legacy:true});
  assert.throws(()=>registry.get('missing'),/host/i);
});
test('initial connect and lost history increment only that host recovery revision',()=>{
  assert.equal(typeof store.hostConnectionStore,'function');
  const at=store.hostConnectionStore('at','AT');const mac=store.hostConnectionStore('local','Mac');
  at.setStatus({kind:'connected',hostId:'daemon-a'});assert.equal(at.get().revision,1);assert.equal(mac.get().revision,0);
  at.setStatus({kind:'reconnecting',attempt:1,reason:'drop',retryAt:0});at.setStatus({kind:'connected',hostId:'daemon-a'});
  assert.equal(at.get().revision,1);at.setStatus({kind:'resync'});assert.equal(at.get().revision,2);
});

test('resumed reconnect retries incomplete rooms without reloading healthy ones', async () => {
  const connection = store.hostConnectionStore('at', 'AT');
  let incomplete = true; let attempts = 0; let healthyLoads = 0;
  connection.recover(async()=>{attempts++; if(attempts > 1) incomplete=false;}, ()=>incomplete);
  connection.recover(async()=>{healthyLoads++;});
  connection.setStatus({kind:'connected',hostId:'a'});
  await new Promise(r=>setImmediate(r));
  connection.setStatus({kind:'reconnecting',attempt:1,reason:'drop',retryAt:0});
  connection.setStatus({kind:'connected',hostId:'a'});
  await new Promise(r=>setImmediate(r));
  assert.equal(attempts,2); assert.equal(incomplete,false); assert.equal(healthyLoads,1);
  assert.equal(connection.get().revision,1);
});
test('offline host commands reject and do not queue; discovery is per host',async()=>{
  assert.equal(typeof mod.createHostBackends,'function');assert.equal(typeof store.hostConnectionStore,'function');
  const c=store.hostConnectionStore('at','AT');let posts=0;
  const registry=mod.createHostBackends({local:{},hosts:[{id:'at',name:'AT'}],make:()=>({backend:{roomPost:async()=>posts++,detectAgents:async()=>[{key:'codex',found:false}]},connection:c,start:async()=>{},close(){}})});
  const remote=registry.get('at');await assert.rejects(remote.roomPost('r','offline'),/connect|unavailable/i);assert.equal(posts,0);
  c.setStatus({kind:'connected',hostId:'a'});await registry.discover('at');assert.equal(c.get().agents[0].found,false);
  registry.dispose('at');await assert.rejects(remote.roomPost('r','later'),/host|removed/i);
});
test('both local and remote raw mutations reject throughout resync without replay',async()=>{
  assert.equal(typeof mod.guardHostWrites,'function');
  const c=store.hostConnectionStore('local','Mac');let calls=0;
  const guarded=mod.guardHostWrites({roomPost:async()=>calls++,call:async()=>calls++,roomState:async()=>({})},c);
  c.setStatus({kind:'connected',hostId:'mac'});await guarded.roomPost('r','first');
  c.setStatus({kind:'resync'});
  await assert.rejects(guarded.roomPost('r','blocked'),/queued/);
  await assert.rejects(guarded.call('room_post',{id:'r',text:'blocked'}),/queued/);
  await assert.rejects(guarded.call('personal_react',{assistantId:'a',messageId:'m',emoji:'👍',enabled:true}),/queued/);
  await assert.rejects(guarded.call('monitor_react',{workspaceId:'w',messageId:'m',emoji:'👍',enabled:true,cwd:'/p',hostId:'local',conversationId:'c'}),/queued/);
  assert.deepEqual(await guarded.roomState('r'),{});assert.equal(calls,1);
  c.setStatus({kind:'connected',hostId:'mac'});assert.equal(calls,1);
});

test('PTY resize probes pass during resync while terminal input and startup remain blocked', async () => {
  const c=store.hostConnectionStore('at','AT'); const seen=[];
  const target={ptyResize:async(...args)=>seen.push(['resize',...args]),ptyWrite:async()=>assert.fail('input must stay blocked'),ptySpawn:async()=>assert.fail('startup must stay blocked'),call:async(...args)=>seen.push(['call',...args])};
  const local=mod.guardHostWrites(target,c);
  const registry=mod.createHostBackends({local:{},hosts:[{id:'at',name:'AT'}],make:()=>({backend:target,connection:c,start:async()=>{},close(){}})});
  const remote=registry.get('at');
  c.setStatus({kind:'connected',hostId:'a'}); c.setStatus({kind:'resync'});
  await local.ptyResize('local:1',80,24); await remote.ptyResize('remote:1',90,30);
  await remote.call('pty_resize',{id:'remote:1',cols:90,rows:30});
  for(const backend of [local,remote]) {
    await assert.rejects(backend.ptyWrite('r','input'),/queued/);
    await assert.rejects(backend.ptySpawn({id:'r'}),/queued/);
  }
  assert.deepEqual(seen,[['resize','local:1',80,24],['resize','remote:1',90,30],['call','pty_resize',{id:'remote:1',cols:90,rows:30}]]);
  c.setStatus({kind:'reconnecting',attempt:1,reason:'drop',retryAt:0});
  await assert.rejects(remote.ptyResize('remote:1',90,30),/queued/);
  assert.equal(seen.length,3);
});

test('renaming a saved host reaches its live backend and its connection store', () => {
  const registry = mod.createHostBackends({ local: {}, hosts: [{ id: 'at', name: 'AT', remote: true }], make: (host, connection) => ({ backend: {}, connection, start: async () => {}, close() {} }) });
  const idle = registry.connection('at');
  const remote = registry.get('at');
  registry.setHosts([{ id: 'at', name: 'Renamed', remote: true }]);
  assert.equal(remote.host.name, 'Renamed');
  assert.equal(registry.connection('at').get().name, 'Renamed');
  assert.equal(idle.get().name, 'Renamed');
});

test('a retained removed-host capability reader returns false synchronously', () => {
  const registry = mod.createHostBackends({ local: {}, hosts: [{ id: 'server', name: 'Server' }],
    make: () => ({ backend: { supports: () => true }, connection: { get: () => ({ status: { kind: 'connected' } }) }, start: async () => {}, close() {} }) });
  const supports = registry.get('server').supports;
  assert.equal(supports('assistant_workspace_v4'), true);
  registry.setHosts([]);
  const result = supports('assistant_workspace_v4');
  result?.catch?.(() => {});
  assert.equal(result, false);
});

test('importing a thread onto an offline host is refused, not queued', async () => {
  const c = store.hostConnectionStore('at', 'AT'); let imports = 0;
  const registry = mod.createHostBackends({ local: {}, hosts: [{ id: 'at', name: 'AT' }], make: () => ({ backend: { roomImport: async () => imports++ }, connection: c, start: async () => {}, close() {} }) });
  await assert.rejects(registry.get('at').roomImport('f', { transcript: [] }, '/x'), /connect|nothing was queued/i);
  assert.equal(imports, 0);
});
