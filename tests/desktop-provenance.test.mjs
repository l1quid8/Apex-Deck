import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
const mod=await import('../desktop/provenance.mjs').catch(()=>({}));

test('every host command requiring provenance enters desktop attestation',()=>{
  const source=readFileSync(new URL('../crates/apex-host/src/command.rs',import.meta.url),'utf8');
  const body=source.match(/pub fn requires_provenance\(&self\) -> bool \{([\s\S]*?)\n    \}/)?.[1];
  assert.ok(body,'locate the host provenance boundary');
  const commands=[...body.matchAll(/Self::([A-Za-z0-9_]+)/g)].map(([,variant])=>variant.replace(/[A-Z]/g,(letter,index)=>(index?'_':'')+letter.toLowerCase()));
  assert.ok(commands.length>0,'extract the protected host variants');
  assert.deepEqual(commands.filter(cmd=>!mod.needsAttestation(cmd,false)),[],'host-protected commands must receive installed UI receipts');
  const broker=readFileSync(new URL('../crates/apex-provenance/src/lib.rs',import.meta.url),'utf8');
  const brokerBody=broker.match(/pub fn protected\(name: &str\) -> bool \{([\s\S]*?)\n\}/)?.[1];
  assert.ok(brokerBody,'locate the broker provenance boundary');
  const brokerCommands=new Set([...brokerBody.matchAll(/"([a-z_]+)"/g)].map(([,cmd])=>cmd));
  assert.deepEqual(commands.filter(cmd=>!brokerCommands.has(cmd)),[],'host-protected commands must be accepted by the broker');
});

