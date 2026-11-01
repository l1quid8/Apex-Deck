import test from 'node:test';
import assert from 'node:assert/strict';
const mod = await import('../src/assistantViewContext.ts').catch(()=>({}));
test('pane snapshot contains only open same-machine project threads and puts focus first',()=>{
 const workspaces=[{id:'local',hostId:'local'},{id:'remote',hostId:'server'},{id:'hidden',hidden:true}];
 const pane=(id,workspaceId='local',extra={})=>({id,workspaceId,kind:'chat',...extra});
 const panes=[pane('a'),pane('b'),pane('closed','local',{closed:true}),pane('archived','local',{archived:true}),pane('foreign','remote'),pane('hidden','hidden'),pane('shell','local',{kind:'terminal'}),pane('missing','gone'),pane('deleting')];
 assert.equal(typeof mod.assistantViewContext,'function');
 assert.deepEqual(mod.assistantViewContext({routeHostId:'local',hostId:'machine',workspaces,panes,focusedPane:'b',excluded:new Set(['deleting'])}),{hostId:'machine',focusedThreadId:'b',openThreadIds:['b','a']});
 assert.deepEqual(mod.assistantViewContext({routeHostId:'server',hostId:'remote-machine',workspaces,panes,focusedPane:'a'}),{hostId:'remote-machine',openThreadIds:['foreign']});
});
test('pane snapshots are bounded and do not retain mutable source arrays',()=>{
 assert.equal(typeof mod.assistantViewContext,'function');
 const panes=Array.from({length:100},(_,i)=>({id:`t${i}`,kind:'chat',workspaceId:'w'}));
 const result=mod.assistantViewContext({routeHostId:'local',hostId:'machine',workspaces:[{id:'w'}],panes,focusedPane:'t99'});
 assert.equal(result.openThreadIds.length,64);assert.equal(result.openThreadIds[0],'t99');panes[99].id='changed';assert.equal(result.focusedThreadId,'t99');
});
