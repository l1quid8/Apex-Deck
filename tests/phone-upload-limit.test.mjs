import test from 'node:test';
import assert from 'node:assert/strict';
import { DaemonClient } from '../src/daemon/client.ts';
import { daemonTransport } from '../src/daemon/transport.ts';
import { irohConnect } from '../src/daemon/irohLink.ts';
import { EventRouter } from '../src/phone/remotePlugin.ts';
const tick = () => new Promise(resolve => setImmediate(resolve));

async function connected(limit = 8 * 1024 * 1024) {
  const router = new EventRouter();
  const sent = []; const closed = [];
  const plugin = {
    connect: async()=>1,
    listen:(handle,cb)=>router.listen(handle,cb),
    send:async(handle,line)=>{
      sent.push(line);
      const frame=JSON.parse(line);
      router.deliver({type:'line',handle,line:JSON.stringify({id:frame.id,ok:frame.cmd==='hello'?{protocol:1,host_id:'h',boot_id:'b',last_seq:0,resumed:false,max_frame_bytes:limit}: 'saved'})});
    },
    close:async(handle)=>{closed.push(handle);},
  };
  const client=new DaemonClient(irohConnect(()=>({hostEndpointId:'a'.repeat(64),addrs:[]}),plugin));
  const started=client.start(); await tick(); router.deliver({type:'opened',handle:1}); await started;
  return {client,transport:daemonTransport(client),sent,closed};
}
test('6 MiB upload is refused before native send and leaves the connection usable',async()=>{
  const {client,transport,sent,closed}=await connected();
  const bytes=new Uint8Array(6*1024*1024);
  await assert.rejects(transport.saveAttachment('existing-room','photo.heic',bytes),/too large|exceeds.*limit/i);
  assert.equal(sent.length,1,'only hello reached native send');
  assert.deepEqual(closed,[]);
  assert.equal(await client.call('room_state',{id:'existing-room'}),'saved');
  client.close();
});
test('serialized UTF-8 frame accepts the exact limit and rejects one byte over without sending',async()=>{
  const {client,sent,closed}=await connected(256);
  const args={room:'r',name:'照片.heic',data:''};
  const overhead=Buffer.byteLength(JSON.stringify({id:1,cmd:'save_attachment',args}));
  args.data='x'.repeat(256-overhead);
  assert.equal(await client.call('save_attachment',args),'saved');
  args.data+='x';
  await assert.rejects(client.call('save_attachment',args),/too large|exceeds.*limit/i);
  assert.equal(sent.length,2); assert.deepEqual(closed,[]);
  assert.equal(await client.call('room_state',{id:'r'}),'saved'); client.close();
});
