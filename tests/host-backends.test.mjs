import test from 'node:test';
import assert from 'node:assert/strict';
const mod=await import('../src/hostBackends.ts').catch(()=>({}));
const store=await import('../src/hostConnections.ts').catch(()=>({}));
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

test('importing a thread onto an offline host is refused, not queued', async () => {
  const c = store.hostConnectionStore('at', 'AT'); let imports = 0;
  const registry = mod.createHostBackends({ local: {}, hosts: [{ id: 'at', name: 'AT' }], make: () => ({ backend: { roomImport: async () => imports++ }, connection: c, start: async () => {}, close() {} }) });
  await assert.rejects(registry.get('at').roomImport('f', { transcript: [] }, '/x'), /connect|nothing was queued/i);
  assert.equal(imports, 0);
});
