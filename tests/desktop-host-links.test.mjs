import test from 'node:test';
import assert from 'node:assert/strict';
const mod = await import('../desktop/hostLinks.mjs').catch(()=>({}));
test('replacing one host link preserves other hosts and windows and drops stale traffic',async()=>{
  assert.equal(typeof mod.createHostLinks,'function');
  const links=[];const events=[];
  const pool=mod.createHostLinks({open:async(hostId,handlers)=>{
    const link={hostId,handlers,sent:[],closed:false,send(line){this.sent.push(line);},close(){this.closed=true;handlers.onClose('closed');}};
    links.push(link);return link;
  },emit:(...args)=>events.push(args)});
  const m=await pool.connect(1,'local');const r=await pool.connect(1,'at');
  await pool.connect(2,'at');await pool.connect(1,'at');
  pool.send(1,'at',r,'stale');pool.send(1,'local',m,'mac');
  assert.deepEqual(links[0].sent,['mac']);assert.deepEqual(links[1].sent,[]);
  assert.equal(links[0].closed,false);assert.equal(links[1].closed,true);assert.equal(links[2].closed,false);
  links[1].handlers.onLine('stale-event');assert.equal(events.some(e=>e.includes('stale-event')),false);
  pool.destroy(1);assert.equal(links[2].closed,false);
});
test('late opening a link after destruction closes it without publishing events',async()=>{
  assert.equal(typeof mod.createHostLinks,'function');
  let finish;let closed=false;
  const pool=mod.createHostLinks({open:()=>new Promise(r=>finish=r),emit:()=>assert.fail('late event')});
  const opening=pool.connect(1,'at');pool.destroy(1);finish({close(){closed=true;}});
  await assert.rejects(opening,/replaced|closed/i);assert.equal(closed,true);
});
