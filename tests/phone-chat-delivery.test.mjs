import test from 'node:test';
import assert from 'node:assert/strict';

async function api() {
  try { return await import('../src/phone/phoneChatDelivery.ts'); }
  catch (error) { assert.fail(`Phone delivery RPC integration is missing: ${error.message}`); }
}

const snapshot = () => ({kind:'chat',participants:[],options:{policy:'everyone',max_bot_hops:3},transcript:[]});
function machine(reply = {}) {
  const calls = [];
  const caps = new Set(['chat_rooms','chat_delivery_v1']);
  const host = {machine:{id:'linux',name:'Apex-Terminal'},connection:{get:()=>({status:{kind:'connected'}})},backend:{
    supports: capability => caps.has(capability),
    call: async (cmd,args) => {calls.push({cmd,args});return typeof reply === 'function' ? reply(cmd,args) : reply;},
  }};
  return {host,calls,caps};
}

test('a Task1-only daemon cannot receive a send whose delivery ID it would ignore', async () => {
  const {createChatDeliveryRpc} = await api();
  const {host,calls,caps} = machine();
  caps.delete('chat_delivery_v1');
  await assert.rejects(createChatDeliveryRpc(() => host).post('linux','r',{clientMessageId:'m1',text:'Hi',targets:['null','jigga']}), /Update Deck on Apex-Terminal/);
  assert.deepEqual(calls,[]);
});

test('group sends carry the durable ID, without the voice single-bot hop restriction', async () => {
  const {createChatDeliveryRpc} = await api();
  const {host,calls} = machine({clientMessageId:'m1',state:'running',replySeqs:[]});
  const ack = await createChatDeliveryRpc(() => host).post('linux','r',{clientMessageId:'m1',text:'Hi',targets:['null','jigga']});
  assert.equal(ack.state,'running');
  assert.deepEqual(calls,[{cmd:'room_post_to',args:{id:'r',clientMessageId:'m1',text:'Hi',targets:['null','jigga']}}]);
});

test('an unaddressed message uses normal room routing instead of an empty explicit recipient list', async () => {
  const {createChatDeliveryRpc} = await api();
  const {host,calls} = machine({clientMessageId:'m1',state:'running',replySeqs:[]});
  await createChatDeliveryRpc(() => host).post('linux','r',{clientMessageId:'m1',text:'Everyone?',targets:[]});
  assert.deepEqual(calls,[{cmd:'room_post',args:{id:'r',clientMessageId:'m1',text:'Everyone?'}}]);
});

test('malformed chat snapshots cannot replace the saved transcript', async () => {
  const {createChatDeliveryRpc} = await api();
  for (const changed of [
    {transcript:[{seq:1,speaker:{kind:'bot'},text:'reply'}]},
    {options:{policy:'everyone',max_bot_hops:-1}},
    {clientMessages:{m1:{state:'done',replySeqs:[NaN]}}},
  ]) {
    const {host} = machine({snapshot:{...snapshot(),...changed}});
    await assert.rejects(createChatDeliveryRpc(() => host).exportRoom('linux','r'),/invalid chat snapshot/i);
  }
});

test('missing, malformed or wrong-ID receipts are not treated as confirmed delivery', async () => {
  const {createChatDeliveryRpc} = await api();
  for (const reply of [{ok:true},{clientMessageId:'other',state:'done',replySeqs:[]},{clientMessageId:'m1',state:'done',replySeqs:[-1]}]) {
    const {host} = machine(reply);
    await assert.rejects(createChatDeliveryRpc(() => host).post('linux','r',{clientMessageId:'m1',text:'Hi',targets:[]}),/delivery receipt/i);
  }
});

test('export refuses Work snapshots; claims and archive use chat-only commands', async () => {
  const {createChatDeliveryRpc} = await api();
  const {host,calls} = machine((cmd) => cmd === 'room_state' ? {snapshot:{...snapshot(),kind:'work'}} : {state:'fenced',replySeqs:[]});
  const rpc = createChatDeliveryRpc(() => host);
  await assert.rejects(rpc.exportRoom('linux','work'),/talk-only chat/);
  assert.deepEqual(await rpc.claim('linux','chat','m1'),{state:'fenced',replySeqs:[]});
  await rpc.archive('linux','chat',{host:'b',room:'moved'});
  assert.deepEqual(calls.slice(1),[
    {cmd:'chat_message_claim',args:{id:'chat',clientMessageId:'m1'}},
    {cmd:'chat_update_meta',args:{id:'chat',archived:true,movedTo:{host:'b',room:'moved'}}},
  ]);
});

test('import refuses a Work result and preserves the destination ID from an idempotent retry', async () => {
  const {createChatDeliveryRpc} = await api();
  const input = {id:'proposed',moveId:'move-1',title:'Chat',participants:[],entries:[]};
  const bad = machine({id:'original',room:{...snapshot(),kind:'work'},skipped:[]});
  await assert.rejects(createChatDeliveryRpc(() => bad.host).importRoom('linux',input),/talk-only chat/);
  const good = machine({id:'original',room:snapshot(),skipped:[]});
  const imported = await createChatDeliveryRpc(() => good.host).importRoom('linux',input);
  assert.equal(imported.id,'original');
  assert.deepEqual(good.calls,[{cmd:'chat_import',args:input}]);
});

test('the phone entry point saves uncertain before RPC and restores confirmed delivery after relaunch', async () => {
  const {createPhoneChatDelivery} = await api();
  const disk = new Map();
  const storage = {getItem:key=>disk.get(key)??null,setItem:(key,value)=>disk.set(key,value)};
  const {host,calls} = machine((_cmd,args) => {
    const saved = JSON.parse([...disk.values()][0]);
    assert.equal(saved.chats.chat.outbox[0].state,'uncertain');
    return {clientMessageId:args.clientMessageId,state:'done',replySeqs:[]};
  });
  const options = {storage,findHost:()=>host,onChange:()=>{},onError:()=>{}};
  const runtime = createPhoneChatDelivery(options);
  runtime.controller.cacheChat({id:'chat',title:'Chat',machine:host.machine,room:'r',snapshot:snapshot()});
  const id = runtime.controller.enqueue('chat','Hello',['null','jigga']);
  await runtime.controller.send('chat',id);
  const relaunched = createPhoneChatDelivery(options);
  assert.equal(relaunched.controller.snapshot().chats.chat.outbox[0].accepted,'done');
  assert.equal(calls.length,1);
  assert.equal(calls[0].cmd,'room_post_to');
});

test('an offline machine leaves a new message unsent rather than inventing an uncertain delivery', async () => {
  const {createPhoneChatDelivery} = await api();
  const disk = new Map();
  const {host,calls} = machine();
  host.connection.get = () => ({status:{kind:'disconnected'}});
  const runtime = createPhoneChatDelivery({storage:{getItem:key=>disk.get(key)??null,setItem:(key,value)=>disk.set(key,value)},findHost:()=>host,onError:()=>{}});
  runtime.controller.cacheChat({id:'chat',title:'Chat',machine:host.machine,room:'r',snapshot:snapshot()});
  const id = runtime.controller.enqueue('chat','Wait for the machine',['null']);
  await runtime.controller.send('chat',id);
  assert.equal(runtime.controller.snapshot().chats.chat.outbox[0].state,'unsent');
  assert.deepEqual(calls,[]);
});
