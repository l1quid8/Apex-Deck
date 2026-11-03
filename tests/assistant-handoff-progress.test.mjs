import test from 'node:test';
import assert from 'node:assert/strict';
import {deriveHandoffPill,deriveHandoffPopover} from '../src/assistantHandoffModel.ts';
const task={id:'t',revision:1,status:'running',workers:['Hyke','Muck'],attempts:[{runId:'new',finishedAtMs:null}],destination:null};
const progress={taskId:'t',runId:'new',participantId:'Hyke',workerStarted:true,todos:[{text:'first',status:'done'},{text:'second',status:'cancelled'},{text:'third',status:'open'}]};
test('late checklist from an old attempt is excluded in pill and popover',()=>{
 const old={...progress,runId:'old'};
 assert.equal(deriveHandoffPill(task,old).totalCount,undefined);
 assert.equal(deriveHandoffPopover(task,old,[]).steps.length,0);
});
test('a scheduled task does not claim the worker has started',()=>{
 assert.match(deriveHandoffPill(task,{...progress,workerStarted:false,todos:[]}).label,/waiting to start/);
});
test('unknown total never becomes a count of milestone messages',()=>{
 const pop=deriveHandoffPopover(task,undefined,[{id:'e',taskId:'t',runId:'new',kind:'milestone',text:'Started',atMs:1}]);
 assert.equal(pop.steps.length,0);
});
test('cancelled todo stays cancelled and is never completed or active',()=>{
 const pop=deriveHandoffPopover(task,progress,[]);
 assert.equal(pop.steps[1].state,'cancelled');
 assert.equal(deriveHandoffPill(task,progress).doneCount,1);
});
test('host available actions and stopping state are respected',()=>{
 const current={...task,desiredState:'cancelled',availableHandoffActions:['open']};
 assert.equal(deriveHandoffPill(current,progress).status,'stopping');
 assert.deepEqual(deriveHandoffPill(current,progress).availableActions,['open']);
 assert.equal(deriveHandoffPopover({...task,status:'cancelled',availableHandoffActions:['open']},progress,[]).canRetry,false);
});

test('unobserved run claim does not imply that a worker started',()=>{
 assert.match(deriveHandoffPill(task).label,/waiting to start/);
});
test('offline pill cannot advertise a live worker or control actions',()=>{
 const pill=deriveHandoffPill(task,progress,undefined,true);
 assert.match(pill.label,/disconnected/);
 assert.deepEqual(pill.availableActions,['open']);
});
test('saved display names and a failed attempt stay truthful',()=>{
 const named={...task,workerNames:{Hyke:'Alex',Muck:'Sam'},status:'failed'};
 const pill=deriveHandoffPill(named,progress);
 assert.match(pill.label,/Alex \+ Sam/);
 assert.match(pill.label,/couldn.t finish/);
 assert.doesNotMatch(pill.label,/couldn.t start/);
});
