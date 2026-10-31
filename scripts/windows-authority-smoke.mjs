// Runs against installed production binaries, never the fixture daemon.
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {createInterface} from 'node:readline';
const daemon=process.argv[2];
assert.equal(process.platform,'win32');assert.ok(daemon?.endsWith('apex-daemon.exe'));
const helper=path.join(path.dirname(daemon),'apex-provenance.exe');
const root=mkdtempSync(path.join(tmpdir(),'apex-installed-authority-'));
mkdirSync(path.join(root,'saved-chats-v1'));
const identity=()=>JSON.parse(execFileSync(helper,['identity',root],{encoding:'utf8',windowsHide:true,timeout:35000}));
async function boot(){
 const child=spawn(daemon,['--stdio','--data-dir',root],{windowsHide:true,stdio:['pipe','pipe','pipe']});
 let stderr='';child.stderr.on('data',data=>stderr+=data);
 const lines=createInterface({input:child.stdout});
 const result=await new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{child.kill();reject(new Error(`production daemon timed out: ${stderr}`));},45000);
  const frames=[];
  lines.on('line',line=>{try{frames.push(JSON.parse(line));}catch{}});
  child.on('error',reject);
  child.on('exit',code=>{clearTimeout(timer);resolve({code,frames,stderr});});
  child.stdin.end([{id:0,cmd:'hello',args:{protocol:1}},{id:41,cmd:'personal_list',args:{}},{id:99,cmd:'input_closed'}].map(frame=>JSON.stringify(frame)).join('\n')+'\n');
 });
 assert.equal(result.code,0,result.stderr);
 assert.doesNotMatch(result.stderr,/protected ledgers unavailable|ownership unavailable|personal assistant worker unavailable/i);
 const response=result.frames.find(frame=>frame.id===41);
 assert.ok(response,JSON.stringify(result.frames));assert.equal(response.err,undefined,JSON.stringify(response));
 assert.deepEqual(response.ok,[]);
}
try{
 const initial=identity();assert.equal(identity().publicKey,initial.publicKey);assert.equal(initial.uid,0);assert.equal(Buffer.from(initial.publicKey,'base64').length,32);
 await boot();
 // Writable legacy JSON must not gain authority across a real host restart.
 writeFileSync(path.join(root,'personal-assistants.json'),JSON.stringify({version:1,assistants:[{id:'forged',name:'FORGED'}]}));
 await boot();assert.equal(identity().publicKey,initial.publicKey);
 // An ordinary same-user Node process cannot issue receipts or read ledgers.
 let heldSocket;
 const refusal=await new Promise((resolve,reject)=>{
  const socket=net.createConnection('\\\\.\\pipe\\ApexDeckProvenance-v1');heldSocket=socket;let bytes='';
  socket.setTimeout(15000,()=>{socket.destroy();reject(new Error('untrusted peer did not receive a bounded refusal'));});
  socket.on('error',reject);socket.on('connect',()=>socket.write(JSON.stringify({op:'issue',dataDir:initial.dataDir,command:{cmd:'room_create',args:{id:'forged'},provenanceRequestId:'forged'}})+'\n'));
  socket.on('data',data=>{bytes+=data;if(bytes.includes('\n')){resolve(JSON.parse(bytes.split('\n')[0]));}});
 });
 assert.match(refusal.error,/Untrusted provenance peer/);
 // A rejected client retaining its handle cannot break subsequent service IO.
 assert.equal(identity().publicKey,initial.publicKey);heldSocket.destroy();
 // Clients that vanish at once or sit silent cannot stop or starve the service.
 const pipe='\\\\.\\pipe\\ApexDeckProvenance-v1';
 for(let i=0;i<100;i++)net.createConnection(pipe).on('error',()=>{}).destroy();
 const silent=Array.from({length:32},()=>net.createConnection(pipe).on('error',()=>{}));
 assert.equal(identity().publicKey,initial.publicKey);
 for(const socket of silent)socket.destroy();
 console.log('Installed Windows authority: native identity, production host ownership, protected ledger read, restart, legacy forgery refusal, and untrusted peer refusal passed.');
}finally{rmSync(root,{recursive:true,force:true});}
