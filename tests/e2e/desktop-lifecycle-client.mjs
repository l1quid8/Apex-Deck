// Invoked by the CLI integration test against its throwaway fixture. Exercises
// the desktop's real command adapter, project actions and reconciliation.
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { DaemonClient } from '../../src/daemon/client.ts';
import { commandBackend } from '../../src/commandBackend.ts';
import { changeProject } from '../../src/projectLifecycle.ts';
import { emptyCatalog, withListedChatResponse } from '../../src/chatCatalog.ts';
import { discoverWorkspaces, reconcileWorkPanes } from '../../src/workThreadMetadata.ts';
import { socketLink } from './link.mjs';

const [data, phase, cwd] = process.argv.slice(2);
const client = new DaemonClient(() => socketLink(path.join(data,'daemon.sock')));
try {
  await client.start();
  const backend = commandBackend({call:(cmd,args)=>client.call(cmd,args),listen:async(event,cb)=>client.on(event,cb),supports:()=>true},{});
  const workspace = {id:'desktop-project',name:'Desktop project',path:cwd};
  const pane = {id:'desktop-thread',workspaceId:workspace.id,kind:'chat',title:'Desktop thread'};
  if (phase === 'create') {
    await changeProject(backend,workspace,'add','Desktop project');
    await backend.sessionSave({version:1,workspaces:[workspace],panes:[pane],profiles:[],future:{kept:true}});
    await backend.roomCreate(pane.id,[],{policy:'mention',max_bot_hops:0},cwd);
    await backend.call('chat_update_meta',{id:pane.id,title:pane.title});
  } else if (phase === 'folder') {
    const target = fs.realpathSync(path.join(data,'other-project'));
    const reply = await backend.call('chat_list',{});
    const catalog = withListedChatResponse(emptyCatalog(),'local','Mac',reply,1);
    const projects = discoverWorkspaces([workspace],catalog,()=>true,()=> 'other',()=> 'folder');
    const panes = reconcileWorkPanes([pane],projects,catalog,emptyCatalog(),()=>true);
    assert.equal(projects.find(w=>w.id===panes[0].workspaceId).path,target);
    assert.equal((await backend.roomState(pane.id)).cwd,target);
  } else if (phase === 'edit') {
    const reply = await backend.call('chat_list',{});
    const catalog = withListedChatResponse(emptyCatalog(),'local','Mac',reply,1);
    const projects = discoverWorkspaces([workspace],catalog,()=>true,()=> 'new',()=> 'folder');
    assert.equal(projects[0].name,'CLI project');
    const panes = reconcileWorkPanes([pane],projects,catalog,emptyCatalog(),()=>true);
    assert.equal(panes[0].title,'CLI renamed thread');
    await changeProject(backend,projects[0],'rename','Desktop renamed project');
    await backend.call('chat_update_meta',{id:pane.id,title:'Desktop renamed thread'});
    await backend.call('room_set_trashed',{id:pane.id,trashed:true});
  } else if (phase === 'deleted') {
    const raw = await backend.call('chat_list',{});
    const catalog = withListedChatResponse(emptyCatalog(),'local','Mac',raw,1);
    const projects = discoverWorkspaces([workspace],catalog,()=>true,()=> 'new',()=> 'folder');
    assert.equal(projects[0].hidden,true);
    assert.deepEqual(reconcileWorkPanes([pane],projects,catalog,emptyCatalog(),()=>true),[]);
    await assert.rejects(backend.roomCreate(pane.id,[],{policy:'mention',max_bot_hops:0},cwd),/deleted/);
    // An old desktop save cannot undo either lifecycle operation.
    await backend.sessionSave({version:1,workspaces:[workspace],panes:[pane],profiles:[],future:{kept:true}});
    const saved = await backend.sessionLoad();
    assert.equal(saved.workspaces[0].hidden,true);
    assert.deepEqual(saved.panes,[]);
    await changeProject(backend,projects[0],'add');
  } else { throw Error(`Unknown test phase ${phase}`); }
  process.stdout.write('DESKTOP_LIFECYCLE_OK\n');
} finally { client.close(); }
