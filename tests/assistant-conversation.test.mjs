import test from 'node:test';
import assert from 'node:assert/strict';
import { assistantConversationMessages } from '../src/assistantConversation.ts';

const receipt = { opId:'op-1', phase:'verified', exitCode:0, outputExcerpt:'Thread renamed.', rerunAfterRestart:false, startedAt:5, finishedAt:9 };
const task = { id:'task', goal:'Rename this chat', status:'done', completionCriteria:[], targetHost:'host', updatedAt:9, operation:{tool:'room.rename',host:'host',cwd:'/project',argv:['thread','Review']}, receipts:[receipt] };
const result = { id:'result', role:'assistant', kind:'result', text:'room.rename exited with 0.', at:9, taskId:'task' };
const update = { id:'update', role:'system', kind:'update', text:'Running without asking.', at:3, taskId:'task' };

test('native outcomes use verified operation metadata instead of executing receipts or restating an unproved goal', () => {
  const cases = [
    ['room.create',['thread','created-id','Planning'],'Created the chat “Planning”.'],
    ['room.rename',['thread','Review'],'Renamed the chat to “Review”.'],
    ['room.addParticipant',['thread','participant-id'],'Added the participant to the chat.'],
    ['room.removeParticipant',['thread','participant-id'],'Removed the participant from the chat.'],
    ['room.send',['thread','participant-id','Hello'],'Sent the message to the chat.'],
    ['room.assign',['thread','participant-id','Hello'],'Sent the message to the chat.'],
    ['room.resume',['thread','participant-id'],'Sent the message to the chat.'],
    ['room.read',['thread'],'Read the chat. Its saved messages are in Tasks.'],
    ['room.readFile',['thread','notes.md'],'Read the file. Its contents are in Tasks.'],
  ];
  for (const [tool,argv,want] of cases) {
    const [message] = assistantConversationMessages([update,result],[{...task,operation:{...task.operation,tool,argv}}]);
    assert.equal(message.text,want,tool);
    assert.equal(message.role,'assistant');
    assert.equal(message.taskProblem,undefined);
  }
});

test('a stale done status cannot convert the latest failed, uncertain, attempted or nonzero receipt into success', () => {
  for (const latest of [{...receipt,phase:'failed'}, {...receipt,phase:'uncertain'}, {...receipt,phase:'attempted'}, {...receipt,exitCode:1}]) {
    const [message] = assistantConversationMessages([update,result],[{...task,receipts:[receipt,latest]}]);
    assert.equal(message.taskProblem,true);
    assert.match(message.text,/couldn’t verify/);
    assert.doesNotMatch(message.text,/Renamed/);
  }
});

test('queued and running actions leave ordinary conversation intact without approval acknowledgements', () => {
  const chat = {id:'chat',role:'assistant',kind:'chat',text:'What would you like to do next?',at:4};
  for (const status of ['queued','running','waiting','cancelled']) {
    assert.deepEqual(assistantConversationMessages([update,chat],[{...task,status,receipts:[]}]),[chat]);
  }
});

test('helper reports remain conversational and a helper failure remains actionable', () => {
  const report = {...result,kind:'helper',text:'Found three useful options.'};
  assert.deepEqual(assistantConversationMessages([update,report],[{...task,kind:'helper'}]),[report]);
  const [failure] = assistantConversationMessages([update],[{...task,kind:'helper',status:'failed',receipts:[{...receipt,phase:'failed',note:'The provider is unavailable.'}]}]);
  assert.equal(failure?.taskProblem,true);
  assert.equal(failure?.text,'The provider is unavailable.');
});

test('an automatic helper failure is surfaced even when the host emitted no task-linked message', () => {
  const dispatched = {id:'helpers',role:'system',kind:'update',text:'Sent helpers to look into this.',at:3,eventId:'source'};
  const messages = assistantConversationMessages([dispatched],[{...task,fromEvent:'source',kind:'helper',status:'failed',receipts:[{...receipt,phase:'failed',note:'The provider is unavailable.'}]}]);
  assert.equal(messages.length,2);
  assert.equal(messages[1].taskProblem,true);
  assert.equal(messages[1].taskId,'task');
  assert.equal(messages[1].text,'The provider is unavailable.');
});

