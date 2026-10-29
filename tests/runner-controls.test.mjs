import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runnerCommand, mutateRunner } from '../src/runner/client.ts';
import { defaultLimits } from '../src/runner/types.ts';

test('start uses captured recipients, limits and parsed interval, never roomPost', async () => {
  let started;
  const backend = { roomRunnerState: async () => null, roomRunnerStart: async (...args) => { started = args; return {applied:{id:'r',kind:'loop',phase:'scheduled'}}; } };
  const result = await runnerCommand(backend, 'room', 'loop', '1m check build', ['b','a'], defaultLimits());
  assert.equal(result.snapshot.kind, 'loop');
  assert.deepEqual(started[4].workers, ['b','a']);
  assert.equal(started[4].intervalSeconds, 60);
});
test('wrong-kind controls refuse without mutating; clear requires inline confirmation', async () => {
  let calls=0;
  const snapshot = {id:'r',revision:5,kind:'goal',phase:'waiting'};
  const backend = {roomRunnerState: async () => snapshot, roomRunnerAction: async () => {calls++;}};
  await assert.rejects(runnerCommand(backend,'room','loop','pause',[],defaultLimits()), /goal/);
  assert.equal((await runnerCommand(backend,'room','goal','clear',[],defaultLimits())).confirmEnd,true);
  assert.equal(calls,0);
});
test('conflicting mutation returns authoritative snapshot; unsupported hosts explain failure', async () => {
  const fresh={id:'r',revision:9,kind:'goal'};
  assert.deepEqual(await mutateRunner({roomRunnerAction:async()=>({conflict:fresh})},'room',{id:'r',revision:8},'pause'),fresh);
  await assert.rejects(runnerCommand({},'room','goal','fix',[],defaultLimits()),/support/);
});

test('start binds room revision and explicit worker, checker and argv-check configuration', async()=>{
 let sent;
 const backend={roomRunnerState:async()=>null,roomState:async()=>({roomRevision:17}),roomRunnerStart:async(...args)=>{sent=args;return{applied:{id:'r',kind:'goal',phase:'running'}};}};
 const config={workers:['worker'],checker:'checker',checks:[{id:'types',argv:['npx','tsc','--noEmit'],timeoutMs:30000}]};
 await runnerCommand(backend,'room','goal','start pause',['other'],defaultLimits(),config);
 assert.equal(sent[2],17);assert.equal(sent[4].objective,'pause');assert.deepEqual(sent[4].workers,['worker']);assert.equal(sent[4].checker,'checker');assert.deepEqual(sent[4].checks,config.checks);
});