test('approval grants, permission edits, trash and action labels bind exact signed submissions',async()=>{
  const {publicKey,privateKey}=generateKeyPairSync('ed25519');
  const raw=publicKey.export({type:'spki',format:'der'}).subarray(-32);
  const frames=[
    {id:31,cmd:'personal_decide_always',args:{assistantId:'alfred',requestId:'approval-request',decisionId:'decision-1',paramsHash:'params-hash',expectedRevision:7,capability:'commandRun',scope:{kind:'project',host:'mac',cwd:'/project'}}},
    {id:32,cmd:'personal_permission_set',args:{assistantId:'alfred',expectedRevision:8,capability:'commandRun',scope:{kind:'allProjects'},mode:'always',delegate:false}},
    {id:33,cmd:'room_set_trashed',args:{id:'thread-1',trashed:true}},
    {id:34,cmd:'computer_set_action_labels',args:{enabled:true}},
  ];
  const response=command=>{
    const payload=JSON.stringify({domain:'apex-provenance-v1',kind:'submission',receipt:{uid:501,dataDir:'/data',command,key:'k'}});
    return {payload,signature:sign(null,Buffer.from(payload),privateKey).toString('base64')};
  };
  for(const frame of frames){
    let issued;
    const result=await mod.attestFrame(frame,{dataDir:'/data',uid:501,publicKey:raw,issue:async request=>{
      assert.equal(request.op,'issue');assert.equal(request.dataDir,'/data');
      issued=request.command;return response(issued);
    }});
    assert.equal(result.cmd,'provenance_execute',`${frame.cmd} must be attested`);
    assert.equal(result.id,frame.id);
    assert.equal(issued.cmd,frame.cmd);assert.deepEqual(issued.args,frame.args);
    if(frame.cmd==='personal_decide_always') assert.equal(issued.provenanceRequestId,undefined,'atomic approval retries use the original requestId');
    else assert.match(issued.provenanceRequestId,/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
    assert.deepEqual(JSON.parse(result.args.receipt.payload).receipt.command,issued);
    await assert.rejects(mod.attestFrame(frame,{dataDir:'/data',uid:501,publicKey:raw,issue:async request=>response({...request.command,args:{...request.command.args,expectedRevision:99}})}),/Receipt does not match/);
    await assert.rejects(mod.attestFrame(frame,{dataDir:'/data',uid:501,publicKey:raw,issue:async request=>response({...request.command,provenanceRequestId:'another-submission'})}),/Receipt does not match/);
    if(frame.cmd==='personal_decide_always'){
      assert.deepEqual(await mod.attestFrame(frame,{dataDir:'/data',uid:501,publicKey:raw,issue:async request=>response(request.command)}),result,'the same atomic approval keeps its signed request identity');
      for(const change of [{scope:{kind:'allProjects'}},{requestId:'other-request'}]){
        await assert.rejects(mod.attestFrame(frame,{dataDir:'/data',uid:501,publicKey:raw,issue:async request=>response({...request.command,args:{...request.command.args,...change}})}),/Receipt does not match/);
      }
    }
  }
});

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
  // uid is explicit: attestFrame's default reads process.getuid(), which Windows
  // does not have. A command that is not a human intent never reaches the receipt.
  assert.deepEqual(await mod.attestFrame(frame,{uid:501,issue:()=>assert.fail('not a human intent')}),frame);
});
test('packaged provenance refuses code injection switches and development URLs',()=>{
  assert.equal(typeof mod.assertTrustedStartup,'function');
  assert.throws(()=>mod.assertTrustedStartup(true,['app','--remote-debugging-port=9222'],{}));
  assert.throws(()=>mod.assertTrustedStartup(true,['app','-remote-debugging-port=9222'],{},'win32'));
  for(const name of ['apex_daemon_bin','Apex_Deck_Dev_Url','electron_run_as_node','node_options'])assert.throws(()=>mod.assertTrustedStartup(true,['app'],{[name]:'x'},'win32'),undefined,name);
  assert.doesNotThrow(()=>mod.assertTrustedStartup(true,['app'],{apex_deck_data_dir:'/iso'},'win32'));
  assert.throws(()=>mod.assertTrustedStartup(true,['app','/remote-debugging-port=9222'],{},'win32'));
  assert.doesNotThrow(()=>mod.assertTrustedStartup(true,['app','C:\\work\\project'],{},'win32'));
  assert.throws(()=>mod.assertTrustedStartup(true,['app'],{APEX_DECK_DEV_URL:'http://localhost:5173'}));
  assert.throws(()=>mod.assertTrustedStartup(true,['app'],{NODE_OPTIONS:'--require=/tmp/x'}));
  assert.doesNotThrow(()=>mod.assertTrustedStartup(true,['app'],{APEX_DECK_DATA_DIR:'/tmp/isolated-apex'}));
  assert.throws(()=>mod.assertTrustedStartup(true,['app'],{APEX_DECK_DATA_DIR:'relative'}));
  assert.doesNotThrow(()=>mod.assertTrustedStartup(false,['app'],{APEX_DECK_DEV_URL:'http://localhost:5173'}));
});

