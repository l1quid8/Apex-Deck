import test from 'node:test';
import assert from 'node:assert/strict';
import { workPresentation as present } from '../src/workThreadMetadata.ts';
import { emptyCatalog, parseChatList, withListedRooms, withRoom } from '../src/chatCatalog.ts';
import { sidebarSections } from '../src/sidebarModel.ts';
import { canvasPanes } from '../src/canvasPanes.ts';

const listed = (catalog, host, rows, at = 1) => withListedRooms(catalog, host, host, parseChatList(host, {rooms: rows}), at);
const work = (id, cwd, cwdAvailable) => ({id, kind:'work', cwd, cwdAvailable});
const session = () => ({
  workspaces: [{id:'gone',name:'Gone',path:'/gone'}, {id:'live',name:'Live',path:'/live'}],
  panes: [
    {id:'old',workspaceId:'gone',kind:'chat',title:'Old thread',pinned:true,activeAt:5},
    {id:'archived',workspaceId:'gone',kind:'chat',title:'Archived history',archived:true,closed:true},
    {id:'terminal',workspaceId:'gone',kind:'terminal',title:'Old terminal'},
    {id:'good',workspaceId:'live',kind:'chat',title:'Current thread'},
  ],
});
test('a saved missing project leaves sidebar, pinned, recents, and canvas without deleting history', () => {
  const saved = session();
  const snapshot = JSON.stringify(saved);
  const catalog = listed(emptyCatalog(), 'local', [work('old', '/gone', false), work('good', '/live', true)]);
  // The same saved session is loaded again at relaunch; presentation must not resurrect its missing folder.
  for (const records of [saved, JSON.parse(snapshot)]) {
    const view = present(records.workspaces, records.panes, catalog, () => true);
    const sidebar = sidebarSections(view.panes, view.workspaces, 'threads', new Set());
    assert.deepEqual(sidebar.projects.map(p => p.workspace.id), ['live']);
    assert.deepEqual(sidebar.pinned, []);
    assert.deepEqual(sidebar.recents, []);
    assert.deepEqual(sidebar.archived, []);
    assert.deepEqual(canvasPanes(view.panes, view.workspaces, new Set(), 'threads').map(p => p.id), ['good']);
    assert.deepEqual(view.panes.map(p => p.id), ['good']);
    assert.equal(JSON.stringify(records), snapshot, 'saved project, terminal, and conversations are untouched');
  }
  const restored = listed(catalog, 'local', [work('old', '/gone', true), work('good', '/live', true)], 2);
  const view = present(saved.workspaces, saved.panes, restored, () => true);
  assert.equal(view.workspaces, saved.workspaces);
  assert.equal(view.panes, saved.panes);
});

test('missing-folder evidence is scoped to a complete list on the online owning host', () => {
  const workspaces = [
    {id:'local',name:'Local',path:'/same'},
    {id:'remote',name:'Remote',path:'/same',hostId:'server'},
    {id:'unknown',name:'Unknown',path:'/unknown'},
    {id:'unlisted',name:'No rooms',path:'/no-rooms'},
    {id:'empty',name:'Talk',path:''},
  ];
  const panes = workspaces.map(w => ({id:`thread-${w.id}`,workspaceId:w.id,kind:'chat',title:w.name}));
  const catalog = listed(listed(emptyCatalog(), 'local', [work('local-row', '/same', false), work('legacy', '/unknown', undefined)]), 'server', [work('remote-row', '/same', true)]);
  assert.deepEqual(present(workspaces, panes, catalog, () => true).workspaces.map(w => w.id), ['remote','unknown','unlisted','empty']);
  assert.equal(present(workspaces, panes, catalog, host => host !== 'local').workspaces, workspaces, 'offline evidence does not hide projects');
  const partial = withRoom(emptyCatalog(), 'local', 'Local', parseChatList('local', {rooms:[work('row', '/same', false)]})[0]);
  assert.equal(present(workspaces, panes, partial, () => true).workspaces, workspaces, 'an incremental row is not a complete folder check');
});

test('unknown or conflicting folder checks do not hide projects; explicitly removed projects stay removed', () => {
  const saved = session();
  saved.workspaces[0].hidden = true;
  for (const available of [true, undefined]) {
    const catalog = listed(emptyCatalog(), 'local', [work('old', '/gone', false), work('other', '/gone', available)]);
    const view = present(saved.workspaces, saved.panes, catalog, () => true);
    assert.equal(view.workspaces, saved.workspaces);
    assert.deepEqual(sidebarSections(view.panes, view.workspaces, 'threads', new Set()).projects.map(p => p.workspace.id), ['live']);
    assert.equal(saved.workspaces[0].hidden, true);
  }
});

test('a deleted thread worktree is hidden inside a live project without hiding its other threads', () => {
  const workspaces = [{id:'live',name:'Live',path:'/live'}];
  const panes = [
    {id:'old-copy',workspaceId:'live',kind:'chat',title:'Deleted worktree',mount:'/gone-copy'},
    {id:'good',workspaceId:'live',kind:'chat',title:'Live thread'},
    {id:'remote',workspaceId:'live',hostId:'server',kind:'chat',title:'Different host'},
  ];
  const catalog = listed(emptyCatalog(), 'local', [work('old-copy','/gone-copy',false),work('good','/live',true),work('remote','/removed',false)]);
  const view = present(workspaces, panes, catalog, () => true);
  assert.equal(view.workspaces, workspaces);
  assert.deepEqual(view.panes.map(p => p.id), ['good','remote']);
  assert.equal(panes.length, 3, 'deleted worktree history remains saved');
});

test('a live mounted thread keeps its project visible even when the original root was removed', () => {
  const saved = session();
  saved.panes.push({id:'mounted',workspaceId:'gone',kind:'chat',title:'Still working',mount:'/live-copy'});
  const catalog = listed(emptyCatalog(), 'local', [work('old','/gone',false),work('mounted','/live-copy',true)]);
  const view = present(saved.workspaces, saved.panes, catalog, () => true);
  assert.equal(view.workspaces, saved.workspaces);
  assert.deepEqual(view.panes.map(p => p.id), ['archived','terminal','good','mounted']);
});
