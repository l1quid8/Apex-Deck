#!/usr/bin/env node
// Reproducible packaged network gate. No production build or installed app runs.
// node desktop/generated-ui/security-network.mjs --app '/path/Apex Deck.app'
//   --ssh-target apex-terminal --address 95.179.145.4 [--evidence-dir /tmp/...]
// The source app must contain the reviewed production app.asar. A preexisting
// instrumented gate copy is accepted only when its app-production.asar exists.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import https from 'node:https';
import { fileURLToPath } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import * as asar from '@electron/asar';
import { decodeNetworkCapture, dnsBootstrapConnections } from './security-network-pcap.mjs';
const exec=promisify(execFile), here=path.dirname(fileURLToPath(import.meta.url)), repo=path.resolve(here,'../..');
const args=process.argv.slice(2), option=(name,fallback)=>{const index=args.indexOf(name);return index>=0?args[index+1]:fallback;};
const sourceApp=option('--app');
const suppliedArchive=option('--production-asar');
if(!sourceApp)throw Error('--app must identify an existing packaged app, not the installed Deck instance');
const target=option('--ssh-target','apex-terminal'),address=option('--address','95.179.145.4');
if(!/^[a-zA-Z0-9._@-]+$/.test(target)||!/^\d+\.\d+\.\d+\.\d+$/.test(address))throw Error('Invalid controlled endpoint target');
const root=option('--evidence-dir',fs.mkdtempSync(path.join(os.tmpdir(),'apex-generated-network-')));
fs.mkdirSync(root,{recursive:true});
const shellQuote=value=>"'"+value.replaceAll("'","'\\''")+"'";
const sshArgs=['-T','-o','RemoteCommand=none','-o','RequestTTY=no','-o','BatchMode=yes','-o','ConnectTimeout=10',target];
const env={...process.env};
if(!env.SSH_AUTH_SOCK){const result=await exec('launchctl',['getenv','SSH_AUTH_SOCK']).catch(()=>({stdout:''}));if(result.stdout.trim())env.SSH_AUTH_SOCK=result.stdout.trim();}
const ssh=async command=>(await exec('ssh',[...sshArgs,command],{env,maxBuffer:8*1024*1024})).stdout;
const copy=async (from,to)=>exec('scp',['-o','RemoteCommand=none','-o','RequestTTY=no',from,to],{env,maxBuffer:2*1024*1024});
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const manifest={sourceApp:path.resolve(sourceApp),root,startedAt:new Date().toISOString(),instrumentation:'Temporary app copy. Reviewed archive retained; test main only. Original binaries remain unchanged. Resource signature of copy is not valid and is not re-signed.',files:[],limitations:[]};
let remote,endpoint,pcapPid,appCopy,remoteServerPid,runtimeProcess;
const firewallRules=[];
function write(name,value){fs.writeFileSync(path.join(root,name),typeof value==='string'?value:JSON.stringify(value,null,2));}
async function pause(ms){await new Promise(resolve=>setTimeout(resolve,ms));}
async function poll(command,timeout=20000){const until=Date.now()+timeout;while(Date.now()<until){try{return await ssh(command);}catch{await pause(250);}}throw Error('Temporary endpoint startup timed out');}
async function killManaged(pid,signalName='SIGTERM',privileged=false){
  if(!/^\d+$/.test(String(pid)))return {pid,state:'invalid'};
  const program="import os,signal,sys,json; p=int(sys.argv[1]); root=sys.argv[2].encode(); signal_name=sys.argv[3]; file='/proc/'+str(p)+'/cmdline'; command=open(file,'rb').read() if os.path.exists(file) else b''; matched=bool(command) and root in command; os.kill(p,getattr(signal,signal_name)) if matched else None; print(json.dumps({'pid':p,'state':'signalled' if matched else 'identity-mismatch' if command else 'absent'}))";
  return JSON.parse(await ssh((privileged?'sudo -n ':'')+'python3 -c '+shellQuote(program)+' '+pid+' '+shellQuote(remote)+' '+shellQuote(signalName)));
}
async function readRemoteReceipts(){const value=await ssh('cat '+shellQuote(remote+'/receipts.jsonl'));return value.trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));}
function incomingPacket(line,endpoint,client){
  const match=line.match(/^(\d+\.\d+) (?:.*? )?IP (\S+) > (\S+): (.*)$/);
  if(!match)return null;
  const [,seconds,source,destination,details]=match;
  const sourceHost=source.slice(0,source.lastIndexOf('.')),destHost=destination.slice(0,destination.lastIndexOf('.'));
  const sourcePort=Number(source.slice(source.lastIndexOf('.')+1)),destPort=Number(destination.slice(destination.lastIndexOf('.')+1));
  if(sourceHost!==client||destHost!==endpoint.address)return null;
  return {at:Number(seconds)*1000,sourceHost,destHost,sourcePort,destPort,protocol:details.startsWith('UDP')?'udp':'tcp',details};
}
function summarize(runtime,receipts,packets,wire,bootstrap,captureHealth){
  const clock=manifest.clockCalibration;
  receipts=receipts.map(r=>({...r,remoteAt:r.at,at:r.at-clock.offsetMs}));
  packets=packets.map(r=>({...r,remoteAt:r.at,at:r.at-clock.offsetMs}));
  wire=wire.map(r=>({...r,remoteAt:r.at,at:r.at-clock.offsetMs}));
  const infrastructurePorts=new Set(receipts.filter(r=>r.kind==='authoritative-dns'&&r.resolverLiveness).map(r=>r.peerPort));
  const attribution=[];
  for(const connection of bootstrap){
    if(connection.remote!==endpoint.address+':'+endpoint.https)continue;
    if(connection.local){const port=Number(connection.local.split(':').at(-1));infrastructurePorts.add(port);attribution.push({...connection,peerPort:port,method:'netlog dns_bootstrap group and socket local address'});}
  }
  const infrastructureReceipt=r=>r.resolverLiveness||(r.kind==='tcp-accept'&&r.port===endpoint.https&&infrastructurePorts.has(r.peerPort))||(r.kind==='quic-event'&&r.event==='ConnectionTerminated');
  const infrastructurePacket=p=>p.protocol==='tcp'&&p.destPort===endpoint.https&&infrastructurePorts.has(p.sourcePort);
  const phases=runtime.phases.map(phase=>{
    const allReceipts=receipts.filter(r=>r.at>=phase.start-clock.uncertaintyMs&&r.at<=phase.end+clock.uncertaintyMs&&r.kind!=='started');
    const allPackets=packets.filter(r=>r.at>=phase.start-clock.uncertaintyMs&&r.at<=phase.end+clock.uncertaintyMs);
    const independent=allReceipts.filter(r=>!infrastructureReceipt(r));
    const observed=allPackets.filter(p=>!infrastructurePacket(p));
    const local=runtime.localReceipts.filter(r=>r.at>=phase.start&&r.at<=phase.end);
    return {...phase,independentReceipts:independent,packets:observed,localReceipts:local,instrumentationReceipts:allReceipts.filter(infrastructureReceipt),instrumentationPackets:allPackets.filter(infrastructurePacket)};
  });
  const positive=phases.find(p=>p.name==='positive'),header=phases.find(p=>p.name==='header-only');
  const runtimePositive=runtime.probes.find(p=>p.name==='positive');
  const allPositiveReceipts=phases.filter(p=>['positive','ordinary-positive','ordinary-form-positive','http-positive'].includes(p.name)).flatMap(p=>p.independentReceipts).filter(receipt=>receipt.peer===manifest.clientPublicIPv4);
  const vectorPaths=['fetch','xhr','beacon','image.png','module.js','import.css','background.png','font.woff2','font-api.woff2','image.svg','use.svg','ws','redirect/start','redirect-final/start','worker.js','inside-blob-worker','nested-remote','nested-srcdoc.png','location','anchor','form'];
  const vectorControls=Object.fromEntries(vectorPaths.map(vector=>[vector,allPositiveReceipts.some(r=>r.path?.split('?')[0].endsWith('/'+vector))]));
  const requirements={
    captureHealthy:captureHealth.listening&&captureHealth.dropped===0&&captureHealth.captured>0&&captureHealth.stop?.state==='signalled',
    finalCaptureWitness:phases.find(p=>p.name==='sensor-preconnect')?.packets.some(p=>p.protocol==='tcp'&&p.destPort===endpoint.https&&p.details.includes('Flags [S')),
    clockBounded:clock.uncertaintyMs<500,
    externalHTTP:positive?.independentReceipts.some(r=>r.kind==='http'&&r.path?.includes('/positive/')&&r.peer===manifest.clientPublicIPv4),
    externalHTTPS:positive?.independentReceipts.some(r=>r.kind==='https'&&r.path?.includes('/positive/')&&r.peer===manifest.clientPublicIPv4),
    authoritativeDNS:positive?.independentReceipts.some(r=>r.kind==='authoritative-dns'&&r.name.includes('fetch-positive')&&r.peer===manifest.clientPublicIPv4),
    dnsPrefetch:positive?.independentReceipts.some(r=>r.kind==='authoritative-dns'&&r.name.includes('dns-prefetch-positive')&&r.peer===manifest.clientPublicIPv4),
    rendererPreconnectEvent:runtime.preconnectEvents?.some(r=>r.url.includes('preconnect-positive')),
    preconnectSensorDNS:phases.find(p=>p.name==='sensor-preconnect')?.independentReceipts.some(r=>r.kind==='authoritative-dns'&&r.name.includes('sensor-preconnect')),
    externalWebsocket:positive?.independentReceipts.some(r=>r.kind==='websocket'&&r.peer===manifest.clientPublicIPv4),
    webtransport:positive?.independentReceipts.some(r=>r.kind==='webtransport-connect'&&r.peer===manifest.clientPublicIPv4)&&runtimePositive?.result.attempts.some(r=>r.name==='webtransport'&&r.ready),
    turnUDP:positive?.packets.some(p=>p.protocol==='udp'&&p.destPort===endpoint.turn),
    turnTCP:positive?.packets.some(p=>p.protocol==='tcp'&&p.destPort===endpoint.turn),
    stunBindingUDP:wire.some(p=>p.at>=positive.start&&p.at<=positive.end&&p.protocol==='udp'&&p.stunType==='0001'&&p.destPort===endpoint.turn),
    turnAllocateUDP:wire.some(p=>p.at>=positive.start&&p.at<=positive.end&&p.protocol==='udp'&&p.stunType==='0003'&&p.destPort===endpoint.turn),
    turnAllocateTCP:wire.some(p=>p.at>=positive.start&&p.at<=positive.end&&p.protocol==='tcp'&&p.stunType==='0003'&&p.destPort===endpoint.turn),
    relayedDataChannel:runtimePositive?.result.dataChannel.received==='synthetic-positive',
    localHTTP4:positive?.localReceipts.some(r=>r.kind==='http'&&r.host==='127.0.0.1'),
    localHTTP6:positive?.localReceipts.some(r=>r.kind==='http'&&r.host==='::1'),
    localHTTPS4:positive?.localReceipts.some(r=>r.kind==='https'&&r.host==='127.0.0.1'),
    localHTTPS6:positive?.localReceipts.some(r=>r.kind==='https'&&r.host==='::1'),
    localSTUN6:positive?.localReceipts.some(r=>r.kind==='stun6'&&r.magic==='2112a442'&&r.messageType==='0001'),
    localTURN6TCP:positive?.localReceipts.some(r=>r.kind==='turn6-tcp'&&r.magic==='2112a442'&&r.messageType==='0003'),
    packetTCP:positive?.packets.some(p=>p.protocol==='tcp'),packetUDP:positive?.packets.some(p=>p.protocol==='udp'),
    perVectorReceipts:Object.values(vectorControls).every(Boolean),
  };
  // Ignore final teardown packets (FIN/RST/ACK) from positive sockets. Any SYN,
  // payload-bearing TCP or UDP emitted during blocked phases is a failure.
  const emissions=p=>p.protocol==='udp'||p.details.includes('Flags [S')||/length [1-9]\d*/.test(p.details);
  const blocked=phases.filter(p=>p.name==='header-only'||p.name.startsWith('shipped'));
  const blockedResults=blocked.map(p=>{
    const nav=runtime.probes.find(probe=>probe.name===p.name);
    const invocationVerified=!p.name.startsWith('shipped-')||nav?.invoked===true&&nav.events.some(e=>e.type==='ready');
    return {name:p.name,invocationVerified,receipts:p.independentReceipts,local:p.localReceipts,emissions:p.packets.filter(emissions),passed:invocationVerified&&p.independentReceipts.length===0&&p.localReceipts.length===0&&!p.packets.some(emissions)};
  });
  const scopedArchivePassed=runtime.runtimeCompleted&&Object.values(requirements).every(Boolean)&&blockedResults.every(p=>p.passed);
  const releaseTargetMatch=manifest.files.filter(file=>Object.hasOwn(file,'matchesCurrentSource')).every(file=>file.matchesCurrentSource);
  return {packaged:runtime.packaged,versions:runtime.versions,archiveSha256:manifest.productionAsarSha256,releaseTargetMatch,canEnableCurrentSource:scopedArchivePassed&&releaseTargetMatch,scopedArchivePassed,captureHealth,clockCalibration:clock,positiveRequirements:requirements,positiveVectorReceipts:vectorControls,positiveControlsPassed:Object.values(requirements).every(Boolean),blockedResults,passed:scopedArchivePassed,phases,bootstrapAttribution:attribution,preconnect:{rendererEvents:runtime.preconnectEvents,implementation:'Electron 44.5.1 emits renderer preconnect as a session event without opening a connection. No probe listener forwards it. Trusted session.preconnect positive control proves DNS/TCP sensor detectability.'},limitations:['Process-scoped controlled DoH and synthetic certificate trust are probe instrumentation. Chromium DoH resolver liveness traffic is retained separately and correlated by TCP source port, never timestamp-only inference. Literal-IP early-teardown navigation phases disable only the probe-process DoH resolver. Default OS DNS path is not independently captured.', 'Remote capture covers configured IPv4 endpoint and TURN relay ports; IPv6 external routing is unavailable on this endpoint.', 'Loopback IPv4/IPv6 transport uses independent local listener accepts rather than privileged macOS BPF capture.'],sources:['https://developer.chrome.com/blog/connection-allowlist-announcement','https://wicg.github.io/connection-allowlists/','https://www.electronjs.org/docs/latest/api/net-log/','https://raw.githubusercontent.com/electron/electron/v44.5.1/shell/browser/network_hints_handler_impl.cc']};
}
try {
  console.log('Evidence: '+root);
  remote=(await ssh('mktemp -d /tmp/apex-generated-network.XXXXXX')).trim();
  if(!/^\/tmp\/apex-generated-network\.[a-zA-Z0-9]+$/.test(remote))throw Error('Unexpected temporary path');
  manifest.remoteTemporaryDirectory=remote;
  console.log('Preparing temporary controlled endpoints');
  await ssh('cd '+shellQuote(remote)+' && apt download coturn libhiredis1.1.0 libmysqlclient24 libpq5 libevent-extra-2.1-7t64 libevent-openssl-2.1-7t64 libevent-pthreads-2.1-7t64 >download.log 2>&1 && for pkg in *.deb; do dpkg-deb -x "$pkg" root; done && python3 -m venv venv && venv/bin/pip install -q aioquic >pip.log 2>&1');
  await copy(path.join(repo,'tests/fixtures/network-remote.py'),target+':'+remote+'/network-remote.py');
  remoteServerPid=(await ssh('nohup '+shellQuote(remote+'/venv/bin/python')+' '+shellQuote(remote+'/network-remote.py')+' '+shellQuote(remote)+' '+shellQuote(address)+' >'+shellQuote(remote+'/server.log')+' 2>&1 < /dev/null & echo $!')).trim();
  endpoint=JSON.parse(await poll('cat '+shellQuote(remote+'/config.json')));write('endpoint-config.json',endpoint);
  const sshPeer=(await ssh('printf "%s" "$SSH_CONNECTION"')).trim().split(' ')[0];
  if(!/^\d+\.\d+\.\d+\.\d+$/.test(sshPeer))throw Error('No SSH peer address for scoped temporary transport rules');
  const comment=path.basename(remote);
  for(const [transport,ports] of [['tcp',[endpoint.http,endpoint.https,endpoint.turn].join(',')],['udp',[endpoint.webtransport,endpoint.turn,'57000:57031'].join(',')]]){
    const rule='INPUT -s '+sshPeer+' -p '+transport+' -m multiport --dports '+ports+' -m comment --comment '+shellQuote(comment)+' -j ACCEPT';
    await ssh('sudo -n iptables -I '+rule);firewallRules.push(rule);
  }
  manifest.temporaryTransportRules=firewallRules;
  const clockSamples=[];
  for(let index=0;index<3;index++){const before=Date.now();const server=Number((await ssh('python3 -c '+shellQuote('import time; print(time.time()*1000)'))).trim());const after=Date.now();clockSamples.push({before,after,server,offsetMs:server-(before+after)/2,uncertaintyMs:(after-before)/2});}
  clockSamples.sort((a,b)=>a.uncertaintyMs-b.uncertaintyMs);
  manifest.clockCalibration={...clockSamples[0],samples:clockSamples};
  // This request proves reachability and yields the actual source address for
  // a capture filter that avoids all unrelated service traffic on the VPS.
  const client=await new Promise((resolve,reject)=>{const request=https.get('https://'+address+':'+endpoint.https+'/runner-control',{rejectUnauthorized:false},response=>{response.resume();resolve(response.headers['x-client-ip']);}).on('error',reject);request.setTimeout(10000,()=>request.destroy(Error('Controlled endpoint unavailable')));});
  if(!/^\d+\.\d+\.\d+\.\d+$/.test(client))throw Error('No controlled endpoint peer address');manifest.clientPublicIPv4=client;
  const filter='host '+client+' and (port '+endpoint.http+' or port '+endpoint.https+' or port '+endpoint.webtransport+' or port '+endpoint.turn+' or portrange 57000-57031)';
  manifest.packetCaptureFilter=filter;
  pcapPid=(await ssh('sudo -n sh -c '+shellQuote('nohup tcpdump -i any -U -nn -s 0 -w '+shellQuote(remote+'/packets.pcap')+' '+shellQuote(filter)+' >'+shellQuote(remote+'/capture.log')+' 2>&1 < /dev/null & echo $!'))).trim();
  if(!/^\d+$/.test(pcapPid))throw Error('Capture PID missing');
  await pause(500);
  appCopy=path.join(root,'Apex Deck.app');
  await exec('ditto',[path.resolve(sourceApp),appCopy]);
  const resources=path.join(appCopy,'Contents/Resources');
  const retained=path.join(resources,'app-production.asar');
  const original=suppliedArchive?path.resolve(suppliedArchive):fs.existsSync(retained)?retained:path.join(resources,'app.asar');
  if(suppliedArchive){fs.copyFileSync(original,retained);manifest.suppliedArchive=original;}
  else if(original!==retained)fs.renameSync(original,retained);
  manifest.productionAsarSha256=hash(retained);
  for(const relative of ['desktop/generated-ui/host.mjs','desktop/generated-ui/policy.mjs','desktop/generated-ui/frame-content.mjs','desktop/generated-ui/preload.cjs','desktop/generated-ui/protocol.mjs','shared/generatedCard.mjs','shared/generatedUiCapability.mjs','shared/generated-ui-runtime.json']){
    const shipped=asar.extractFile(retained,relative),source=fs.readFileSync(path.join(repo,relative));
    manifest.files.push({path:relative,packaged:crypto.createHash('sha256').update(shipped).digest('hex'),currentSource:crypto.createHash('sha256').update(source).digest('hex'),matchesCurrentSource:shipped.equals(source)});
  }
  for(const relative of ['Contents/MacOS/Apex Deck','Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework'])manifest.files.push({path:relative,source:hash(path.join(sourceApp,relative)),copy:hash(path.join(appCopy,relative))});
  const entry=path.join(root,'entry');fs.mkdirSync(entry);
  fs.copyFileSync(path.join(here,'security-network-runtime.mjs'),path.join(entry,'security-network-runtime.mjs'));
  fs.copyFileSync(path.join(repo,'tests/fixtures/network-vectors.mjs'),path.join(entry,'network-vectors.mjs'));
  fs.writeFileSync(path.join(entry,'package.json'),JSON.stringify({name:'apex-generated-network-probe',version:'0.7.0',type:'module',main:'security-network-runtime.mjs'}));
  await asar.createPackage(entry,path.join(resources,'app.asar'));
  await exec('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',path.join(root,'key.pem'),'-out',path.join(root,'cert.pem'),'-days','1','-subj','/CN=localhost']);
  write('artifact.json',manifest);
  console.log('Starting packaged runtime');
  const runtime=spawn(path.join(appCopy,'Contents/MacOS/Apex Deck'),['--evidence-dir',root,'--endpoint-config',path.join(root,'endpoint-config.json')],{env,stdio:['ignore','pipe','pipe']});runtimeProcess=runtime;
  let killTimeout;
  const runtimeTimeout=setTimeout(()=>{manifest.runtimeTimedOut=true;runtime.kill('SIGTERM');killTimeout=setTimeout(()=>runtime.kill('SIGKILL'),5000);},180000);
  const log=fs.createWriteStream(path.join(root,'runtime.log'));runtime.stdout.pipe(log);runtime.stderr.pipe(log);runtime.stdout.on('data',chunk=>process.stdout.write(chunk));
  const code=await new Promise(resolve=>runtime.once('exit',resolve));clearTimeout(runtimeTimeout);clearTimeout(killTimeout);runtimeProcess=null;manifest.runtimeExitCode=code;
  manifest.captureStop=await killManaged(pcapPid,'SIGINT',true);pcapPid=null;await pause(500);
  await ssh('sudo -n chown '+shellQuote('l1quid8:l1quid8')+' '+shellQuote(remote+'/packets.pcap'));
  await copy(target+':'+remote+'/packets.pcap',path.join(root,'packets.pcap'));
  await copy(target+':'+remote+'/receipts.jsonl',path.join(root,'remote-receipts.jsonl'));
  const decoded=await ssh('tcpdump -tt -nn -r '+shellQuote(remote+'/packets.pcap')+' 2>/dev/null');write('packets.txt',decoded);
  const packets=decoded.trim().split('\n').map(line=>incomingPacket(line,endpoint,client)).filter(Boolean);
  write('packet-observations.json',packets);
  const wire=decodeNetworkCapture(path.join(root,'packets.pcap'),endpoint,client);write('transport-observations.json',wire);
  const runtimeEvidence=JSON.parse(fs.readFileSync(path.join(root,'runtime-evidence.json'),'utf8'));
  const bootstrap=dnsBootstrapConnections(path.join(root,'netlog.json'));write('dns-bootstrap-connections.json',bootstrap);
  const captureLog=await ssh('cat '+shellQuote(remote+'/capture.log'));write('capture.log',captureLog);
  const captureHealth={listening:captureLog.includes('listening on'),captured:Number(captureLog.match(/(\d+) packets captured/)?.[1]),dropped:Number(captureLog.match(/(\d+) packets dropped by kernel/)?.[1]),stop:manifest.captureStop};
  const summary=summarize(runtimeEvidence,await readRemoteReceipts(),packets,wire,bootstrap,captureHealth);write('network-summary.json',summary);
  console.log(JSON.stringify({passed:summary.passed,positiveRequirements:summary.positiveRequirements,blocked:summary.blockedResults.map(p=>({name:p.name,passed:p.passed,receipts:p.receipts.length,emissions:p.emissions.length})),root},null,2));
  process.exitCode=summary.passed?0:1;
}catch(error){manifest.error=error.stack||String(error);write('runner-error.txt',manifest.error);console.error(manifest.error);process.exitCode=1;}
finally {
  if(runtimeProcess)runtimeProcess.kill('SIGTERM');
  if(pcapPid)await killManaged(pcapPid,'SIGINT',true).catch(()=>{});
  if(!endpoint&&remote)endpoint=await ssh('cat '+shellQuote(remote+'/processes.json')).then(value=>JSON.parse(value),()=>null);
  manifest.processCleanup=[];
  if(endpoint||remoteServerPid){manifest.processCleanup.push(await killManaged(endpoint?.pid??remoteServerPid).catch(error=>({error:error.message})));await pause(300);if(endpoint?.turnPid)manifest.processCleanup.push(await killManaged(endpoint.turnPid).catch(error=>({error:error.message})));}
  manifest.transportRuleCleanup=[];
  for(const rule of firewallRules)manifest.transportRuleCleanup.push(await ssh('sudo -n iptables -D '+rule).then(()=>({rule,removed:true}),error=>({rule,removed:false,error:error.message})));
  if(remote){
    for(const name of ['server.log','turn-stdout.log','capture.log','download.log','pip.log'])await copy(target+':'+remote+'/'+name,path.join(root,name)).catch(()=>{});
    // Never delete remote evidence until retrieval succeeded. Temporary files
    // can be removed afterward; no services, system packages or settings changed.
    manifest.remoteCleanup=await ssh('ps -p '+[endpoint?.pid,endpoint?.turnPid].filter(Boolean).join(',')+' -o pid=,comm= 2>/dev/null || true').catch(()=> 'unverified');
    manifest.temporaryDependencyVersions=await ssh(shellQuote(remote+'/venv/bin/pip')+' freeze').catch(()=> 'unverified');
    manifest.temporaryDebSha256=await ssh('cd '+shellQuote(remote)+' && sha256sum *.deb').catch(()=> 'unverified');
  }
  manifest.completedAt=new Date().toISOString();write('artifact.json',manifest);
  console.log('Evidence retained at '+root);
}
