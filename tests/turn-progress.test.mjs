import test from 'node:test';
import assert from 'node:assert/strict';
import { applyProgressEvent, restoreProgress } from '../src/turnProgress.ts';
const step={key:'cmd',parent:null,kind:'command',label:'Test',folder:null,detail:'test',output:null,status:'running',exit_code:null,duration_ms:null};
test('successful compaction clears only the summarizer progress before participant idle',()=>{
 let p=applyProgressEvent({}, {type:'turn_started',id:'a'});
 p=applyProgressEvent(p, {type:'work_step',id:'a',step});
 p=applyProgressEvent(p, {type:'turn_started',id:'b'});
 const other=p.b;
 p=applyProgressEvent(p, {type:'compacted',id:'a',summary:'Saved summary',upto:2});
 assert.equal(p.a,undefined);
 assert.equal(p.b,other);
 p=applyProgressEvent(p, {type:'participant_idle',id:'a'});
 assert.equal(p.a,undefined);
 assert.equal(p.b,other);
 p=applyProgressEvent(p, {type:'idle'});
 assert.equal(p.a,undefined);
});
test('compaction interrupted before success still records stopped progress',()=>{
 let p=applyProgressEvent({}, {type:'turn_started',id:'a'});
 p=applyProgressEvent(p, {type:'work_step',id:'a',step});
 p=applyProgressEvent(p, {type:'participant_idle',id:'a'});
 assert.equal(p.a.outcome,'stopped');
 assert.equal(p.a.steps[0].status,'stopped');
});
test('interrupted progress survives idle without completing its checklist and resets on the next turn',()=>{
 let p=applyProgressEvent({}, {type:'turn_started',id:'a'});
 p=applyProgressEvent(p, {type:'work_step',id:'a',step});
 p=applyProgressEvent(p, {type:'todo',id:'a',items:[{text:'Verify',status:'in_progress'}]});
 p=applyProgressEvent(p, {type:'failed',id:'a',error:'Connection lost'});
 assert.equal(p.a.outcome,'failed'); assert.equal(p.a.steps[0].status,'stopped'); assert.equal(p.a.todo[0].status,'in_progress');
 p=applyProgressEvent(p,{type:'idle'});assert.equal(p.a.outcome,'failed');
 assert.equal(applyProgressEvent(p,{type:'work_step',id:'a',step}),p);
 p=applyProgressEvent(p,{type:'turn_started',id:'a'});assert.equal(p.a.outcome,undefined);assert.equal(p.a.steps.length,0);
});
test('restoration includes interrupted progress but successful reply clears its pending record',()=>{
 const p=restoreProgress({a:{by:'a',seq:0,steps:[step],todo:[],dropped:0,outcome:'stopped'}},[]);
 assert.equal(p.a.outcome,'stopped');
 assert.deepEqual(applyProgressEvent(p,{type:'message_added',message:{speaker:{kind:'bot',id:'a'}}}),{});
 assert.deepEqual(Object.keys(restoreProgress({},['b'])),['b']);
});
