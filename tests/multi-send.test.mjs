import test from 'node:test';
import assert from 'node:assert/strict';
import { freezeBatch, startBatch, retryFailed, sendAgain, discardFailed, stopBatch } from '../src/multiSend.ts';

const slice = (paneId, files = []) => ({paneId, hostId:'old', text:'hello', routing:'hello', files, command:null, to:null, group:false});
function fixture() {
  const apis = new Map(); const calls = [];
  function api(paneId, queue = paneId, hostId = 'old') {
    const states = new Map(); const watchers = new Map(); let seq = 0;
    const a = { paneId, queue, hostId,
      submit(p) { calls.push([paneId, 'submit', p]); const ref = {queue,id:++seq}; states.set(ref.id,'waiting'); return ref; },
      command(name) { calls.push([paneId,'command',name]); const ref = {queue,id:++seq}; states.set(ref.id,'waiting'); return ref; },
      status(ref) { return states.get(ref.id) ?? 'unknown'; },
      watch(ref, cb) { watchers.set(ref.id,cb); cb(a.status(ref)); return () => watchers.delete(ref.id); },
      emit(id,state,error) { states.set(id,state); watchers.get(id)?.(state,error); },
      retry(ref) { calls.push([paneId,'retry']); a.emit(ref.id,'waiting'); return 'retried'; },
      remove(ref) { calls.push([paneId,'remove']); a.emit(ref.id,'removed'); },
      giveUp(ref) { a.emit(ref.id,'failed',new Error('Stopped waiting')); },
    }; apis.set(paneId,a); return a;
  }
  return {apis:{get:id=>apis.get(id),subscribe:()=>()=>{}}, api, calls, remove:id=>apis.delete(id)};
}

test('freeze copies bytes, target lists and payload and rejects unread files before taking a draft', () => {
  const bytes = new Uint8Array([1,2]); const file = {id:'f',label:'Image1',name:'shot.png',bytes,previewUrl:null};
  const s = slice('A',['f']); s.to = ['null'];
  const batch = freezeBatch([s], new Map([['f',file]]),true);
  bytes[0] = 9; s.to[0] = 'jigga';
  assert.deepEqual([...batch[0].payload.files[0].bytes],[1,2]);
  assert.deepEqual(batch[0].payload.to,['null']);
  assert.equal(batch[0].payload.tldr,true);
  assert.throws(()=>freezeBatch([s],new Map([['f',{...file,bytes:null}]]),false),/reading/i);
});

test('one synchronous start claims every queue and retries only failed slices', async () => {
  const f = fixture(); const a = f.api('A'); const c = f.api('C'); f.api('D');
  const batch = freezeBatch([slice('A'),slice('C'),{...slice('D'),command:'compact'}],new Map(),false);
  let changed = 0; startBatch(batch,f.apis,()=>changed++);
  assert.deepEqual(batch.map(s=>s.state),['queued','queued','queued']);
  assert.ok(batch.every(s=>s.ref));
  c.emit(1,'failed',new Error('host offline'));
  assert.equal(batch[1].reason,'host offline');
  await retryFailed(batch,f.apis);
  assert.deepEqual(f.calls.map(c=>c.slice(0,2)),[['A','submit'],['C','submit'],['D','command'],['C','retry']]);
  a.emit(1,'posted'); assert.equal(batch[0].state,'sent'); assert.ok(changed > 0);
  stopBatch(batch);
});

test('closed queue retry uses frozen payload on new host and changes queue and host together', async () => {
  const f = fixture(); const old = f.api('C');
  const batch=freezeBatch([slice('C')],new Map(),true); startBatch(batch,f.apis,()=>{});
  old.emit(1,'closed'); const next=f.api('C','new-queue','new-host');
  await retryFailed(batch,f.apis);
  assert.equal(batch[0].ref.queue,next.queue); assert.equal(batch[0].hostId,'new-host');
  assert.equal(f.calls.at(-1)[2].tldr,true); assert.equal(batch[0].state,'queued');
  stopBatch(batch);
});

test('unknown acknowledgement never retries automatically, explicit send again resubmits once', async () => {
  const f=fixture(); const old=f.api('C'); const batch=freezeBatch([slice('C')],new Map(),false);
  startBatch(batch,f.apis,()=>{}); old.emit(1,'unknown'); f.api('C','other','new-host');
  await retryFailed(batch,f.apis); assert.equal(f.calls.length,1); assert.equal(batch[0].sendAgain,true);
  assert.match(batch[0].reason,/another machine/);
  await sendAgain(batch,'C',f.apis); assert.equal(f.calls.length,2); assert.equal(batch[0].hostId,'new-host');
  await sendAgain(batch,'C',f.apis); assert.equal(f.calls.length,2);
  stopBatch(batch);
});

test('discard removes failed item without its watch turning the slice into send-again', () => {
  const f=fixture(); const c=f.api('C'); const batch=freezeBatch([slice('C')],new Map(),false);
  startBatch(batch,f.apis,()=>{}); c.emit(1,'failed','offline'); discardFailed(batch,f.apis);
  assert.deepEqual(f.calls.at(-1),['C','remove']); assert.equal(batch[0].state,'sent');
});

test('missing API retains failure and watches old queue through unregistration', async () => {
  const f=fixture(); const c=f.api('C'); const batch=freezeBatch([slice('C')],new Map(),false);
  startBatch(batch,f.apis,()=>{}); f.remove('C'); c.emit(1,'closed');
  await retryFailed(batch,f.apis); assert.match(batch[0].reason,/Open C in this window/);
  assert.equal(batch[0].sendAgain,false); stopBatch(batch);
});

for (const [state, expected] of [['posted', 'sent'], ['failed', 'failed']]) {
  test(`retry after an initially missing API publishes later ${state} updates`, async () => {
    const f=fixture(); const batch=freezeBatch([slice('C')],new Map(),false);
    const published=[];
    startBatch(batch,f.apis,current=>published.push(current[0].state));
    assert.equal(batch[0].state,'failed');
    const c=f.api('C');
    await retryFailed(batch,f.apis);
    await Promise.resolve();
    c.emit(1,state,state==='failed'?new Error('host offline'):undefined);
    assert.deepEqual(published,['failed','queued',expected]);
    stopBatch(batch);
  });
}

test('a synchronous terminal watch can dispose the batch before watch returns', () => {
  let stopped=0;const f=fixture();const api=f.api('C');
  api.watch=(_ref,cb)=>{cb('posted');return()=>stopped++;};
  const batch=freezeBatch([slice('C')],new Map(),false);
  startBatch(batch,f.apis,current=>{if(current.every(s=>s.state==='sent'))stopBatch(current);});
  assert.equal(stopped,1);
});
