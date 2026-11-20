// Standalone real-Electron state/authority/lifecycle regression. Never starts installed Deck.
import {app,BrowserWindow,ipcMain,session,WebContentsView,webContents} from 'electron';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import dgram from 'node:dgram';
import {createGeneratedUIManager} from './host.mjs';
import {WidgetStore} from './widget-store.mjs';
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'deck-widget-runtime-'));
app.setPath('userData',path.join(directory,'profile'));
app.setName('Deck Widget Persistence Probe');
const evidence={versions:process.versions,packaged:app.isPackaged,checks:[],passed:false,directory};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const until=async fn=>{const end=Date.now()+12000;while(Date.now()<end){const v=await fn();if(v)return v;await sleep(30);}throw Error('Persistence probe timed out');};
let win,manager,current,renew,server,udp;
const events=[],audit=[];
const bounds={x:20,y:80,width:650,height:300};
const receive=(event,value)=>manager?.receive(event,value);
async function probe() {
try {
 win=new BrowserWindow({width:900,height:700,alwaysOnTop:true,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
 await win.loadURL('data:text/html,<p id="canary">Deck private data</p>');app.focus({steal:true});win.show();win.focus();await until(()=>win.isFocused());
 const owner={win,frame:win.webContents.mainFrame}, chatPid=win.webContents.getOSProcessId();
 const create=()=>createGeneratedUIManager({electron:{app,session,WebContentsView,webContents},widgetStore:new WidgetStore(path.join(directory,'state')),testPolicy:{testOnly:true,enabled:true,ledger:{count:0}},emit:(_win,event)=>events.push(event),audit:e=>audit.push(e)});
 manager=create();ipcMain.on('generated-ui:message',receive);
 renew=setInterval(()=>{if(current)manager.bounds(owner,current.runId,bounds);},100);
 const card={schemaVersion:1,kind:'generated',cardId:'stateful',title:'Stateful flow',summary:'Test',html:'<button id="next">Next</button><output id="step"></output>',css:'',js:'const saved=generatedUI.widgetState;let step=Number.isInteger(saved?.step)?saved.step:0;const draw=()=>document.querySelector("#step").textContent=String(step);document.querySelector("#next").onclick=()=>{step++;generatedUI.setWidgetState({step});draw()};draw();',fallback:'Stateful test.'};
 const identity={threadId:'thread-a',seq:1,cardId:card.cardId,hostId:'local'};
 const request=(extra={})=>({requestId:'persistence-request-00000001',source:JSON.stringify(card),identity,bounds,...extra});
 const start=async req=>{app.focus({steal:true});win.show();win.focus();await until(()=>win.isFocused());await sleep(150);current=await manager.run(owner,req);await until(()=>events.some(e=>e.runId===current.runId&&e.type==='ready'));const host=webContents.getAllWebContents().find(p=>p.getURL().endsWith(current.runId));return {host,child:host.mainFrame.framesInSubtree.find(f=>f.url==='about:srcdoc')};};
 const stop=async()=>{const id=current.runId;await manager.stop(owner,id);current=null;assert.deepEqual(audit.find(e=>e.runId===id&&e.type==='disposed').remaining,[]);assert.equal(win.webContents.getOSProcessId(),chatPid);};
 let run=await start(request());
 assert.equal(await run.child.executeJavaScript('document.querySelector("#step").textContent'),'0');
 await run.child.executeJavaScript('document.querySelector("#next").click();if(generatedUI.widgetState.step!==1)throw Error("not synchronous");');
 await until(()=>events.some(e=>e.runId===current.runId&&e.type==='snapshot'));

 assert.match(manager.cached(owner,request()).image,/^data:image\/png;base64,/);
 const oldSender=run.host,oldFrame=run.host.mainFrame,oldId=current.runId,digest=current.revisionDigest;
 await stop();
 manager.receive({sender:oldSender,senderFrame:oldFrame,ports:[]},{protocolVersion:1,runId:oldId,revisionDigest:digest,type:'widget-state',widgetState:{step:99}});
 run=await start(request());
 assert.equal(await run.child.executeJavaScript('document.querySelector("#step").textContent'),'1');
 evidence.checks.push({name:'same-revision restore after teardown, synchronous setter, PNG cache and disposed-writer rejection',passed:true});
 await run.child.executeJavaScript('for(const value of [Infinity,{a:undefined},{text:"x".repeat(4097)}]){let rejected=false;try{generatedUI.setWidgetState(value)}catch{rejected=true}if(!rejected)throw Error("invalid state accepted");}');
 assert.equal(await run.child.executeJavaScript('typeof window.apexDeck+":"+typeof window.generatedUIHost+":"+typeof navigator.mediaDevices'),'undefined:undefined:undefined');
 evidence.checks.push({name:'invalid snapshots refused without exposing Deck, preload or devices',passed:true});
 let httpReceipts=0,udpReceipts=0;
 server=http.createServer((_request,response)=>{httpReceipts++;response.end('positive');});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 udp=dgram.createSocket('udp4');udp.on('message',()=>udpReceipts++);
 await new Promise(resolve=>udp.bind(0,'127.0.0.1',resolve));
 const url='http://127.0.0.1:'+server.address().port;
 await new Promise((resolve,reject)=>http.get(url,response=>{response.resume();response.on('end',resolve);}).on('error',reject));
 udp.send(Buffer.from('positive'),udp.address().port,'127.0.0.1');await until(()=>udpReceipts===1);
 await run.child.executeJavaScript(`(()=>{const url=${JSON.stringify(url)};fetch(url+'/fetch').catch(()=>{});const x=new XMLHttpRequest();x.open('GET',url+'/xhr');x.send();const image=new Image();image.src=url+'/image';document.body.append(image);try{new WebSocket(url.replace('http:','ws:')+'/socket')}catch{};try{const peer=new RTCPeerConnection({iceServers:[{urls:'stun:127.0.0.1:${udp.address().port}'}]});peer.createDataChannel('probe');peer.createOffer().then(offer=>peer.setLocalDescription(offer)).catch(()=>{});setTimeout(()=>peer.close(),400)}catch{}})()`);
 await sleep(600);assert.equal(httpReceipts,1);assert.equal(udpReceipts,1);
 evidence.checks.push({name:'HTTP/XHR/image/WebSocket and STUN blocked against independently observed loopback listeners with positive controls',passed:true});

 await stop();await manager.stopAll('reconstruct store');manager=create();
 run=await start(request());assert.equal(await run.child.executeJavaScript('document.querySelector("#step").textContent'),'1');await stop();
 evidence.checks.push({name:'host-store reconstruction restores settings and cached image',passed:true});
 for (const extra of [{identity:{...identity,threadId:'thread-b'}},{identity:{...identity,seq:2}},{identity:{...identity,hostId:'remote'}},{source:JSON.stringify({...card,title:'Changed revision'})}]) {
  assert.equal(manager.cached(owner,request(extra)).image,null);
  run=await start(request(extra));assert.equal(await run.child.executeJavaScript('document.querySelector("#step").textContent'),'0');await stop();
 }
 evidence.checks.push({name:'thread, message, host and code-revision isolation',passed:true});
 assert.equal(await win.webContents.executeJavaScript('document.querySelector("#canary").textContent'),'Deck private data');
 assert.throws(()=>manager.cached({win,frame:{}},request()),/Deck window/);
 evidence.passed=true;
} catch(error){evidence.error=error.stack||String(error);evidence.events=events;evidence.audit=audit;} finally {
 server?.close();try{udp?.close()}catch{};clearInterval(renew);ipcMain.removeListener('generated-ui:message',receive);await manager?.stopAll('Persistence test finished');win?.destroy();
 fs.writeFileSync(path.join(directory,'evidence.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence,null,2));app.exit(evidence.passed?0:1);
}

}
void app.whenReady().then(probe);
