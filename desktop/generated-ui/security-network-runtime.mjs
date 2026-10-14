// Test-only packaged entry; imported shipped host bytes remain in app-production.asar.
import { app, BrowserWindow, ipcMain, session, WebContentsView, webContents, netLog } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import dgram from 'node:dgram';
import net from 'node:net';
import { createGeneratedUIManager } from '../app-production.asar/desktop/generated-ui/host.mjs';
import { buildWrapperDocument, CHILD_CSP } from '../app-production.asar/desktop/generated-ui/frame-content.mjs';
import { WRAPPER_CSP, WRAPPER_HEADERS } from '../app-production.asar/desktop/generated-ui/policy.mjs';
import { networkVectors, witnessedNavigationVector } from './network-vectors.mjs';

const arg = name => process.argv[process.argv.indexOf(name) + 1];
const root = arg('--evidence-dir');
const config = JSON.parse(fs.readFileSync(arg('--endpoint-config'), 'utf8'));
app.setPath('userData', path.join(root, 'profile'));
app.setName('Deck Packaged Network Gate');
app.on('window-all-closed', () => {});
// Only the disposable probe process uses a controlled resolver and synthetic
// self-signed endpoints. This is recorded as instrumentation, not production setup.
app.commandLine.appendSwitch('ignore-certificate-errors');
const evidence = { packaged: app.isPackaged, versions: {electron:process.versions.electron, chromium:process.versions.chrome, node:process.versions.node}, testOnlyPolicy:true, releaseEnabled:false, instrumentation:{controlledDoH:true, ignoreSyntheticCertificateErrors:true, noInstalledChanges:true}, phases:[], observations:[], localReceipts:[], preconnectEvents:[], probes:[] };
app.on('session-created',ses=>ses.on('preconnect',(_event,url,credentials,frame)=>evidence.preconnectEvents.push({at:Date.now(),url,credentials,frame:frame?.url})));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(fn, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {const result = fn(); if (result) return result; await sleep(25);}
  throw Error('Network probe timed out');
}
const windows = [], listeners = [], events = [];
let manager, win, current, renewing, netLogging;
let localRTC={};
function phase(name) {const value={name,start:Date.now()}; evidence.phases.push(value); console.log('stage: '+name); return () => {value.end=Date.now();};}
const receive = (event, value) => manager?.receive(event, value);
async function listen(server, host) {await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,host,resolve);});listeners.push(server);return server.address().port;}
function localServer(tls, host) {
  const handler = (req,res) => {evidence.localReceipts.push({at:Date.now(),kind:tls?'https':'http',host,path:req.url}); res.writeHead(200, {'Content-Type':'text/plain','Access-Control-Allow-Origin':'*'});res.end('ok');};
  const server = tls ? https.createServer({key:fs.readFileSync(path.join(root,'key.pem')),cert:fs.readFileSync(path.join(root,'cert.pem'))},handler) : http.createServer(handler);
  server.on('connection',()=>evidence.localReceipts.push({at:Date.now(),kind:'tcp-accept',host,tls}));
  server.on('upgrade',(req,socket)=>{evidence.localReceipts.push({at:Date.now(),kind:'websocket',host,path:req.url});const accept=crypto.createHash('sha1').update(String(req.headers['sec-websocket-key'])+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');socket.end('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+accept+'\r\n\r\n');});
  return server;
}
const relaxed = "default-src * data: blob: 'unsafe-inline' 'unsafe-eval'; script-src * data: blob: 'unsafe-inline' 'unsafe-eval'; style-src * 'unsafe-inline'; img-src * data:; font-src * data:; connect-src *; frame-src * data: about:; child-src * data: about:; worker-src * blob:; form-action *;";
const options = phase => ({phase, bases:[], dnsSuffix:crypto.randomBytes(6).toString('hex')+'.network-gate.invalid', webtransport:'https://'+config.address+':'+config.webtransport+'/transport/'+phase, certificateHash:config.certificateHash, turn:config.address+':'+config.turn, turnUsername:config.turnUsername, turnPassword:config.turnPassword, ...localRTC});

