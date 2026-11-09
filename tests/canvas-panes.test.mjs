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

test('legacy top and stale left grids migrate to the Even grid arrangement', async () => {
  const { migrateCanvasLayouts } = await import('../src/hostSession.ts');
  const leaf = id => ({kind:'leaf',id});
  const panes = ['a','b','c'].map(id => ({id,workspaceId:'w',kind:'chat',title:id}));
  const tree = {kind:'split',dir:'row',children:panes.map(pane => leaf(pane.id)),sizes:[1/3,1/3,1/3]};
  for (const layout of ['top','left']) {
    const migrated = migrateCanvasLayouts({version:1,canvasVersion:1,workspaces:[{id:'w',name:'W',path:'/w'}],panes,profiles:[],activeWorkspace:'w',focusedPane:'a',section:'threads',layout,layouts:{':threads':tree}});
    assert.deepEqual(migrated.arrangements?.[':threads'], {mode:'grid',order:['a','b','c'],zoom:1,focusShare:.58});
    assert.equal('layouts' in migrated, false);
  }
});

test('saved arrangements keep zoom and order while unavailable panes leave and restored panes append', async () => {
  const { migrateCanvasLayouts } = await import('../src/hostSession.ts');
  const session = {version:1,canvasVersion:1,workspaces:[{id:'w',name:'W',path:'/w'}],panes:['a','b','closed'].map(id=>({id,workspaceId:'w',kind:'chat',title:id,...(id==='closed'?{closed:true}:{})})),profiles:[],activeWorkspace:'w',focusedPane:'a',section:'threads',arrangements:{':threads':{mode:'right',order:['b','gone','closed'],zoom:2,focusShare:.64}}};
  const migrated = migrateCanvasLayouts(session);
  assert.deepEqual(migrated.arrangements?.[':threads'], {mode:'right',order:['b','a'],zoom:2,focusShare:.64});
});
