import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transform } from 'sucrase';
import { paneSection } from '../src/closing.ts';
import { validArrangement } from '../src/paneArrangement.ts';

const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const source = {id:'source',workspaceId:'source-project',kind:'chat',title:'Source'};
const target = {id:'target-project',path:'/target',name:'Target',hostId:'target-host'};

function harness(name, extra = {}) {
  const declaration = app.match(new RegExp(`const ${name} = [\\s\\S]*?\\n  \\};`))[0];
  const helper = app.match(/const placeNewPaneFirst = [\s\S]*?\n  \};/)?.[0] ?? '';
  const compiled = transform(`${helper}\n${declaration}`, {transforms:['typescript'],disableESTransforms:true}).code;
  const arrangements = {':threads':{mode:'left',order:['existing','source'],zoom:2,focusShare:.64},':code':{mode:'vertical',order:['shell'],zoom:1,focusShare:.58}};
  const panes = [source], workspaces = [{id:source.workspaceId,path:'/source',name:'Source',hostId:'source-host'}, target];
  const state = {focusedPane:'existing',activeWorkspace:'old-project',section:'code',maximized:'existing',picking:true};
  const calls = [];
  const bindings = {
    newId: prefix => prefix === 'ws' ? 'sample-project' : 'new',
    paneSection, validArrangement, layoutKey: (_workspace, section) => `:${section}`,
    setArrangements: update => Object.assign(arrangements, update(arrangements)),
    setPanes: update => { panes.splice(0, panes.length, ...update(panes)); },
    setWorkspaces: update => { workspaces.splice(0, workspaces.length, ...update(workspaces)); },
    ...Object.fromEntries(Object.keys(state).map(key => [`set${key[0].toUpperCase()}${key.slice(1)}`, value => {state[key] = value;}])),
    revealPane: id => calls.push(['reveal',id]),
    workspaces, latest:{current:{workspaces}}, backend: {},
    backendFor: () => ({roomFork:async (...args) => calls.push(['fork',...args])}),
    workspaceHost: workspace => workspace.hostId, hostNameFor: host => host,
    reachable: () => true, hostBackend: id => ({id}),
    flushAnswerStores: async () => {}, snapshotOf: async () => ({transcript:[]}),
    importThreadFork: async args => calls.push(['import',args.id]), historyHasAttachments: () => false,
    unsupported: () => false, toast: message => assert.fail(message),
    ...extra,
  };
  const action = new Function(...Object.keys(bindings), `${compiled}; return ${name};`)(...Object.values(bindings));
  return {action,arrangements,panes,state,calls};
}

for (const name of ['trySample','forkThread','forkTo']) {
  test(`${name} puts its new thread first, focused and ready to reveal`, async () => {
    const h = harness(name);
    if (name === 'trySample') h.action();
    else if (name === 'forkThread') await h.action(source, 'Fork title', null, 4);
    else await h.action(source, target);
    assert.deepEqual(h.arrangements[':threads'], {mode:'left',order:['new','existing','source'],zoom:2,focusShare:.64});
    assert.deepEqual(h.arrangements[':code'].order, ['shell']);
    assert.equal(h.state.focusedPane,'new');
    assert.equal(h.state.section,'threads');
    assert.equal(h.state.activeWorkspace, name === 'trySample' ? 'sample-project' : name === 'forkThread' ? source.workspaceId : target.id);
    assert.equal(h.state.maximized,null);
    assert.equal(h.state.picking,false);
    assert.deepEqual(h.calls.filter(call => call[0] === 'reveal'), [['reveal','new']]);
    assert.equal(h.panes.at(-1).id,'new');
  });
}
