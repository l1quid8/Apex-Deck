import test from 'node:test';
import assert from 'node:assert/strict';
const mod=await import('../src/canvasPanes.ts').catch(()=>({}));
test('mixed projects remain visible; hidden closed deleting and other sections stay out',()=>{
  assert.equal(typeof mod.canvasPanes,'function');
  const workspaces=[{id:'m'},{id:'r',hostId:'at'},{id:'hidden',hidden:true}];
  const panes=[{id:'a',workspaceId:'m',kind:'chat'},{id:'b',workspaceId:'r',kind:'chat'},{id:'c',workspaceId:'m',kind:'chat',closed:true},{id:'d',workspaceId:'hidden',kind:'chat'},{id:'e',workspaceId:'r',kind:'terminal'}];
  assert.deepEqual(mod.canvasPanes(panes,workspaces,new Set(),'threads').map(p=>p.id),['a','b']);
  assert.deepEqual(mod.canvasPanes(panes,workspaces,new Set(['b']),'threads').map(p=>p.id),['a']);
});
