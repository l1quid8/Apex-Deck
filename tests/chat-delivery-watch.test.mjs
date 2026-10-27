import test from 'node:test';
import assert from 'node:assert/strict';
import { hostConnectionStore } from '../src/hostConnections.ts';

async function watchApi() {
  try { return await import('../src/phone/chatDeliveryWatch.ts'); }
  catch (error) { assert.fail(`Chat delivery reconnection integration is missing: ${error.message}`); }
}

test('reconnect and completed messages recover delivery; stream deltas do not flood room reads', async () => {
  const {watchChatDelivery} = await watchApi();
  const connection = hostConnectionStore('linux','Apex-Terminal');
  let event;
  let recovered = 0;
  let heard;
  let next = new Promise(resolve => { heard = resolve; });
  const host = {machine:{id:'linux',name:'Apex-Terminal'},connection,backend:{onRoomEvent:async cb => {event = cb;return () => {event = null;};}}};
  const errors = [];
  const watch = watchChatDelivery({reconnect:async id => {assert.equal(id,'linux');recovered++;heard();}},[host],error=>errors.push(error));
  await watch.ready;
  assert.equal(recovered,0);
  connection.setStatus({kind:'connected'});
  await next;
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(recovered,1);
  for (let i=0;i<50;i++) event('r',{type:'delta',id:'null',text:'x'});
  assert.equal(recovered,1);
  next = new Promise(resolve => { heard = resolve; });
  event('r',{type:'message_added',message:{seq:1,text:'Hello',speaker:{kind:'bot',id:'null'}}});
  await next;
  assert.equal(recovered,2);
  watch.stop();
  connection.setStatus({kind:'resync'});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(recovered,2);
  assert.equal(event,null);
  assert.deepEqual(errors,[]);
});

test('late event registration after unmount is released and recovery errors surface once', async () => {
  const {watchChatDelivery} = await watchApi();
  const connection = hostConnectionStore('linux','Apex-Terminal');
  connection.setStatus({kind:'connected'});
  let registered;
  let removed = 0;
  const host = {machine:{id:'linux',name:'Apex-Terminal'},connection,backend:{onRoomEvent:() => new Promise(resolve=>{registered=resolve;})}};
  const errors = [];
  const watch = watchChatDelivery({reconnect:async () => {throw Error('Saved outbox could not be written');}},[host],error=>errors.push(String(error)));
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(errors,['Error: Saved outbox could not be written']);
  watch.stop();
  registered(()=>removed++);
  await watch.ready;
  assert.equal(removed,1);
});

test('finishing a resync runs recovery again when queued sends become writable', {timeout:1000}, async () => {
  const {watchChatDelivery} = await watchApi();
  const connection = hostConnectionStore('linux','Apex-Terminal');
  connection.setFinishResync(()=>connection.setStatus({kind:'connected'}));
  const seen = [];
  let finished;
  const done = new Promise(resolve=>{finished=resolve;});
  const host = {machine:{id:'linux'},connection,backend:{onRoomEvent:async()=>()=>{}}};
  const watch = watchChatDelivery({reconnect:async()=>{seen.push(connection.get().status.kind);if(seen.length===2)finished();}},[host],assert.fail);
  await watch.ready;
  connection.setStatus({kind:'resync'});
  await done;
  watch.stop();
  assert.deepEqual(seen,['resync','connected']);
});