test('Clear keeps failures from an earlier source event out of the new conversation', () => {
  const oldRequest={id:'old-request',role:'human',kind:'chat',text:'Research this.',at:2,eventId:'source'};
  const newRequest={id:'new-request',role:'human',kind:'chat',text:'Start something else.',at:6,eventId:'new-source'};
  const failed={...task,fromEvent:'source',kind:'helper',status:'failed',receipts:[{...receipt,phase:'failed',note:'The provider is unavailable.'}]};
  assert.deepEqual(assistantConversationMessages([oldRequest,newRequest],[failed],5),[oldRequest,newRequest]);
});

test('approved hand-off, spend and computer permission tasks settle without execution receipts or false failure messages', () => {
  for (const [kind,tool] of [['handOff','host.command'],['spend','model.reply'],['approve','computer.reply']]) {
    const settled={...task,operation:{...task.operation,tool},decision:{id:'approval',kind,status:'approved',paramsHash:'hash',prompt:'Allow this?',openedAt:2},receipts:[]};
    assert.deepEqual(assistantConversationMessages([update],[settled]),[],tool);
  }
});

test('a consumed reply-cost authorization is not presented as the provider finishing its reply', () => {
  for (const tool of ['model.reply','model.summary']) {
    const approval={id:'approval',kind:'spend',status:'approved',paramsHash:'hash',prompt:'Allow this?',openedAt:2};
    const accounting={...receipt,outputExcerpt:'',note:'One model-call cost authorization consumed before provider invocation.'};
    assert.deepEqual(assistantConversationMessages([update],[{...task,operation:{...task.operation,tool},decision:approval,receipts:[accounting]}]),[],tool);
  }
});

test('a blocked action reports the blocker instead of repeating an older successful receipt', () => {
  const [message] = assistantConversationMessages([update,result],[{...task,status:'blocked',lastUpdate:'Reconnect this Mac before continuing.'}]);
  assert.equal(message.taskProblem,true);
  assert.equal(message.text,'Reconnect this Mac before continuing.');
});

test('multiline command output stays in Tasks while a short plain result stays in the conversation', () => {
  const command = {...task,operation:{...task.operation,tool:'host.command'}};
  for (const [output,want] of [['55G free','55G free'], ['Filesystem Size Used\\n/dev/disk1 1TB 200GB','The action finished. Its output is in Tasks.'], ['{"status":"ok"}','The action finished. Its output is in Tasks.']]) {
    const [message] = assistantConversationMessages([result],[{...command,receipts:[{...receipt,outputExcerpt:output.replace('\\n','\n')}]}]);
    assert.equal(message.text,want);
  }
});

test('delegated milestones project once with saved attribution and keep cleared sources out',()=>{
 const human={id:'human',role:'human',kind:'chat',text:'Please inspect.',at:1,eventId:'source'};
 const job={id:'job',lineage:{sourceEventId:'source'},workerNames:{worker:'Alex'},conversationEvents:[{id:'run:1',taskId:'job',runId:'run',workerId:'worker',atMs:2,kind:'milestone',text:'Started working'},{id:'run:1',taskId:'job',runId:'run',workerId:'worker',atMs:2,kind:'milestone',text:'Started working'}]};
 const shown=assistantConversationMessages([human],[],0,[job]);
 assert.equal(shown.length,2);
 assert.equal(shown[1].text,'Alex: Started working');
 assert.equal(shown[1].role,'system','lifecycle is not an invented worker quote');
 assert.equal(assistantConversationMessages([human],[],3,[job]).length,1);
 assert.equal(assistantConversationMessages([],[],0,[job]).length,0);
});
