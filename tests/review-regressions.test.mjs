import test from 'node:test';
import assert from 'node:assert/strict';
import * as workspaces from '../src/workspaces.ts';
import * as choices from '../src/approvalChoices.ts';
import * as sessions from '../src/hostSession.ts';
import * as terminals from '../src/terminalRun.ts';

test('folder picker merges into workspaces imported while it was open', async () => {
  assert.equal(typeof workspaces.pickWorkspaceFolder, 'function');
  let finish;
  let list = [{id:'mac',name:'Mac',path:'/mac'}]; let selected;
  const picking = workspaces.pickWorkspaceFolder({
    pick:()=>new Promise(r=>finish=r), update:fn=>{list=fn(list);},
    select:id=>{selected=id;}, id:'new', nameOf:()=> 'New', hostId:'local',
  });
  list = [...list, {id:'imported',name:'Remote',path:'/srv',hostId:'at'}];
  finish('/new'); await picking; await new Promise(r=>setImmediate(r));
  assert.deepEqual(list.map(w=>w.id), ['mac','imported','new']);
  assert.equal(selected,'new');
});

test('rejected approval restores controls and a successful retry stays answered', async () => {
  assert.equal(typeof choices.sendApprovalAnswer, 'function');
  let answer = null; const update = value=>{answer=value;};
  let reject;
  const submission = choices.sendApprovalAnswer('always',()=>new Promise((_,r)=>reject=r),update);
  assert.equal(answer,'always'); reject(Error('SSH dropped'));
  await assert.rejects(submission,/SSH dropped/); assert.equal(answer,null);
  let sent;
  await choices.sendApprovalAnswer('once',async(approve,always)=>{sent={approve,always};},update);
  assert.deepEqual(sent,{approve:true,always:false}); assert.equal(answer,'once');
});

test('remote session validation reports malformed data before state updates', () => {
  assert.equal(typeof sessions.prepareHostSession, 'function');
  let queued = false; let error;
  try { const remote=sessions.prepareHostSession({version:1,workspaces:[{id:'bad'}],panes:[]}); queued=true; sessions.mergeHostSession({workspaces:[],panes:[]},'at',remote); }
  catch(e) { error=e; }
  assert.match(String(error),/Malformed server workspaces/); assert.equal(queued,false);
  assert.equal(sessions.prepareHostSession(null),null);
});

test('terminal recovery reattaches a live PTY and keeps another run disabled', async () => {
  assert.equal(typeof terminals.recoverLostRun, 'function');
  const run=terminals.started(terminals.STOPPED,100); let finish;
  let recovered=run;
  const pending=terminals.recoverLostRun(run,()=>new Promise(r=>finish=r),200).then(value=>{recovered=value;});
  assert.equal(terminals.canStart(recovered),false); finish(); await pending;
  assert.equal(terminals.canStart(recovered),false); assert.equal(recovered,run);
});

test('terminal recovery marks only a missing PTY exited and retries uncertain probes', async () => {
  assert.equal(typeof terminals.recoverLostRun, 'function');
  const run=terminals.started(terminals.STOPPED,100);
  const ended=await terminals.recoverLostRun(run,async()=>{throw Error('no terminal with id pane:1');},200);
  assert.equal(ended.state,'exited'); assert.equal(ended.generation,1); assert.equal(ended.at,200);
  assert.equal(terminals.canStart(ended),true);
  await assert.rejects(terminals.recoverLostRun(run,async()=>{throw Error('connection lost');},200),/lost/);
  assert.equal(run.state,'running');
  assert.equal(await terminals.recoverLostRun(terminals.STOPPED,async()=>assert.fail('stopped run must not probe'),200),terminals.STOPPED);
});
