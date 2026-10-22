import test from 'node:test';
import assert from 'node:assert/strict';
import { selectTurnFiles, reconcileSelection, gitGates } from '../src/gitChanges.ts';
const files = [{path:'packages/app/src/A.tsx'}, {path:'src/A.tsx'}, {path:'gone.ts',stagedOnly:true}];
test('turn selection matches absolute and workspace-relative files without selecting unrelated basenames', () => {
  assert.deepEqual(selectTurnFiles(files, ['/repo/packages/app/src/A.tsx','./src/A.tsx','old.ts'], '/repo', '/repo/packages/app'), ['packages/app/src/A.tsx']);
  assert.deepEqual(selectTurnFiles(files, ['/outside/src/A.tsx'], '/repo', '/repo'), []);
});
test('refresh preserves explicit deselection and never silently selects new files', () => {
  assert.deepEqual(reconcileSelection(files, ['src/A.tsx','missing.ts']), ['src/A.tsx']);
  assert.deepEqual(selectTurnFiles(files, ['gone.ts'], '/repo', '/repo'), []);
});
const state={branch:'feat/test',target:'main',ahead:2,behind:0,clean:true,checksPassed:true,files:[]};
test('merge requires a checked clean branch ahead of its target and blocks detached or behind branches', () => {
  assert.equal(gitGates(state).merge, true);
  for(const change of [{clean:false},{checksPassed:false},{branch:null},{branch:'main'},{target:null},{ahead:0},{behind:1}]) assert.equal(gitGates({...state,...change}).merge, false);
  assert.equal(gitGates({...state,clean:false}).pr, true);
  assert.equal(gitGates({...state,clean:false}).checks, false);
});
