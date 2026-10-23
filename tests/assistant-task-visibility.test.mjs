import test from 'node:test';import assert from 'node:assert/strict';
import {taskMessageDeleted} from '../src/assistantTaskVisibility.ts';
const project={hostId:'h',workspaceId:'w',cwd:'/repo'},tasks=[{id:'t',resultData:{deletedAtMs:1},lineage:{project}}];
test('deleted personal and delegated messages hide without losing ordinary chat',()=>{assert.equal(taskMessageDeleted({taskId:'p'},[{id:'p',deletedAt:1}],[]),true);assert.equal(taskMessageDeleted({taskId:'t'},[],tasks),true);assert.equal(taskMessageDeleted({},[],tasks),false);});
test('legacy receipt tuples require exact owning project and task',()=>{assert.equal(taskMessageDeleted({taskId:JSON.stringify([project,'t','attempt'])},[],tasks),true);assert.equal(taskMessageDeleted({taskId:JSON.stringify([{...project,hostId:'other'},'t','attempt'])},[],tasks),false);assert.equal(taskMessageDeleted({taskId:'not-json'},[],tasks),false);});
test('durable purge tombstones hide retained chat after interrupted cleanup',()=>{assert.equal(taskMessageDeleted({taskId:'purged'},[],[],['purged']),true);assert.equal(taskMessageDeleted({taskId:JSON.stringify([project,'purged','attempt'])},[],[],['purged']),true);});
