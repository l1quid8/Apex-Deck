import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,sign} from 'node:crypto';
import { channel } from '../desktop/channel.mjs';
import * as provenance from '../desktop/provenance.mjs';
import * as service from '../desktop/linuxService.mjs';

const keys=generateKeyPairSync('ed25519');
const publicKey=keys.publicKey.export({type:'spki',format:'der'}).subarray(-32);
const foreignDomain=channel.nightly?'apex-provenance-v1':'apex-provenance-nightly-v1';
const tree=channel.LINUX_TREE+'/test';
const release={channel:'nightly',version:'0.9.9',commit:'d'.repeat(40),buildNumber:123};
const scope=nonce=>({domain:channel.DOMAIN,kind:'linux-scope',nonce,uid:1000,dataDir:'/home/dev/deck',epoch:7,manifestSha256:'a'.repeat(64),protocol:1,tree,brokerInstance:'b'.repeat(32),role:'app',daemonEndpoint:'/home/dev/deck/daemon.sock',daemonPid:123,...(channel.nightly?{release}:{})});
const envelope=value=>{const payload=JSON.stringify(value);return {payload,signature:sign(null,Buffer.from(payload),keys.privateKey).toString('base64')};};
test('installed UI waits for a restarting engine without retrying invalid identity',async()=>{
  const plan={protectedInstallationDetected:true};
  const bundle=tree+'/resources/app.asar';
  let calls=0, waits=0;
  const identity=async()=>{if(++calls<3)throw new Error('Installed daemon readiness probe failed');return scope('c'.repeat(32));};
  const ready=await service.resolveLinuxLaunch({plan,bundle,identity,wait:async()=>{waits++;}});
  assert.equal(ready.kind,'run');assert.equal(calls,3);assert.equal(waits,2);
  calls=0;
  const broken=await service.resolveLinuxLaunch({plan,bundle,identity:async()=>{calls++;throw new Error('wrong signature');},wait:async()=>assert.fail('invalid identity must fail immediately')});
  assert.equal(broken.kind,'notice');assert.equal(calls,1);
  calls=0;
  const stopped=await service.resolveLinuxLaunch({plan,bundle,identity:async()=>{calls++;throw new Error('Installed daemon readiness probe failed');},wait:async()=>{}});
  assert.equal(stopped.kind,'notice');assert.equal(calls,12);
});
test('Linux scope verifies signatures, fresh challenge, enrolled UID and exact paths',async()=>{
  assert.equal(typeof provenance.linuxIdentity,'function');
  const options={uid:1000,publicKey,send:async request=>envelope(scope(request.nonce))};
  const identity=await provenance.linuxIdentity(options);
  assert.equal(identity.dataDir,'/home/dev/deck');
  for(const change of [{domain:foreignDomain},{nonce:'stale'},{uid:1001},{epoch:0},{protocol:2},{tree:'/tmp/fake'},{tree:channel.nightly ? '/opt/apex-deck/test' : '/opt/apex-deck-nightly/test'},{dataDir:'/home/dev/../other'},{daemonEndpoint:'/tmp/fake.sock'},{role:'daemon'},{release:channel.nightly ? undefined : release}]){
    await assert.rejects(provenance.linuxIdentity({...options,send:async request=>envelope({...scope(request.nonce),...change})}));
  }
  if(channel.nightly) {
    for(const change of [{channel:'stable'},{commit:'e'.repeat(12)},{buildNumber:0},{buildNumber:Number.MAX_SAFE_INTEGER+1}]) {
      await assert.rejects(provenance.linuxIdentity({...options,send:async request=>envelope({...scope(request.nonce),release:{...release,...change}})}));
    }
  }
  await assert.rejects(provenance.linuxIdentity({...options,send:async request=>({...envelope(scope(request.nonce)),signature:Buffer.alloc(64).toString('base64')})}));
});
test('only the supervised installed UI routes to the enrolled engine, and failures never start portable',async()=>{
  assert.equal(typeof service.resolveLinuxLaunch,'function');
  const base={kind:'notice',daemon:'/tmp/portable',protectedInstallationDetected:true,protectedSubmissionError:'repair'};
  const identity=scope('c'.repeat(32));
  const plan=await service.resolveLinuxLaunch({plan:base,bundle:tree+'/resources/app.asar',identity:async()=>identity});
  assert.equal(plan.kind,'run');assert.equal(plan.dataDir,'/home/dev/deck');assert.equal(plan.protectedSubmissionError,undefined);
  assert.equal((await service.resolveLinuxLaunch({plan:base,bundle:'/tmp/copied/resources/app.asar',identity:async()=>({...identity,role:null})})).kind,'handoff');
  const broken=await service.resolveLinuxLaunch({plan:base,bundle:'/tmp/app',identity:async()=>{throw new Error('wrong signature');}});
  await assert.rejects(service.linuxLocalDaemon({plan:broken,startPortable:()=>assert.fail('fallback forbidden')}));
});
test('portable UI requests a broker-owned launch with exact app role and validates signed response',async()=>{
  const identity=scope('c'.repeat(32));
  const send=async request=>{
    assert.equal(request.op,'launch');assert.equal(request.role,'app');
    assert.deepEqual(request.environment,{WAYLAND_DISPLAY:'wayland-1'});
    return envelope({domain:channel.DOMAIN,kind:'linux-launch',nonce:request.nonce,role:'app',uid:identity.uid,pid:123,epoch:identity.epoch});
  };
  assert.equal(await service.launchLinuxUI({scope:identity,publicKey,send,env:{WAYLAND_DISPLAY:'wayland-1',LD_PRELOAD:'/tmp/evil'}}),'');
  for(const change of [{domain:foreignDomain},{epoch:6}]) {
    await assert.rejects(service.launchLinuxUI({scope:identity,publicKey,env:{},send:async request=>envelope({domain:channel.DOMAIN,kind:'linux-launch',nonce:request.nonce,role:'app',uid:identity.uid,pid:123,epoch:identity.epoch,...change})}));
  }
});
test('Linux submissions reject the other channel even with a valid signature',async()=>{
  const frame={id:1,cmd:'personal_send',args:{text:'test'}};
  const receipt=domain=>async request=>request.op==='scope'
    ? envelope(scope(request.nonce))
    : envelope({domain,kind:'submission',receipt:{uid:1000,dataDir:'/home/dev/deck',command:request.command,installationEpoch:7}});
  const options={platform:'linux',uid:1000,publicKey};
  assert.equal((await provenance.attestFrame(frame,{...options,issue:receipt(channel.DOMAIN)})).cmd,'provenance_execute');
  await assert.rejects(provenance.attestFrame(frame,{...options,issue:receipt(foreignDomain)}),/Receipt does not match/);
});