test('only the exact inert Windows installer update marker is accepted',()=>{
  assert.doesNotThrow(()=>mod.assertTrustedStartup(true,['app','--updated'],{},'win32'));
  for (const flag of ['--updated=true','--Updated','-updated','/updated','--remote-debugging-port=9222']) {
    assert.throws(()=>mod.assertTrustedStartup(true,['app',flag],{},'win32'),undefined,flag);
  }
  assert.throws(()=>mod.assertTrustedStartup(true,['app','--updated','--remote-debugging-port=9222'],{},'win32'));
  for (const platform of ['darwin','linux']) assert.throws(()=>mod.assertTrustedStartup(true,['app','--updated'],{},platform));
  assert.throws(()=>mod.assertTrustedStartup(true,['app','--updated'],{APEX_UPDATE_FILE:'C:/cache/update.exe'},'win32'),'temporary updater variables remain forbidden in the app');
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

test('legacy import apply is a protected UI intent; its preview and history are not',async()=>{
  assert.ok(mod.protectedCommands.has('legacy_import_apply'));
  assert.ok(!mod.protectedCommands.has('legacy_import_preview'));
  assert.ok(!mod.protectedCommands.has('legacy_import_history'));
  const {publicKey,privateKey}=generateKeyPairSync('ed25519');
  const raw=publicKey.export({type:'spki',format:'der'}).subarray(-32);
  const frame={id:9,cmd:'legacy_import_apply',args:{snapshot:'20261022-101501',sources:{'assistant-tasks-v1.json':'ab'}}};
  let issued;
  const result=await mod.attestFrame(frame,{dataDir:'/data',uid:501,publicKey:raw,issue:async request=>{
    issued=request.command;
    const payload=JSON.stringify({domain:'apex-provenance-v1',kind:'submission',receipt:{uid:501,dataDir:'/data',command:issued,key:'k'}});
    return {payload,signature:sign(null,Buffer.from(payload),privateKey).toString('base64')};
  }});
  assert.equal(result.cmd,'provenance_execute');
  assert.deepEqual(issued.args,frame.args);
  assert.match(issued.provenanceRequestId,/^[a-f0-9-]{36}$/);
  const preview={id:10,cmd:'legacy_import_preview',args:{}};
  assert.deepEqual(await mod.attestFrame(preview,{uid:501,issue:()=>assert.fail('preview is read-only')}),preview);
});

test('explicit project delegation is signed with its exact brief, worker and project',async()=>{
  assert.ok(mod.protectedCommands.has('personal_project_delegate_ui'));
  const {publicKey,privateKey}=generateKeyPairSync('ed25519');
  const raw=publicKey.export({type:'spki',format:'der'}).subarray(-32);
  const frame={id:11,cmd:'personal_project_delegate_ui',args:{assistantId:'a',project:{hostId:'host',workspaceId:'w',cwd:'/repo'},sourceEventId:'',delegationId:'d',brief:'Inspect login',destination:{threadId:'thread',workers:['worker'],newThread:false},mode:'read_only',expectedRevision:3}};
  let issued;
  const result=await mod.attestFrame(frame,{dataDir:'/data',uid:501,publicKey:raw,issue:async request=>{
    issued=request.command;
    const payload=JSON.stringify({domain:'apex-provenance-v1',kind:'submission',receipt:{uid:501,dataDir:'/data',command:issued,key:'k'}});
    return {payload,signature:sign(null,Buffer.from(payload),privateKey).toString('base64')};
  }});
  assert.equal(result.cmd,'provenance_execute');
  assert.equal(issued.cmd,'personal_project_delegate_ui');
  assert.deepEqual(issued.args,frame.args);
});

test('task actions use stable distinct action-qualified submissions at the same task revision',async()=>{
 const {publicKey,privateKey}=generateKeyPairSync('ed25519');const raw=publicKey.export({type:'spki',format:'der'}).subarray(-32);const issued=[];
 const signRequest=async request=>{issued.push(request.command);const payload=JSON.stringify({domain:'apex-provenance-v1',kind:'submission',receipt:{uid:501,dataDir:'/data',command:request.command,key:'k'}});return {payload,signature:sign(null,Buffer.from(payload),privateKey).toString('base64')};};
 for(const action of ['retry','cancel','retry'])await mod.attestFrame({id:20,cmd:'assistant_task_action',args:{taskId:'task-1',revision:2,action}},{dataDir:'/data',uid:501,publicKey:raw,issue:signRequest});
 assert.equal(issued[0].provenanceRequestId,'task-action:retry');assert.equal(issued[1].provenanceRequestId,'task-action:cancel');assert.deepEqual(issued[0],issued[2]);
});

test('only revised startup checks request the versioned content-bound submission format',async()=>{
 const {publicKey,privateKey}=generateKeyPairSync('ed25519');const raw=publicKey.export({type:'spki',format:'der'}).subarray(-32);const issued=[];
 const signRequest=async request=>{issued.push(request.command);const payload=JSON.stringify({domain:'apex-provenance-v1',kind:'submission',receipt:{uid:501,dataDir:'/data',command:request.command,key:'k'}});return {payload,signature:sign(null,Buffer.from(payload),privateKey).toString('base64')};};
 for(const action of ['revise_startup','approve']){
  const args={taskId:'task-1',revision:2,action,owner:{hostId:'host',workspaceId:'project',cwd:'/project',conversationId:'monitor'},mode:'isolated',destination:{threadId:'worker-a',workers:['worker'],newThread:false}};
  await mod.attestFrame({id:20,cmd:'assistant_task_action',args},{dataDir:'/data',uid:501,publicKey:raw,issue:signRequest});
  assert.deepEqual(issued.at(-1).args,args,'the entire submitted plan remains exactly signed');
 }
 assert.equal(issued[0].provenanceRequestId,'task-action:revise_startup:content-v1');
 assert.equal(issued[1].provenanceRequestId,'task-action:approve');
});

test('device grants and pairing approval bind exact installed UI receipts', async()=>{
  const {publicKey,privateKey}=generateKeyPairSync('ed25519');
  const raw=publicKey.export({type:'spki',format:'der'}).subarray(-32);
  for(const cmd of ['devices_add','devices_set_tier','devices_set_threads','pair_approve']) {
    const frame={id:1,cmd,args:{id:'phone',tier:'full'}};
    let issued;
    const result=await mod.attestFrame(frame,{dataDir:'/data',uid:501,publicKey:raw,issue:async request=>{
      issued=request.command;
      const payload=JSON.stringify({domain:'apex-provenance-v1',kind:'submission',receipt:{uid:501,dataDir:'/data',command:issued,key:'k'}});
      return {payload,signature:sign(null,Buffer.from(payload),privateKey).toString('base64')};
    }});
    assert.equal(result.cmd,'provenance_execute'); assert.equal(issued.cmd,cmd); assert.deepEqual(issued.args,frame.args);
  }
});

test('remote device management reaches the host while local Mac grants require attestation', () => {
  for (const cmd of ['devices_add', 'devices_set_tier', 'devices_set_threads', 'pair_approve']) {
    assert.equal(mod.needsAttestation(cmd, false), true, `${cmd} on this Mac`);
    assert.equal(mod.needsAttestation(cmd, true), false, `${cmd} on a remote host`);
  }
  assert.equal(mod.needsAttestation('assistant_message', true), true);
  assert.equal(mod.needsAttestation('room_create', true), false);
  assert.equal(mod.needsAttestation('room_create', false), true);
  assert.equal(mod.needsAttestation('devices_revoke', false), false);
});

test('malformed remote commands cannot crash the desktop admission route', () => {
  for (const cmd of [undefined, null, {}, []]) assert.equal(mod.needsAttestation(cmd, true), false);
});

test('Windows receipt admission uses native authority identity without a POSIX UID', async () => {
  const {publicKey, privateKey} = generateKeyPairSync('ed25519');
  const raw = publicKey.export({type:'spki',format:'der'}).subarray(-32);
  const frame = {id:81,cmd:'personal_send',args:{assistantId:'a',requestId:'windows-1',text:'hello'}};
  const options = {platform:'win32', uid:undefined, dataDir:'C:\\Users\\test\\AppData\\Roaming\\Apex Deck',
    identity:async () => ({uid:0, dataDir:'C:/Users/test/AppData/Roaming/Apex Deck', publicKey:raw.toString('base64')}),
    issue:async request => {
      const payload = JSON.stringify({domain:'apex-provenance-v1',kind:'submission',receipt:{uid:0,dataDir:request.dataDir,command:request.command,key:'k'}});
      return {payload,signature:sign(null,Buffer.from(payload),privateKey).toString('base64')};
    }};
  const result = await mod.attestFrame(frame, options);
  assert.equal(result.cmd,'provenance_execute');
  const payload = JSON.parse(result.args.receipt.payload);
  assert.equal(payload.receipt.dataDir,'C:/Users/test/AppData/Roaming/Apex Deck');
  await assert.rejects(mod.attestFrame(frame,{...options,identity:async()=>{throw new Error('untrusted authority key');}}),/untrusted authority key/);
});

test('Windows transport does not disclose a submission to an unauthenticated pipe', async () => {
  const net = await import('node:net');
  const {tmpdir} = await import('node:os');
  const path = await import('node:path');
  const endpoint = process.platform==='win32' ? `\\\\.\\pipe\\apex-auth-test-${process.pid}` : path.join('/tmp',`apex-auth-${process.pid}.sock`);
  const {publicKey,privateKey}=generateKeyPairSync('ed25519');
  const raw=publicKey.export({type:'spki',format:'der'}).subarray(-32);
  const received=[];
  const server=net.createServer(socket=>socket.on('data',data=>{
    received.push(JSON.parse(data.toString()));
    const payload=JSON.stringify({domain:'apex-provenance-v1',kind:'hello',nonce:'wrong-challenge'});
    socket.write(JSON.stringify({payload,signature:sign(null,Buffer.from(payload),privateKey).toString('base64')})+'\n');
  }));
  await new Promise(resolve=>server.listen(endpoint,resolve));
  try{
    await assert.rejects(mod.issue({op:'issue',command:{text:'private human text'}},{endpoint,platform:'win32',publicKey:raw}),/challenge|authentication/i);
    assert.equal(received.length,1);
    assert.equal(received[0].op,'hello');
    assert.equal(received[0].command,undefined);
  }finally{await new Promise(resolve=>server.close(resolve));}
});

test('Windows transport authenticates the pipe before delivering an exactly bound receipt', async () => {
  const net=await import('node:net');const {tmpdir}=await import('node:os');const path=await import('node:path');
  const endpoint=process.platform==='win32'?`\\\\.\\pipe\\apex-auth-success-${process.pid}`:path.join('/tmp',`apex-auth-ok-${process.pid}.sock`);
  const {publicKey,privateKey}=generateKeyPairSync('ed25519');const raw=publicKey.export({type:'spki',format:'der'}).subarray(-32);
  const seen=[];
  const server=net.createServer(socket=>{
    let buffer='';socket.on('data',data=>{buffer+=data;while(buffer.includes('\n')){
      const end=buffer.indexOf('\n');const request=JSON.parse(buffer.slice(0,end));buffer=buffer.slice(end+1);seen.push(request.op);
      const value=request.op==='hello'?{domain:'apex-provenance-v1',kind:'hello',nonce:request.nonce}:{domain:'apex-provenance-v1',kind:'submission',receipt:{uid:0,dataDir:request.dataDir,command:request.command,key:'k'}};
      const payload=JSON.stringify(value);socket.write(JSON.stringify({payload,signature:sign(null,Buffer.from(payload),privateKey).toString('base64')})+'\n');
    }});
  });
  await new Promise(resolve=>server.listen(endpoint,resolve));
  try{
    const frame={id:82,cmd:'personal_send',args:{assistantId:'a',requestId:'win-2',text:'hello'}};
    const result=await mod.attestFrame(frame,{platform:'win32',dataDir:'C:/data',identity:async()=>({uid:0,dataDir:'C:/data',publicKey:raw.toString('base64')}),issue:(request,options)=>mod.issue(request,{...options,endpoint})});
    assert.deepEqual(seen,['hello','issue']);assert.equal(result.cmd,'provenance_execute');
    assert.deepEqual(JSON.parse(result.args.receipt.payload).receipt.command,{cmd:'personal_send',args:frame.args});
  }finally{await new Promise(resolve=>server.close(resolve));}
});

test('update requests carry only the package facts and accept only a matching signed receipt', async () => {
  const {publicKey,privateKey}=generateKeyPairSync('ed25519');
  const raw=publicKey.export({type:'spki',format:'der'}).subarray(-32);
  const update={version:'0.9.1',package:'/Users/a/Library/Caches/dev.apexdeck.desktop/updates/0.9.1/Apex-Deck-0.9.1-arm64.pkg',sha256:'f'.repeat(64),size:42};
  const id='12345678-1234-4234-8234-123456789abc';
  const reply=(fields)=>{const payload=JSON.stringify({domain:'apex-provenance-v1',kind:'update',uid:501,id,version:'0.9.1',...fields});return {payload,signature:sign(null,Buffer.from(payload),privateKey).toString('base64')};};
  let sent;
  assert.equal(await mod.requestUpdate(update,{uid:501,publicKey:raw,issue:async(request)=>{sent=request;return reply({});}}),id);
  assert.deepEqual(sent,{op:'update_install',...update});
  for (const fields of [{uid:502},{version:'0.9.2'},{kind:'submission'},{id:'../../x'}]) {
    await assert.rejects(mod.requestUpdate(update,{uid:501,publicKey:raw,issue:async()=>reply(fields)}));
  }
  const forged=reply({});forged.payload=forged.payload.replace('0.9.1','0.9.1 ');
  await assert.rejects(mod.requestUpdate(update,{uid:501,publicKey:raw,issue:async()=>forged}),/signature/);
  await assert.rejects(mod.requestUpdate(update,{uid:501,publicKey:raw,issue:async()=>{throw new Error('Only the installed Apex Deck app can install updates');}}),/installed Apex Deck/);
});

test('permanent project task deletion requires exact UI attestation',()=>{
  assert.equal(mod.needsAttestation('project_task_lifecycle'),true);
  assert.equal(mod.needsAttestation('project_task_lifecycle',true),true);
});

test('human todo edits require protected UI attestation',()=>{
  assert.equal(mod.needsAttestation('personal_todo'),true);
});

test('handoff selections and controls attest one stable request and reject changed signed bindings',async()=>{
  const {publicKey,privateKey}=generateKeyPairSync('ed25519');
  const raw=publicKey.export({type:'spki',format:'der'}).subarray(-32);
  const response=command=>{const payload=JSON.stringify({domain:'apex-provenance-v1',kind:'submission',receipt:{uid:501,dataDir:'/data',command,key:'k'}});return {payload,signature:sign(null,Buffer.from(payload),privateKey).toString('base64')};};
  for(const cmd of ['personal_handoff_select','personal_handoff_control']){
    const frame={id:91,cmd,args:{assistantId:'a',requestId:'handoff-1',taskId:'task-1',expectedTaskRevision:7,action:'stop'}};
    const issued=[];
    const options={dataDir:'/data',uid:501,publicKey:raw,issue:async r=>{issued.push(r.command);return response(r.command);}};
    const first=await mod.attestFrame(frame,options),second=await mod.attestFrame(frame,options);
    assert.equal(first.cmd,'provenance_execute');
    assert.deepEqual(issued[0],issued[1],'retry uses same signed request identity');
    assert.equal(issued[0].provenanceRequestId,undefined);
    assert.deepEqual(first,second);
    await assert.rejects(mod.attestFrame(frame,{...options,issue:async r=>response({...r.command,args:{...r.command.args,assistantId:'other'}})}),/does not match/);
  }
});


test('shared agent, provider setup, and backend lifecycle intents bind exact protected submissions', async () => {
  const {publicKey,privateKey}=generateKeyPairSync('ed25519');
  const raw=publicKey.export({type:'spki',format:'der'}).subarray(-32);
  const response=command=>{const payload=JSON.stringify({domain:'apex-provenance-v1',kind:'submission',receipt:{uid:501,dataDir:'/data',command,key:'k'}});return {payload,signature:sign(null,Buffer.from(payload),privateKey).toString('base64')};};
  for (const [cmd,args] of [
    ['agent_profile_save',{handle:'null',name:'Null',provider:'codex',instructions:'shared agent',access:'ask',expectedRevision:2}],
    ['provider_setup_begin',{provider:'codex',method:'reuse'}],
    ['backend_stop',{bootId:'shared-boot'}],
  ]) {
    assert.equal(mod.needsAttestation(cmd,false),true,cmd);
    const frame={id:51,cmd,args};
    const result=await mod.attestFrame(frame,{dataDir:'/data',uid:501,publicKey:raw,issue:async request=>{
      assert.equal(request.command.cmd,cmd);
      assert.deepEqual(request.command.args,args);
      assert.match(request.command.provenanceRequestId,/^[a-f0-9-]{36}$/);
      return response(request.command);
    }});
    assert.equal(result.cmd,'provenance_execute');
    await assert.rejects(mod.attestFrame(frame,{dataDir:'/data',uid:501,publicKey:raw,issue:async request=>response({...request.command,args:{...args,substituted:true}})}),/Receipt does not match/);
  }
});
