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
test('offline host commands reject and do not queue; discovery is per host',async()=>{
  assert.equal(typeof mod.createHostBackends,'function');assert.equal(typeof store.hostConnectionStore,'function');
  const c=store.hostConnectionStore('at','AT');let posts=0;
  const registry=mod.createHostBackends({local:{},hosts:[{id:'at',name:'AT'}],make:()=>({backend:{roomPost:async()=>posts++,detectAgents:async()=>[{key:'codex',found:false}]},connection:c,start:async()=>{},close(){}})});
  const remote=registry.get('at');await assert.rejects(remote.roomPost('r','offline'),/connect|unavailable/i);assert.equal(posts,0);
  c.setStatus({kind:'connected',hostId:'a'});await registry.discover('at');assert.equal(c.get().agents[0].found,false);
  registry.dispose('at');await assert.rejects(remote.roomPost('r','later'),/host|removed/i);
});
