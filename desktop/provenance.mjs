// Exact UI commands go to a separate root service. Full-access shells retain
// their ordinary daemon tools but cannot make a submission count as human.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { createPublicKey, verify, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
export const ROOT='/Library/Application Support/Apex Deck Provenance';
export const SOCKET='/var/run/dev.apexdeck.provenance.sock';
const LIMIT=1024*1024;
export const protectedCommands=new Set(['assistant_message','assistant_task_action','personal_send','personal_decide','room_post','room_post_to','room_turn','room_decide','room_answer','personal_create','personal_configure','personal_workspace_configure','personal_project_delegate','personal_project_delegate_ui','personal_avatar_generate','personal_avatar_cancel','personal_rule_add','personal_rule_remove','personal_machine_link','personal_machine_unlink','personal_machine_claim','personal_machine_allow','personal_pause','personal_cancel','personal_task_lifecycle','personal_archive','personal_reply_cancel','personal_schedule_cancel','room_create','room_import','room_fork','chat_promote','room_update_participant','room_add_participant','room_remove_participant','room_set_options','room_forget_allowed','room_set_plan','room_runner_start','room_runner_action','room_mount','personal_memory_add','personal_memory_correct','personal_memory_forget','project_memory_save','project_memory_forget','project_memory_stage','project_memory_promote','legacy_import_apply','devices_add','devices_set_tier','devices_set_threads','pair_approve']);

// A remote host enforces its own grant boundary. Linux accepts its existing
// local/SSH administration; a remote Mac still rejects unsigned grant changes.
// Broker failure on this Mac never changes whether attestation is required.
export function needsAttestation(cmd, remote = false) {
  if (typeof cmd !== 'string') return false;
  if (remote && (cmd.startsWith('room_') || ['chat_promote', 'devices_add', 'devices_set_tier', 'devices_set_threads', 'pair_approve'].includes(cmd))) return false;
  return protectedCommands.has(cmd);
}

export function assertTrustedStartup(packaged,argv,env){
  if (!packaged) return;
  const badEnv=Object.keys(env).some(k=>((k.startsWith('APEX_') && k!=='APEX_DECK_DATA_DIR') || k.startsWith('ELECTRON_') || k==='NODE_OPTIONS' || k.startsWith('DYLD_')) && env[k]);
  // Packaged trusted UI has no developer-command or URL escape hatch. Only
  // ordinary file/open event arguments and approved OS launch flags are allowed.
  if(env.APEX_DECK_DATA_DIR && !path.isAbsolute(env.APEX_DECK_DATA_DIR)) throw new Error('Apex data directory must be absolute.');
  const badArg=argv.slice(1).some(a=>a.startsWith('--') && !['--allow-file-access-from-files'].includes(a));
  if(badEnv || badArg) throw new Error('Trusted Apex UI refuses development overrides and runtime switches. Use a development build for diagnostics.');
}

function publicKey(){
  const file=path.join(ROOT,'public-key');
  for(let p=file;;p=path.dirname(p)){
    const st=fs.lstatSync(p);
    if(st.isSymbolicLink() || st.uid!==0 || (st.mode&0o022)) throw new Error('Provenance key must be protected by root ownership.');
    if(p==='/')break;
  }
  const bytes=fs.readFileSync(file);
  if(bytes.length!==32)throw new Error('Invalid protected provenance public key.');
  return bytes;
}
export function issue(request){
  return new Promise((resolve,reject)=>{
    const client=net.createConnection(SOCKET);let bytes=Buffer.alloc(0);let done=false;
    const finish=(error,value)=>{if(done)return;done=true;client.destroy();error?reject(error):resolve(value);};
    client.setTimeout(30000,()=>finish(new Error('Protected provenance service timed out.')));
    client.on('error',()=>finish(new Error('Protected provenance service unavailable. Submission was not sent.')));
    client.on('close',()=>{if(!done)finish(new Error('Protected provenance service closed without a receipt.'));});
    client.on('connect',()=>{const line=JSON.stringify(request)+'\n';if(Buffer.byteLength(line)>LIMIT)return finish(new Error('Submission exceeds provenance limit.'));client.write(line);});
    client.on('data',chunk=>{
      bytes=Buffer.concat([bytes,chunk]);if(bytes.length>LIMIT)return finish(new Error('Oversized provenance response.'));
      if(bytes.includes(10))try{const result=JSON.parse(bytes.subarray(0,bytes.indexOf(10)));if(result.error)throw new Error(result.error);finish(null,result);}catch(error){finish(error);}
    });
  });
}
export async function attestFrame(frame,{dataDir,uid=process.getuid(),publicKey:rawKey,issue:send=issue}={}){
  if(!protectedCommands.has(frame.cmd))return frame;
  const command={cmd:frame.cmd,args:frame.args??{}};
  if(frame.cmd==='assistant_task_action') command.provenanceRequestId=command.args.action==='revise_startup'?'task-action:revise_startup:content-v1':`task-action:${command.args.action}`;
  else if(!['assistant_message','personal_send','personal_decide'].includes(frame.cmd)) command.provenanceRequestId=randomUUID();
  const key=rawKey??publicKey();
  const signed=await send({op:'issue',dataDir,command});
  if(typeof signed?.payload!=='string' || Buffer.byteLength(signed.payload)>LIMIT || typeof signed.signature!=='string')throw new Error('Invalid provenance response.');
  const spki=Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),key]);
  if(!verify(null,Buffer.from(signed.payload),createPublicKey({key:spki,type:'spki',format:'der'}),Buffer.from(signed.signature,'base64')))throw new Error('Invalid provenance signature.');
  const payload=JSON.parse(signed.payload),receipt=payload.receipt;
  if(payload.domain!=='apex-provenance-v1' || payload.kind!=='submission' || receipt?.uid!==uid || receipt.dataDir!==dataDir || !isDeepStrictEqual(receipt.command,command))throw new Error('Receipt does not match the submitted command.');
  return {id:frame.id,cmd:'provenance_execute',args:{receipt:signed}};
}

// "Restart to update": the broker queues the request for the root update job,
// which checks the package again itself (scripts/upgrade.py). Resolves the
// job's id once the broker has signed for it.
export async function requestUpdate(update,{uid=process.getuid(),publicKey:rawKey,issue:send=issue}={}){
  const request={op:'update_install',version:update.version,package:update.package,sha256:update.sha256,size:update.size};
  const key=rawKey??publicKey();
  const signed=await send(request);
  if(typeof signed?.payload!=='string' || Buffer.byteLength(signed.payload)>LIMIT || typeof signed.signature!=='string')throw new Error('Invalid response from the protected service.');
  const spki=Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),key]);
  if(!verify(null,Buffer.from(signed.payload),createPublicKey({key:spki,type:'spki',format:'der'}),Buffer.from(signed.signature,'base64')))throw new Error('Invalid provenance signature.');
  const payload=JSON.parse(signed.payload);
  if(payload.domain!=='apex-provenance-v1' || payload.kind!=='update' || payload.uid!==uid || payload.version!==update.version || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(payload.id ?? ''))throw new Error('The protected service did not accept this update.');
  return payload.id;
}
