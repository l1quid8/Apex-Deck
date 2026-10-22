import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
const mod=await import('../desktop/provenance.mjs').catch(()=>({}));

test('provenance wrapper binds actual command and rejects a substituted signed response',async()=>{
  assert.equal(typeof mod.attestFrame,'function');
  const {publicKey,privateKey}=generateKeyPairSync('ed25519');
  const raw=publicKey.export({type:'spki',format:'der'}).subarray(-32);
  const frame={id:5,cmd:'personal_send',args:{assistantId:'a',requestId:'r',text:'hello'}};
  function response(command){
    const payload=JSON.stringify({domain:'apex-provenance-v1',kind:'submission',receipt:{uid:501,dataDir:'/data',command,key:'k'}});
    return {payload,signature:sign(null,Buffer.from(payload),privateKey).toString('base64')};
  }
  const result=await mod.attestFrame(frame,{dataDir:'/data',uid:501,publicKey:raw,issue:async()=>response({cmd:frame.cmd,args:frame.args})});
  assert.equal(result.cmd,'provenance_execute');assert.equal(result.id,5);
  await assert.rejects(mod.attestFrame(frame,{dataDir:'/data',uid:501,publicKey:raw,issue:async()=>response({cmd:'personal_send',args:{...frame.args,text:'other'}})}));
});
test('ordinary commands retain Full access transport and are not signed',async()=>{
  assert.equal(typeof mod.attestFrame,'function');
  const frame={id:2,cmd:'mod_process_run',args:{argv:['git','status']}};
  assert.deepEqual(await mod.attestFrame(frame,{issue:()=>assert.fail('not a human intent')}),frame);
});
test('packaged provenance refuses code injection switches and development URLs',()=>{
  assert.equal(typeof mod.assertTrustedStartup,'function');
  assert.throws(()=>mod.assertTrustedStartup(true,['app','--remote-debugging-port=9222'],{}));
  assert.throws(()=>mod.assertTrustedStartup(true,['app'],{APEX_DECK_DEV_URL:'http://localhost:5173'}));
  assert.throws(()=>mod.assertTrustedStartup(true,['app'],{NODE_OPTIONS:'--require=/tmp/x'}));
  assert.doesNotThrow(()=>mod.assertTrustedStartup(true,['app'],{APEX_DECK_DATA_DIR:'/tmp/isolated-apex'}));
  assert.throws(()=>mod.assertTrustedStartup(true,['app'],{APEX_DECK_DATA_DIR:'relative'}));
  assert.doesNotThrow(()=>mod.assertTrustedStartup(false,['app'],{APEX_DECK_DEV_URL:'http://localhost:5173'}));
});

test('delivery IDs stay outside strict command argument objects',async()=>{
  const {publicKey,privateKey}=generateKeyPairSync('ed25519');
  const raw=publicKey.export({type:'spki',format:'der'}).subarray(-32);
  const frame={id:7,cmd:'personal_workspace_configure',args:{assistantId:'a',expectedRevision:2}};
  let issued;
  await mod.attestFrame(frame,{dataDir:'/data',uid:501,publicKey:raw,issue:async request=>{
    issued=request.command;
    const payload=JSON.stringify({domain:'apex-provenance-v1',kind:'submission',receipt:{uid:501,dataDir:'/data',command:issued,key:'k'}});
    return {payload,signature:sign(null,Buffer.from(payload),privateKey).toString('base64')};
  }});
  assert.deepEqual(issued.args,frame.args);
  assert.match(issued.provenanceRequestId,/^[a-f0-9-]{36}$/);
});
