import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyCatalog } from '../src/chatCatalog.ts';
import { discoverWorkspaces, reconcileWorkPanes } from '../src/workThreadMetadata.ts';

const online = host => host !== 'off';
const project = (extra = {}) => ({path:'/repo',name:'Shared name',removed:false,revision:2,...extra});
const catalog = (projects, rooms = [], deletedThreads = []) => ({...emptyCatalog(),hosts:{local:{name:'Mac',listedAt:10,rooms,projects,deletedThreads}}});
const workspace = {id:'w',name:'Old name',path:'/repo'};
const work = {id:'thread',hostId:'local',kind:'work',cwd:'/repo',title:'Thread',archived:false};

test('host project rename and removal reconcile into saved desktop records', () => {
  const renamed = discoverWorkspaces([workspace],catalog([project()]),online,()=> 'new',()=> 'folder');
  assert.equal(renamed[0].name,'Shared name');
  const removed = discoverWorkspaces(renamed,catalog([project({removed:true,revision:3})],[work]),online,()=> 'new',()=> 'folder');
  assert.equal(removed.length,1);
  assert.equal(removed[0].hidden,true);
  assert.equal(discoverWorkspaces(removed,catalog([project({removed:true,revision:3})],[work]),online,()=> 'new',()=> 'folder'),removed,'no discovery loop after Undo');
  const stale = discoverWorkspaces(removed,catalog([project({revision:2})]),online,()=> 'new',()=> 'folder');
  assert.equal(stale[0].hidden,true,'older list cannot undo removal');
  const restored = discoverWorkspaces(stale,catalog([project({revision:4})]),online,()=> 'new',()=> 'folder');
  assert.equal(restored[0].hidden,false);
});

test('empty added projects appear and removed projects are never rediscovered from threads', () => {
  assert.equal(discoverWorkspaces([],catalog([project()]),online,()=> 'new',()=> 'folder')[0].name,'Shared name');
  assert.deepEqual(discoverWorkspaces([],catalog([project({removed:true})],[work]),online,()=> 'new',()=> 'folder'),[]);
  const remote = {...catalog([project({removed:true})]),hosts:{vps:{name:'VPS',listedAt:10,projects:[project()],rooms:[]}}};
  const next = discoverWorkspaces([workspace],remote,online,()=> 'remote',()=> 'folder');
  assert.equal(next.length,2);
  assert.equal(next[1].hostId,'vps');
});

test('durable thread tombstones remove stale saved panes on the first complete list', () => {
  const pane = {id:'thread',kind:'chat',workspaceId:'w',title:'Stale'};
  assert.deepEqual(reconcileWorkPanes([pane],[workspace],catalog([],[],['thread']),emptyCatalog(),online),[]);
  assert.equal(reconcileWorkPanes([pane],[workspace],catalog([],[]),emptyCatalog(),online).length,1,'absence alone does not delete an uncreated draft');
});

test('legacy aliases reconcile to one canonical project without rediscovery', () => {
  const old = {...workspace,path:'/tmp/repo'};
  const projects = discoverWorkspaces([old],catalog([project({aliases:['/tmp/repo'],removed:true})]),online,()=> 'new',()=> 'folder');
  assert.equal(projects.length,1);
  assert.equal(projects[0].path,'/repo');
  assert.equal(projects[0].hidden,true);
  const rawRoom = {...work,cwd:'/tmp/repo',projectCwd:'/tmp/repo',metadataRevision:1};
  const listed = discoverWorkspaces([old],catalog([project({aliases:['/tmp/repo']})],[rawRoom]),online,()=> 'duplicate',()=> 'folder');
  assert.equal(listed.length,1,'raw saved room paths resolve to the same canonical project');
});

test('a host-confirmed folder edit reparents its existing desktop pane', () => {
  const other = {id:'other',path:'/other',name:'Other'};
  const pane = {id:'thread',workspaceId:'w',kind:'chat',title:'Thread'};
  const moved = {...work,cwd:'/other',projectCwd:'/other',metadataRevision:3};
  assert.equal(reconcileWorkPanes([pane],[workspace,other],catalog([], [moved]),emptyCatalog(),online)[0].workspaceId,'other');
  const mounted = {...work,cwd:'/worktree',projectCwd:'/repo',metadataRevision:4};
  const actual = reconcileWorkPanes([pane],[workspace],catalog([], [mounted]),emptyCatalog(),online)[0];
  assert.equal(actual.workspaceId,'w','a worktree mount stays under its original project');
  assert.equal(actual.mount,'/worktree');
});
