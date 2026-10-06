import test from 'node:test';
import assert from 'node:assert/strict';
import { addFolders } from '../src/workspaces.ts';
import { restoredLayouts, savedLayouts } from '../src/closing.ts';
const mod = await import('../src/hostSession.ts').catch(() => ({}));
const base = () => ({ version: 1, workspaces: [{id:'mac',name:'Deck',path:'/code/deck'}], panes:[{id:'m',workspaceId:'mac',kind:'chat',title:'Mac'}], profiles:[], activeWorkspace:'mac',focusedPane:'m',section:'threads',layout:'left',layouts:{'mac:threads':{kind:'leaf',id:'m'}} });
test('same directory on distinct hosts creates distinct workspaces', () => {
  const {list, ids} = addFolders(base().workspaces, ['/code/deck'], ()=>'remote', ()=> 'Deck','h-at');
  assert.deepEqual(ids,['remote']); assert.equal(list[1].hostId,'h-at');
});
test('remote import closes chats and retains local selection, pins and preferences', () => {
  assert.equal(typeof mod.mergeHostSession,'function');
  const remote = {...base(), workspaces:[{id:'vps',name:'Renamed',path:'/srv/deck'}],panes:[{id:'r',workspaceId:'vps',kind:'chat',title:'Server',pinned:true}]};
  const {session} = mod.mergeHostSession(base(),'h-at',remote);
  assert.equal(session.workspaces[1].hostId,'h-at'); assert.equal(session.workspaces[1].family,'deck');
  assert.equal(session.panes[1].closed,true); assert.equal(session.panes[1].pinned,true);
  assert.equal(session.focusedPane,'m'); assert.deepEqual(session.profiles,[]);
  assert.deepEqual(mod.mergeHostSession(session,'h-at',remote).session,session);
});
test('workspace collisions remap threads; conflicting room ids are skipped', () => {
  assert.equal(typeof mod.mergeHostSession,'function');
  const remote = {...base(),panes:[{id:'r',workspaceId:'mac',kind:'chat',title:'Server'},...base().panes]};
  const {session,conflicts} = mod.mergeHostSession(base(),'h-at',remote);
  assert.equal(session.workspaces.length,2); assert.notEqual(session.workspaces[1].id,'mac');
  assert.equal(session.panes[1].workspaceId,session.workspaces[1].id); assert.equal(session.panes.length,2);
  assert.ok(conflicts.includes('m'));
});
test('malformed imports never mark success; empty successful import does', () => {
  assert.equal(typeof mod.mergeHostSession,'function');
  assert.throws(()=>mod.mergeHostSession(base(),'h-at',{version:1,workspaces:'junk'}));
  assert.deepEqual(mod.mergeHostSession(base(),'h-at',null).session.importedHostSessions,['h-at']);
});
test('shared migration keeps visible panes from all projects and round trips section keys', () => {
  assert.equal(typeof mod.migrateCanvasLayouts,'function');
  const old=base(); old.workspaces.push({id:'vps',name:'API',path:'/srv/api'});
  old.panes.push({id:'r',workspaceId:'vps',kind:'chat',title:'Server'}, {id:'c',workspaceId:'mac',kind:'chat',title:'Closed',closed:true});
  old.layouts['vps:threads']={kind:'leaf',id:'r'};
  const session=mod.migrateCanvasLayouts(old);
  assert.equal(session.canvasVersion,1);
  assert.deepEqual(session.layouts[':threads'],{kind:'split',dir:'row',children:[{kind:'leaf',id:'m'},{kind:'leaf',id:'r'}],sizes:[.5,.5]});
  assert.deepEqual(mod.migrateCanvasLayouts(session),session);
  assert.deepEqual(restoredLayouts(savedLayouts(session.layouts,['mac','vps']),session.panes),session.layouts);
});
