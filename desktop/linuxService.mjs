import {linuxIdentity, issue, protectedPublicKey} from './provenance.mjs';
import {channel} from './channel.mjs';
import {randomBytes, createPublicKey, verify} from 'node:crypto';
import path from 'node:path';

export async function resolveLinuxLaunch({plan,bundle,identity=linuxIdentity,dataDir,wait=ms=>new Promise(resolve=>setTimeout(resolve,ms))}) {
  if(!plan.protectedInstallationDetected)return plan;
  try {
    let scope;
    // A restarting engine can still be loading its protected documents when
    // the broker first probes it. Yield between read-only discovery attempts
    // so startup can make progress; no submission or launch is replayed.
    for(let attempt=0;attempt<12;attempt++) {
      try { scope=await identity({dataDir});break; }
      catch(error) {
        if(attempt===11 || !['Installed daemon readiness probe failed','Installed daemon readiness probe timed out'].includes(error.message))throw error;
        await wait(500);
      }
    }
    if(scope.role==='app') {
      if(bundle!==path.posix.join(scope.tree,'resources/app.asar'))throw new Error('The supervised UI does not match the installed bundle.');
      return {...plan,kind:'run',daemon:path.posix.join(scope.tree,'resources/bin/apex-daemon'),dataDir:scope.dataDir,scope,protectedSubmissionError:undefined,notice:undefined};
    }
    return {...plan,kind:'handoff',scope,app:scope.tree};
  }catch(error){
    const reason=`Protected Linux installation requires repair: ${error.message}`;
    return {...plan,kind:'notice',protectedSubmissionError:reason,notice:{message:'Protected Linux service could not be verified',detail:reason}};
  }
}

export async function launchLinuxUI({scope,env=process.env,send=issue,publicKey=protectedPublicKey({platform:'linux'})}) {
  const nonce=randomBytes(16).toString('hex');
  const environment=Object.fromEntries(['DISPLAY','WAYLAND_DISPLAY','XAUTHORITY','XDG_SESSION_TYPE'].filter(name=>env[name]).map(name=>[name,env[name]]));
  const signed=await send({op:'launch',role:'app',nonce,environment},{publicKey,platform:'linux'});
  const key=createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),publicKey]),type:'spki',format:'der'});
  if(typeof signed?.payload!=='string' || Buffer.byteLength(signed.payload)>1024*1024 || typeof signed.signature!=='string' || !verify(null,Buffer.from(signed.payload),key,Buffer.from(signed.signature,'base64')))throw new Error('Invalid installed UI launch signature.');
  const reply=JSON.parse(signed.payload);
  if(reply.domain!==channel.DOMAIN || reply.kind!=='linux-launch' || reply.nonce!==nonce || reply.uid!==scope.uid || reply.role!=='app' || reply.epoch!==scope.epoch || !Number.isSafeInteger(reply.pid) || reply.pid<=0)throw new Error('Installed UI launch response mismatch.');
  return '';
}

export async function linuxLocalDaemon({ plan, startPortable, identity=linuxIdentity }) {
  if (plan.protectedInstallationDetected) {
    if(plan.scope?.role==='app' && !plan.protectedSubmissionError) {
      const current=await identity({dataDir:plan.dataDir});
      for(const field of ['uid','dataDir','tree','epoch','manifestSha256','brokerInstance'])if(current[field]!==plan.scope[field])throw new Error('Installed Linux scope changed; relaunch the UI.');
      if(current.role!=='app' || current.daemonPid===null)throw new Error('Installed Linux engine is unavailable; repair the service.');
      return {socket:current.daemonEndpoint,owned:false,child:null,alive:()=>true,stop:async()=>{}};
    }
    throw new Error(plan.protectedSubmissionError);
  }
  return startPortable();
}
