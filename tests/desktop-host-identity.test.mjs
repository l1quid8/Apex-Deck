import test from 'node:test';
import assert from 'node:assert/strict';
const mod=await import('../desktop/hostIdentity.mjs').catch(()=>({}));
const welcome={protocol:1,host_id:'daemon-a',boot_id:'boot-a',last_seq:0,resumed:false};
test('welcome identity requires protocol and refuses retargets',()=>{
  assert.equal(typeof mod.checkWelcome,'function');
  assert.equal(mod.checkWelcome(undefined,welcome),'daemon-a');
  assert.throws(()=>mod.checkWelcome('daemon-b',welcome),/identity|different/i);
  assert.throws(()=>mod.checkWelcome(undefined,{...welcome,host_id:''}),/identity|id/i);
  assert.throws(()=>mod.checkWelcome(undefined,{...welcome,protocol:2}),/protocol/i);
});
test('identity binding refuses an existing alias and preserves the command',()=>{
  assert.equal(typeof mod.bindHostIdentity,'function');
  const state={hosts:[{id:'at',name:'AT',ssh:'at',command:'/opt/apex-daemon'},{id:'other',name:'Other',daemonHostId:'daemon-b'}]};
  const bound=mod.bindHostIdentity(state,'at',welcome);
  assert.equal(bound.hosts[0].daemonHostId,'daemon-a');assert.equal(bound.hosts[0].command,'/opt/apex-daemon');
  assert.throws(()=>mod.bindHostIdentity(bound,'at',{...welcome,host_id:'daemon-b'}),/identity|different/i);
  assert.throws(()=>mod.bindHostIdentity(state,'at',{...welcome,host_id:'daemon-b'}),/already/i);
});
test('only a persisted accepted welcome unlocks commands',async()=>{
  assert.equal(typeof mod.verifiedLink,'function');
  let incoming;const sent=[];const heard=[];let accepted=false;
  const link=await mod.verifiedLink({open:async handlers=>{incoming=handlers;return {send:l=>sent.push(JSON.parse(l)),close(){}};},handlers:{onLine:l=>heard.push(JSON.parse(l)),onClose(){}},accept:()=>{accepted=true;}});
  link.send(JSON.stringify({id:1,cmd:'room_post'}));assert.equal(sent.length,0);
  link.send(JSON.stringify({id:2,cmd:'hello'}));incoming.onLine(JSON.stringify({id:2,ok:welcome}));
  assert.equal(accepted,true);assert.equal(heard[0].ok.host_id,'daemon-a');
  link.send(JSON.stringify({id:3,cmd:'room_post'}));assert.equal(sent.at(-1).id,3);
});
