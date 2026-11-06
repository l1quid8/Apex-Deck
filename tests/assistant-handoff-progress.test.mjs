import test from 'node:test';
import assert from 'node:assert/strict';
import {deriveHandoffPill,deriveHandoffPopover,handoffQuestionKey,startLabel} from '../src/assistantHandoffModel.ts';
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
test('a follow-up question at the same task revision refreshes the paused controls',()=>{
 // Installed 6d0061c9: ask-2 arrived while task stayed needs_you at one revision, so Alfred's chat kept ask-1's stale state.
 const asked={...task,status:'needs_you',conversationEvents:[{id:'r:7:question',taskId:'t',kind:'question',text:'Waiting for your answer',atMs:1}]};
 const answered={...asked,conversationEvents:[...asked.conversationEvents,{id:'r:8:question_resolved',taskId:'t',kind:'question_resolved',text:'Question ask-1 answered',atMs:2}]};
 const followUp={...answered,conversationEvents:[...answered.conversationEvents,{id:'r:13:question',taskId:'t',kind:'question',text:'Waiting for your answer',atMs:3}]};
 const keys=[asked,answered,followUp].map(handoffQuestionKey);
 assert.equal(new Set(keys).size,3);
 assert.equal(handoffQuestionKey({...followUp,conversationEvents:[...followUp.conversationEvents,{id:'r:14:milestone',taskId:'t',kind:'milestone',text:'Working',atMs:4}]}),keys[2],'ordinary progress does not refetch the question');
});
test('the worker picker never offers to start with an agent nobody ticked',()=>{
 assert.equal(startLabel(0),'Tick an agent to start');
 assert.equal(startLabel(1),'Start with 1 agent');
 assert.equal(startLabel(2),'Start with 2 agents');
});
