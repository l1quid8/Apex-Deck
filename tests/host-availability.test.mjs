import test from 'node:test';
import assert from 'node:assert/strict';
import { ParticipantQueues } from '../src/turnQueue.ts';
import { pathPromptStore } from '../src/typedPath.ts';
const mod=await import('../src/hostAvailability.ts').catch(()=>({}));
test('only connected destinations allow mutations',()=>{
  assert.equal(typeof mod.hostCanMutate,'function');assert.equal(mod.hostCanMutate({kind:'connected'}),true);
  for(const kind of ['idle','connecting','reconnecting','resync','failed'])assert.equal(mod.hostCanMutate({kind}),false);
});
test('offline send and a drop during target lookup cannot accept or dispatch text',async()=>{
  let online=false;let targets=0;let posts=0;let release;
  const q=new ParticipantQueues(async()=>{targets++;if(!online)return ["bot"];return new Promise(r=>release=r);},async()=>posts++,async()=>{},()=>{},()=>{},()=>online);
  await assert.rejects(q.send('offline'),/connect|offline/i);assert.equal(targets,0);assert.equal(q.items.length,0);
  online=true;const sending=q.send('racing');await new Promise(r=>setTimeout(r,0));online=false;release(['bot']);
  await assert.rejects(sending,/connect|offline/i);assert.equal(posts,0);assert.equal(q.items.length,0);
});
test('accepted queue pauses on drop and replay idle never resumes it',async()=>{
  let online=true;const posts=[];
  const q=new ParticipantQueues(async()=>['bot'],async t=>posts.push(t),async()=>{},()=>{},()=>{},()=>online);
  q.started('bot');await q.send('waiting');online=false;q.availabilityChanged();online=true;q.idle('bot');
  await new Promise(r=>setTimeout(r,0));assert.deepEqual(posts,[]);assert.equal(q.items.length,1);
  q.resume();await new Promise(r=>setTimeout(r,0));assert.deepEqual(posts,['waiting']);
});
test('folder history is separate per host; replaced requests resolve cancelled',async()=>{
  const p=pathPromptStore();const a=p.ask({hostId:'at',kind:'directory',title:'AT'});p.answer('/srv/at');await a;
  assert.equal(p.startAt('at'),'/srv');assert.equal(p.startAt('eu'),null);
  const b=p.ask({hostId:'at',kind:'file',title:'Old'});const c=p.ask({hostId:'eu',kind:'file',title:'New'});assert.equal(await b,null);
  p.answer('/root/key');assert.equal(await c,'/root/key');assert.equal(p.startAt('at'),'/srv');assert.equal(p.startAt('eu'),'/root');
});
