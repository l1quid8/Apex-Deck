import test from 'node:test';
import assert from 'node:assert/strict';
import { chatFolder, changeFolder, mountWorktree } from '../src/worktreeMount.ts';

test('mounted chat folder wins, task execution stays authoritative', () => {
  assert.equal(chatFolder({mount:'/tree'}, {path:'/repo'}), '/tree');
  assert.equal(chatFolder({mount:'/tree', executionPath:'/task'}, {path:'/repo'}), '/task');
  assert.equal(chatFolder({}, {path:'/repo'}), '/repo');
});
test('historical chip provenance survives multiple mounts including a return', () => {
  const mounts=[{seq:3,from:'/repo',to:'/tree'}, {seq:8,from:'/tree',to:'/repo'}];
  assert.equal(changeFolder(mounts,2,'/repo'),'/repo');
  assert.equal(changeFolder(mounts,3,'/repo'),'/tree');
  assert.equal(changeFolder(mounts,7,'/repo'),'/tree');
  assert.equal(changeFolder(mounts,8,'/repo'),'/repo');
});
test('mount verifies reopened room folder before returning success', async () => {
  const seen=[];
  const route={call:async(cmd,args)=>{seen.push([cmd,args]);return{cwd:'/tree'};},roomCreate:async(...args)=>seen.push(['open',...args]),roomState:async()=>({cwd:'/tree'})};
  assert.equal(await mountWorktree(route,'chat','/tree',{policy:'mention'}),'/tree');
  assert.deepEqual(seen[0],['room_mount',{id:'chat',cwd:'/tree'}]);
  assert.equal(seen[1][0],'open');
  route.roomState=async()=>({cwd:'/repo'});
  await assert.rejects(mountWorktree(route,'chat','/tree',{}),/folder/);
});

// The daemon commits the cwd before roomCreate; a reopen failure must not leave
// the Files panel and project label pointing at the old checkout.
test('mount publishes the committed folder even when reopening fails', async () => {
  let shown = '/repo';
  const route = {
    call: async () => ({cwd:'/tree'}),
    roomCreate: async () => { throw Error('provider setup failed'); },
  };
  await assert.rejects(mountWorktree(route, 'chat', '/tree', {}, cwd => { shown = cwd; }), /provider setup failed/);
  assert.equal(shown, '/tree');
});
test('mount reconciles an authoritative fallback before reporting a folder mismatch', async () => {
  let shown = '/repo';
  const route = {
    call: async () => ({cwd:'/tree'}), roomCreate: async () => ({}),
    roomState: async () => ({cwd:'/fallback'}),
  };
  await assert.rejects(mountWorktree(route, 'chat', '/tree', {}, cwd => { shown = cwd; }), /folder/);
  assert.equal(shown, '/fallback');
});
