import test from 'node:test';
import assert from 'node:assert/strict';
const mod=await import('../src/paneHost.ts').catch(()=>({}));
test('pane resolves its bound workspace, never a local fallback',()=>{
  assert.equal(typeof mod.paneDestination,'function');
  const workspace={id:'vps',name:'API',path:'/srv/api',hostId:'h-at'};
  assert.deepEqual(mod.paneDestination({workspaceId:'vps'},[workspace]),{workspace,hostId:'h-at'});
  assert.throws(()=>mod.paneDestination({workspaceId:'gone'},[workspace]),/workspace/i);
});