async function diagnostic(name, header, bases) {
  const end=phase(name), ses=session.fromPartition('gate-'+crypto.randomUUID(),{cache:false});
  const id=crypto.randomBytes(16).toString('hex'), url='https://generated-ui.invalid/'+id;
  const document=buildWrapperDocument({runId:id,revisionDigest:'b'.repeat(64)}).replaceAll(WRAPPER_CSP,relaxed).replaceAll(CHILD_CSP,relaxed).replace(' connectionallowlist="()"','');
  const headers={...WRAPPER_HEADERS,'Content-Security-Policy':relaxed,'X-DNS-Prefetch-Control':'on'};
  if(!header) delete headers['Connection-Allowlist'];
  ses.protocol.handle('https',req=>req.url===url?new Response(document,{headers}):new Response('Denied',{status:403}));
  const control=new BrowserWindow({show:false,width:900,height:700,webPreferences:{session:ses,preload:path.join(process.resourcesPath,'app-production.asar/desktop/generated-ui/preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false}});
  windows.push(control);const messages=[];control.webContents.on('console-message',d=>messages.push(d.message));
  await control.loadURL(url);
  // The inherited policy is established by the intercepted bootstrap response.
  // Remove only this diagnostic handler so HTTPS positive controls reach the
  // real endpoints; the shipped host retains its deny handler throughout.
  ses.protocol.unhandle('https');
  const child=await waitFor(()=>control.webContents.mainFrame.framesInSubtree.find(frame=>frame.url==='about:srcdoc'));
  await sleep(150);
  const settings=options(name);settings.bases=[...bases,'https://fetch-'+name+'.'+settings.dnsSuffix+':'+config.https];
  await child.executeJavaScript(networkVectors(settings));
  // A real authenticated TURN-relayed data channel positive control. Both peers
  // use relay-only policy, so a received message requires the external relay.
  const dataChannel = `window.__dataChannel={};(async()=>{try{const ice={iceTransportPolicy:'relay',iceServers:[{urls:'turn:${config.address}:${config.turn}?transport=udp',username:'probe',credential:${JSON.stringify(config.turnPassword)}}]};const a=new RTCPeerConnection(ice),b=new RTCPeerConnection(ice);window.__networkObjects.push(a,b);a.onicecandidate=e=>{if(e.candidate)b.addIceCandidate(e.candidate).catch(()=>{})};b.onicecandidate=e=>{if(e.candidate)a.addIceCandidate(e.candidate).catch(()=>{})};b.ondatachannel=e=>{e.channel.onmessage=m=>window.__dataChannel.received=m.data};const channel=a.createDataChannel('positive');channel.onopen=()=>{window.__dataChannel.open=true;channel.send('synthetic-'+${JSON.stringify(name)})};await a.setLocalDescription(await a.createOffer());await b.setRemoteDescription(a.localDescription);await b.setLocalDescription(await b.createAnswer());await a.setRemoteDescription(b.localDescription);}catch(e){window.__dataChannel.error=e.name+': '+e.message}})();`;
  await child.executeJavaScript(dataChannel);
  await sleep(8000);
  const result=await child.executeJavaScript('({attempts:window.__networkAttempts,dataChannel:window.__dataChannel,objects:window.__networkObjects.map(x=>({kind:x.constructor.name,ice:x.iceGatheringState,state:x.connectionState}))})');
  evidence.probes.push({name,header,settings:{...settings,turnPassword:'synthetic redacted'},result,consoleMessages:messages});
  control.destroy();await sleep(1500);end();
}

async function runProbe() {
  try {
    if(!app.isPackaged) throw Error('This gate requires the packaged application runtime');
    await netLog.startLogging(path.join(root,'netlog.json'),{captureMode:'everything'});netLogging=true;
    app.configureHostResolver({secureDnsMode:'secure',secureDnsServers:['https://'+config.address+':'+config.https+'/dns-query'],enableBuiltInResolver:true});
    const http4=await listen(localServer(false,'127.0.0.1'),'127.0.0.1');
    const http6=await listen(localServer(false,'::1'),'::1');
    const tls4=await listen(localServer(true,'127.0.0.1'),'127.0.0.1');
    const tls6=await listen(localServer(true,'::1'),'::1');
    const udp6=dgram.createSocket('udp6');listeners.push(udp6);
    await new Promise(resolve=>udp6.bind(0,'::1',resolve));
    udp6.on('message',(bytes,peer)=>evidence.localReceipts.push({at:Date.now(),kind:'stun6',host:peer.address,bytes:bytes.length,magic:bytes.subarray(4,8).toString('hex'),messageType:bytes.subarray(0,2).toString('hex')}));
    const turn6=net.createServer(socket=>{socket.on('data',bytes=>evidence.localReceipts.push({at:Date.now(),kind:'turn6-tcp',host:socket.remoteAddress,bytes:bytes.length,magic:bytes.subarray(4,8).toString('hex'),messageType:bytes.subarray(0,2).toString('hex')}));});
    const turn6Port=await listen(turn6,'::1');
    localRTC={stun6:'stun:[::1]:'+udp6.address().port,turn6:'turn:[::1]:'+turn6Port+'?transport=tcp'};
    const bases=['http://'+config.address+':'+config.http,'https://'+config.address+':'+config.https,'http://127.0.0.1:'+http4,'http://[::1]:'+http6,'https://127.0.0.1:'+tls4,'https://[::1]:'+tls6];
    await diagnostic('positive',false,bases);
    await diagnostic('header-only',true,bases);
    win=new BrowserWindow({show:false,width:900,height:700,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});windows.push(win);
    await win.loadURL('data:text/html,<title>Trusted network gate owner</title><p id="chat">chat alive</p>');
    const owner={win,frame:win.webContents.mainFrame},bounds={x:20,y:80,width:700,height:300};
    manager=createGeneratedUIManager({electron:{app,session,WebContentsView,webContents},testPolicy:{testOnly:true,enabled:true,ledger:{count:0}},emit(_w,event){events.push({at:Date.now(),...event});},audit(event){evidence.observations.push({at:Date.now(),...event});}});
    ipcMain.on('generated-ui:message',receive);
    renewing=setInterval(()=>{if(current)manager.bounds(owner,current.runId,bounds)},100);
    async function run(name,js) {
      const card={schemaVersion:1,kind:'generated',cardId:name,title:name,summary:'Network gate',html:'<p>Controlled network gate</p>',css:'',js,fallback:'Network gate'};
      current=await manager.run(owner,{requestId:name+'-request-000000000000',source:JSON.stringify(card),identity:{threadId:'network-gate',seq:1,cardId:name,hostId:'local'},bounds});
      return current;
    }
    const end=phase('shipped');
    const settings=options('shipped');settings.bases=[...bases,'https://fetch-shipped.'+settings.dnsSuffix+':'+config.https];
    const result=await run('network-shipped',networkVectors(settings));
    await waitFor(()=>events.find(e=>e.runId===result.runId&&e.type==='ready'));
    await sleep(8000);
    const page=webContents.getAllWebContents().find(p=>p.getURL().endsWith(result.runId));
    const child=page.mainFrame.framesInSubtree.find(f=>f.url==='about:srcdoc');
    const attempts=await child.executeJavaScript('window.__networkAttempts');
    await manager.stop(owner,result.runId);current=null;await sleep(1500);end();
    evidence.probes.push({name:'shipped',runId:result.runId,attempts,settings:{...settings,turnPassword:'synthetic redacted'}});
    // Literal-IP navigation has no DNS lookup. Restore the process resolver
    // before these early-teardown probes so cancelled test-only DoH liveness
    // connections cannot be mistaken for generated navigation transport.
    app.configureHostResolver({secureDnsMode:'off',enableBuiltInResolver:true});
    evidence.instrumentation.literalNavigationDoH=false;
    for(const kind of ['nested-remote','nested-srcdoc','location','anchor','form']) {
      const end=phase('shipped-'+kind);
      const result=await run('nav-'+kind,witnessedNavigationVector(bases[1],'shipped-'+kind,kind));
      await waitFor(()=>events.find(e=>e.runId===result.runId&&e.type==='ready'));
      await waitFor(()=>evidence.observations.find(e=>e.runId===result.runId&&e.type==='renderer-console'&&e.message==='NETWORK_VECTOR_INVOKED:shipped-'+kind));
      await sleep(1200);await manager.stop(owner,result.runId);current=null;await sleep(250);end();
      evidence.probes.push({name:'shipped-'+kind,events:events.filter(e=>e.runId===result.runId),invoked:true});
    }
    app.configureHostResolver({secureDnsMode:'secure',secureDnsServers:['https://'+config.address+':'+config.https+'/dns-query'],enableBuiltInResolver:true});
    await sleep(500); // Separate subsequent positives from capture clock bounds.
    // Positive iframe/navigation/worker receipts through an ordinary secure
    // page establish that these endpoints remain functional outside the host.
    const controlSession=session.fromPartition('ordinary-positive-'+crypto.randomUUID());
    const control=new BrowserWindow({show:false,webPreferences:{session:controlSession,sandbox:true,contextIsolation:true,nodeIntegration:false}});windows.push(control);
    const endOrdinary=phase('ordinary-positive');
    await control.loadURL(bases[1]+'/ordinary-positive/start');
    await control.webContents.executeJavaScript(`new Worker(${JSON.stringify(bases[1]+'/ordinary-positive/worker.js')}); const f=document.createElement('iframe');f.src=${JSON.stringify(bases[1]+'/ordinary-positive/nested-remote')};document.body.append(f);const n=document.createElement('iframe');n.srcdoc='<img src="'+${JSON.stringify(bases[1]+'/ordinary-positive/nested-srcdoc.png')}+'">';document.body.append(n); fetch(${JSON.stringify(bases[1]+'/ordinary-positive/redirect/start')});`);
    const ordinaryOptions=options('ordinary-positive');ordinaryOptions.bases=[bases[1],bases[1]];
    await control.webContents.executeJavaScript(networkVectors(ordinaryOptions));
    await control.webContents.executeJavaScript(`const nf=document.createElement('iframe');nf.name='nav-positive';document.body.append(nf);const fm=document.createElement('form');fm.action=${JSON.stringify(bases[1]+'/ordinary-positive/form')};fm.method='POST';fm.target='nav-positive';document.body.append(fm);fm.submit();setTimeout(()=>{const a=document.createElement('a');a.href=${JSON.stringify(bases[1]+'/ordinary-positive/anchor')};a.target='nav-positive';document.body.append(a);a.click()},700);`);
    await sleep(3500);
    await control.webContents.executeJavaScript(`location.href=${JSON.stringify(bases[1]+'/ordinary-positive/location')}`);
    await sleep(1500);control.destroy();endOrdinary();
    const endForm=phase('ordinary-form-positive');
    const formControl=new BrowserWindow({show:false,webPreferences:{session:session.fromPartition('form-positive-'+crypto.randomUUID()),sandbox:true,contextIsolation:true,nodeIntegration:false}});windows.push(formControl);
    await formControl.loadURL(bases[1]+'/ordinary-positive/form-start');
    await formControl.webContents.executeJavaScript(`const f=document.createElement('form');f.method='POST';f.action=${JSON.stringify(bases[1]+'/ordinary-positive/form')};document.body.append(f);setTimeout(()=>f.submit(),30);`);
    await sleep(1800);formControl.destroy();endForm();
    const plainControl=new BrowserWindow({show:false,webPreferences:{session:session.fromPartition('plain-positive-'+crypto.randomUUID()),sandbox:true,contextIsolation:true,nodeIntegration:false}});windows.push(plainControl);
    const endHTTP=phase('http-positive');
    await plainControl.loadURL(bases[0]+'/http-positive/start');
    const plainOptions=options('http-positive');plainOptions.bases=[bases[0],bases[0]];
    await plainControl.webContents.executeJavaScript(networkVectors(plainOptions));
    await sleep(2000);plainControl.destroy();endHTTP();
    const endSensor=phase('sensor-preconnect');
    session.fromPartition('sensor-preconnect-'+crypto.randomUUID()).preconnect({url:'https://sensor-preconnect.'+crypto.randomBytes(6).toString('hex')+'.network-gate.invalid:'+config.https,numSockets:1});
    await sleep(1500);endSensor();
    evidence.runtimeCompleted=true;
  } catch(error) {evidence.error=error.stack||String(error);evidence.runtimeCompleted=false;}
  finally {
    clearInterval(renewing);ipcMain.removeListener('generated-ui:message',receive);await manager?.stopAll('Network probes finished');
    for(const window of windows)if(!window.isDestroyed())window.destroy();
    for(const listener of listeners){listener.closeAllConnections?.();listener.close();}
    if(netLogging)await netLog.stopLogging();
    evidence.events=events;evidence.completedAt=new Date().toISOString();
    fs.writeFileSync(path.join(root,'runtime-evidence.json'),JSON.stringify(evidence,null,2));
    console.log(JSON.stringify({runtimeCompleted:evidence.runtimeCompleted,error:evidence.error,phases:evidence.phases}));
    app.exit(evidence.runtimeCompleted?0:1);
  }
}
void app.whenReady().then(runProbe);
