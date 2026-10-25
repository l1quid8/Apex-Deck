import test from 'node:test';
import assert from 'node:assert/strict';
import { PersonalAssistantsCollection } from '../src/usePersonalAssistants.ts';
const defer = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const ref = (hostId, assistantId = 'asst-1') => ({ hostId, assistantId });
const record = (hostId, id = 'asst-1', revision = 1) => ({ id, hostId, revision, name: `${hostId}/${id}`, timezone: 'UTC', profile: null, allowedFolders: [], messages: [], tasks: [], style: '', modes: {read:'ask',write:'ask',send:'ask',spend:'ask'},budget:{},privacy:{localOnly:false,allowedEndpoints:[]},contextBudgetChars:1000 });
function fixture() {
 const calls = [], lists = {local:[record('mac')],a:[record('alpha'),record('alpha','asst-2')],b:[record('beta')]}, offline = new Set(), handlers = {};
 const hosts = [{id:'local',name:'Mac',remote:false},{id:'a',name:'A',remote:true},{id:'b',name:'B',remote:true}];
 const routes = Object.fromEntries(hosts.map(h => [h.id,{host:{connection:{get:()=>({status:{kind:'connected',hostId:{local:'mac',a:'alpha',b:'beta'}[h.id]}})}},call:async(cmd,args)=>{calls.push([h.id,cmd,args]); if(handlers[h.id+':'+cmd]) return handlers[h.id+':'+cmd](args); if(cmd==='personal_list') return lists[h.id]; if(cmd==='personal_machine_claim') return []; return {assistant:record({local:'mac',a:'alpha',b:'beta'}[h.id],args.assistantId,2)};},saveAttachment:async(id,name)=>{calls.push([h.id,'attachment',{id,name}]);return '/saved/'+name;},pickFolder:async()=>'/folder',copyAttachment:async(id)=>{calls.push([h.id,'copy',{id}]);return '/copied';}}]));
 const storage = {value:null,getItem(){return this.value;},setItem(k,v){this.value=v;}};
 const options = {hosts,hostBackend:id=>routes[id],offlineHost:id=>offline.has(id),device:'phone',storage};
 return {collection:new PersonalAssistantsCollection(options),options,calls,lists,offline,handlers,storage,routes};
}
test('collection discovers every local and remote record with durable identities, and persists exact selection',async()=>{
 const f=fixture(); await f.collection.refresh();
 assert.deepEqual(f.collection.snapshot().assistants.map(x=>x.ref),[ref('mac'),ref('alpha'),ref('alpha','asst-2'),ref('beta')]);
 f.collection.select(ref('beta')); const restored=new PersonalAssistantsCollection(f.options);await restored.refresh();assert.deepEqual(restored.snapshot().selected,ref('beta'));
 assert.equal(f.calls.some(([,cmd])=>cmd==='personal_create'),false);
});
test('summaries carry paused, tasks and projects for the shared status, not a status string',async()=>{
 const f=fixture();f.lists.local=[{...record('mac'),paused:true,tasks:[{id:'t',status:'needsYou'}],projects:[{project:{hostId:'mac',workspaceId:'w',cwd:'/r'},tools:'ask'}]}];await f.collection.refresh();
 const mac=f.collection.snapshot().assistants[0];assert.equal(mac.paused,true);assert.deepEqual(mac.personalTasks.map(t=>t.id),['t']);assert.equal(mac.projects[0].project.cwd,'/r');assert.equal('status' in mac,false);
});
test('offline records retain freshness and selection; successful absence removes them and selects an existing identity',async()=>{
 const f=fixture();await f.collection.refresh();f.collection.select(ref('beta'));const seen=f.collection.snapshot().assistants[3].lastSeen;
 f.offline.add('b');f.lists.b=[];await f.collection.refresh();assert.deepEqual(f.collection.snapshot().selected,ref('beta'));assert.equal(f.collection.snapshot().assistants[3].offline,true);assert.equal(f.collection.snapshot().assistants[3].lastSeen,seen);
 await assert.rejects(f.collection.lane(ref('beta')).send('no'),/offline/i);
 f.offline.delete('b');await f.collection.refresh();assert.equal(f.collection.lane(ref('beta')),null);assert.deepEqual(f.collection.snapshot().selected,ref('mac'));
});
test('unsupported and empty hosts are explained; mismatched record ownership is rejected',async()=>{
 const f=fixture();f.handlers['a:personal_list']=()=>{throw new Error('unknown variant personal_list');};f.lists.b=[];f.lists.local=[record('imposter')];await f.collection.refresh();assert.equal(f.collection.snapshot().assistants.length,0);assert.match(f.collection.snapshot().hosts.find(h=>h.routeHostId==='a').problem,/update/i);assert.equal(f.collection.snapshot().hosts.find(h=>h.routeHostId==='b').state,'empty');assert.match(f.collection.snapshot().hosts[0].problem,/owner|identity/i);
});
test('late send, reaction, configure, approval and memory remain on their captured owner and reject stale revisions',async()=>{
 const f=fixture();await f.collection.refresh();const lane=f.collection.lane(ref('alpha'));const pending=defer();f.handlers['a:personal_send']=()=>pending.promise;const work=lane.send('hi');f.collection.select(ref('beta'));pending.resolve({assistant:record('alpha','asst-1',9)});await work;
 for(const action of [()=>lane.react('m','👍',true),()=>lane.configure({name:'new'}),()=>lane.decide('d','hash',true),()=>lane.remember('private'),()=>lane.cancel('t')]) await action();
 assert.deepEqual(f.collection.snapshot().selected,ref('beta'));assert.equal(f.collection.lane(ref('alpha')).assistant.revision,9);await f.collection.refresh();assert.equal(f.collection.lane(ref('alpha')).assistant.revision,9);
 assert.ok(f.calls.filter(([,cmd])=>['personal_send','personal_react','personal_configure','personal_decide','personal_memory_add','personal_cancel'].includes(cmd)).every(([host,,args])=>host==='a'&&args.assistantId==='asst-1'));
});
test('out of order lists cannot delete or regress a newer snapshot',async()=>{
 const f=fixture();await f.collection.refresh();const slow=defer();let n=0;f.handlers['a:personal_list']=()=>++n===1?slow.promise:[record('alpha','asst-1',8)];const old=f.collection.refresh();await f.collection.refresh();slow.resolve([]);await old;assert.equal(f.collection.lane(ref('alpha')).assistant.revision,8);
});
test('attachments carry original owner through selection changes and deleted owners reject late attachments',async()=>{
 const f=fixture();await f.collection.refresh();const lane=f.collection.lane(ref('alpha'));const d=defer();f.routes.a.saveAttachment=async(id)=>{f.calls.push(['a','attachment',{id}]);return d.promise;};const save=lane.saveAttachment('x',new Uint8Array([1]));f.collection.select(ref('beta'));d.resolve('/alpha/x');assert.equal(await save,'/alpha/x');assert.equal(lane.draftKey,'["alpha","asst-1"]');assert.equal(lane.attachmentKey,'["alpha","asst-1"]');await lane.pickFolder();assert.ok(f.calls.some(([host,cmd,args])=>host==='a'&&cmd==='copy'&&args.id==='asst-1'));
 f.lists.a=[];await f.collection.refresh();await assert.rejects(lane.send('gone'),/available|removed/i);
});
test('bridge visits all linked identities while closed and serializes claim passes by owner',async()=>{
 const f=fixture();for(const list of Object.values(f.lists))for(const a of list)a.machines=[{hostId:'mac',name:'Mac',folder:'/folder'}];await f.collection.refresh();f.collection.select(ref('beta'));const pending=defer();f.handlers['a:personal_machine_claim']=()=>pending.promise;const first=f.collection.bridge();await f.collection.bridge();pending.resolve([]);await first;const claims=f.calls.filter(([,cmd])=>cmd==='personal_machine_claim');assert.deepEqual(claims.map(([host,,args])=>[host,args.assistantId]).sort(),[['a','asst-1'],['a','asst-2'],['b','asst-1'],['local','asst-1']]);
});
test('push registers token for all identities, opens exact host owner, and ambiguous old pushes do not select by id',async()=>{
 const f=fixture();await f.collection.refresh();await f.collection.registerPushToken('token');assert.equal(f.calls.filter(([,cmd])=>cmd==='personal_push_register').length,4);f.collection.openNotification({notification:{data:{hostId:'beta',assistantId:'asst-1'}}});assert.deepEqual(f.collection.snapshot().selected,ref('beta'));assert.equal(f.collection.openNotification({notification:{data:{assistantId:'asst-1'}}}),null);assert.deepEqual(f.collection.snapshot().selected,ref('beta'));
});

test('a list started before a completed write cannot remove its updated owner', async()=>{
 const f=fixture();await f.collection.refresh();const slow=defer(), sent=defer();f.handlers['a:personal_list']=()=>slow.promise;f.handlers['a:personal_send']=()=>sent.promise;const write=f.collection.lane(ref('alpha')).send('new');const poll=f.collection.refresh();sent.resolve({assistant:record('alpha','asst-1',2)});await write;slow.resolve([]);await poll;assert.equal(f.collection.lane(ref('alpha')).assistant.revision,2);
});
test('deleting an owner while an attachment is pending rejects the saved path',async()=>{
 const f=fixture();await f.collection.refresh();const d=defer();f.routes.a.saveAttachment=async()=>d.promise;const work=f.collection.lane(ref('alpha')).saveAttachment('x',new Uint8Array([1]));f.lists.a=[];await f.collection.refresh();d.resolve('/old/x');await assert.rejects(work,/removed/i);assert.equal(f.collection.lane(ref('alpha')),null);
});
test('legacy configure rejects unsupported extended fields before sending any mutation',async()=>{
 const f=fixture();await f.collection.refresh();const lane=f.collection.lane(ref('alpha'));assert.throws(()=>lane.configure({profile:{}}),/support/i);assert.throws(()=>lane.configure({look:{seed:'new'}}),/support/i);assert.equal(f.calls.some(([,cmd])=>cmd==='personal_configure'),false);
});
test('a notification during initial discovery selects its exact owner after the list arrives',async()=>{
 const f=fixture();f.collection.openNotification({notification:{data:{hostId:'beta',assistantId:'asst-1'}}});await f.collection.refresh();assert.deepEqual(f.collection.snapshot().selected,ref('beta'));
});
test('malformed push identities open the safe view without throwing',async()=>{
 const f=fixture();await f.collection.refresh();assert.doesNotThrow(()=>f.collection.openNotification({notification:{data:{hostId:{},assistantId:'asst-1'}}}));assert.deepEqual(f.collection.snapshot().selected,ref('mac'));
});
test('a verified new alias rebinds a durable owner after the old route is removed',async()=>{
 const f=fixture();await f.collection.refresh();const old=f.collection.lane(ref('alpha'));const route=f.routes.a;f.collection.update({...f.options,hosts:[{id:'new-a',name:'New A',remote:true}],hostBackend:id=>id==='new-a'?route:f.routes[id]});await f.collection.refresh();await f.collection.lane(ref('alpha')).send('new route');await assert.rejects(old.send('old route'),/identity|offline|available/i);
});
test('a list completing after its alias backend was replaced cannot add the old owner',async()=>{
 const f=fixture(), pending=defer();f.handlers['a:personal_list']=()=>pending.promise;const poll=f.collection.refresh();f.routes.a=f.routes.b;pending.resolve([record('alpha')]);await poll;assert.equal(f.collection.lane(ref('alpha')),null);await f.collection.refresh();assert.equal(f.collection.snapshot().assistants.some(a=>a.ref.hostId==='alpha'),false);
});
test('negotiated workspace settings preserve editor revision and exact captured owner across selection changes',async()=>{
 const f=fixture();f.routes.a.supports=cap=>cap==='assistant_workspace_v4';await f.collection.refresh();const lane=f.collection.lane(ref('alpha'));const pending=defer();f.handlers['a:personal_workspace_configure']=()=>pending.promise;const input={expectedRevision:1,settings:{name:'Saved',look:{seed:'retained'}},profile:{id:'owned',display_name:'Owned',backend:{kind:'agent',tool:'claude_code'}},projects:[{project:{hostId:'beta',workspaceId:'w',cwd:'/repo'},tools:'full'}]};const save=lane.configureWorkspace(input);f.collection.select(ref('beta'));pending.resolve({assistant:record('alpha','asst-1',10)});await save;assert.deepEqual(f.collection.snapshot().selected,ref('beta'));assert.equal(f.collection.lane(ref('alpha')).assistant.revision,10);assert.deepEqual(f.calls.find(([,cmd])=>cmd==='personal_workspace_configure'),['a','personal_workspace_configure',{...input,assistantId:'asst-1'}]);assert.equal(f.collection.lane(ref('beta')).configureWorkspace,undefined);
});
test('cold exact push waits for its offline owner, while explicit selection cancels that pending target',async()=>{
 const f=fixture();f.offline.add('b');f.collection.openNotification({notification:{data:{hostId:'beta',assistantId:'asst-1'}}});await f.collection.refresh();f.offline.delete('b');await f.collection.refresh();assert.deepEqual(f.collection.snapshot().selected,ref('beta'));
 const g=fixture();g.offline.add('b');g.collection.openNotification({notification:{data:{hostId:'beta',assistantId:'asst-1'}}});await g.collection.refresh();g.collection.select(ref('alpha'));g.offline.delete('b');await g.collection.refresh();assert.deepEqual(g.collection.snapshot().selected,ref('alpha'));
});
test('bridge cannot deliver original command output to a replacement host after local execution',async()=>{
 const f=fixture(), executing=defer(), claimed=defer();let owner='alpha';f.routes.a.host.connection.get=()=>({status:{kind:'connected',hostId:owner}});f.lists.a[0].machines=[{hostId:'mac',name:'Mac',folder:'/folder'}];await f.collection.refresh();f.handlers['a:personal_machine_claim']=()=>[{taskId:'t',opId:'o',operation:{tool:'host.command',host:'mac',cwd:'/folder',argv:['echo','hi']}}];f.handlers['local:personal_execute_local']=()=>{claimed.resolve();return executing.promise;};const warn=console.warn;console.warn=()=>{};try{const work=f.collection.bridge();await claimed.promise;owner='beta';executing.resolve({exitCode:0,output:'alpha private output'});await work;assert.equal(f.calls.some(([,cmd])=>cmd==='personal_machine_result'),false);}finally{console.warn=warn;}
});
test('linking cannot mutate a replacement assistant host after local allowance completes',async()=>{
 const f=fixture(), allowed=defer();let owner='alpha';f.routes.a.host.connection.get=()=>({status:{kind:'connected',hostId:owner}});await f.collection.refresh();f.handlers['local:personal_machine_allow']=()=>allowed.promise;const work=f.collection.lane(ref('alpha')).linkThisMac('/folder');owner='beta';allowed.resolve({hostId:'mac',folder:'/folder'});await assert.rejects(work,/identity|offline/i);assert.equal(f.calls.some(([,cmd])=>cmd==='personal_machine_link'),false);
});
test('an exact push for an assistant created since the last poll selects it after authoritative discovery',async()=>{
 const f=fixture();await f.collection.refresh();f.collection.openNotification({notification:{data:{hostId:'beta',assistantId:'asst-2'}}});f.lists.b.push(record('beta','asst-2'));await f.collection.refresh();assert.deepEqual(f.collection.snapshot().selected,ref('beta','asst-2'));
});
test('an older in-flight list cannot discard a newer exact notification target',async()=>{
 const f=fixture();await f.collection.refresh();const old=defer();f.handlers['b:personal_list']=()=>old.promise;const work=f.collection.refresh();f.collection.openNotification({notification:{data:{hostId:'beta',assistantId:'asst-2'}}});old.resolve([record('beta')]);await work;delete f.handlers['b:personal_list'];f.lists.b.push(record('beta','asst-2'));await f.collection.refresh();assert.deepEqual(f.collection.snapshot().selected,ref('beta','asst-2'));
});
test('an unseen exact notification presents an attributed pending lane with no writable fallback',async()=>{
 const f=fixture();await f.collection.refresh();f.collection.openNotification({notification:{data:{hostId:'beta',assistantId:'asst-2'}}});const waiting=f.collection.pendingLane();assert.equal(waiting.assistant,null);assert.equal(waiting.offline,true);assert.deepEqual(waiting.ref,ref('beta','asst-2'));await assert.rejects(waiting.send('never to mac'),/waiting/i);assert.equal(f.calls.some(([,cmd])=>cmd==='personal_send'),false);f.collection.select(ref('alpha'));assert.equal(f.collection.pendingLane(),null);
});

test('imported assistant summaries retain the host legacy marker instead of looking verified', async () => {
 const f=fixture(); const legacy={sourceSha256:'a'.repeat(64),importedAtMs:1,verified:false};
 f.lists.local[0].legacy=legacy; await f.collection.refresh();
 assert.deepEqual(f.collection.snapshot().assistants.find(a=>a.ref.hostId==='mac').legacy,legacy);
 assert.equal(f.collection.snapshot().assistants.find(a=>a.ref.hostId==='beta').legacy,undefined);
});

test('explicit creation persists on its captured authenticated machine and selects the returned durable owner',async()=>{
 const f=fixture();await f.collection.refresh();f.routes.a.supports=cap=>cap==='assistant_workspace_v4';
 const pending=defer();f.handlers['a:personal_create']=()=>pending.promise;
 const input={workspaceVersion:4,name:'New teammate',folder:'~/apex-assistant',profile:{id:'p',display_name:'New teammate',backend:{kind:'agent',tool:'codex',model:'offered'},persona:'',access:'full',effort:'low'},look:{seed:'new-seed',color:'#aabbcc',kind:'pixel'},projects:[]};
 const creating=f.collection.create('a',input);f.collection.select(ref('beta'));pending.resolve({...record('alpha','new'),name:input.name,profile:input.profile,look:input.look});
 assert.deepEqual(await creating,ref('alpha','new'));assert.deepEqual(f.collection.snapshot().selected,ref('alpha','new'));assert.equal(f.collection.lane(ref('alpha','new')).assistant.profile.access,'full');assert.deepEqual(f.calls.find(([,cmd])=>cmd==='personal_create'),['a','personal_create',input]);
});
test('creation rejects a route rebound to another authenticated owner before completion',async()=>{
 const f=fixture();await f.collection.refresh();f.routes.a.supports=()=>true;const pending=defer();f.handlers['a:personal_create']=()=>pending.promise;
 const creating=f.collection.create('a',{workspaceVersion:4,name:'A',folder:'/work',profile:{},look:{},projects:[]});
 f.routes.a.host.connection.get=()=>({status:{kind:'connected',hostId:'different'}});pending.resolve(record('alpha','new'));
 await assert.rejects(creating,/identity changed/);assert.equal(f.collection.lane(ref('alpha','new')),null);
});

test('archive disappears only after the owning host confirms and restore retains the same durable identity',async()=>{
 const f=fixture();f.routes.a.supports=cap=>cap==='assistant_archive_v1';await f.collection.refresh();f.collection.select(ref('alpha'));const lane=f.collection.lane(ref('alpha'));assert.equal(typeof lane.archiveAssistant,'function');
 const pending=defer();f.handlers['a:personal_archive']=()=>pending.promise;const removing=lane.archiveAssistant(1);assert.equal(f.collection.snapshot().assistants.some(row=>row.ref.hostId==='alpha'&&row.ref.assistantId==='asst-1'),true);
 const archived={...record('alpha','asst-1',2),archivedAt:123,paused:true};pending.resolve({assistant:archived});await removing;
 assert.equal(f.collection.snapshot().assistants.some(row=>row.ref.hostId==='alpha'&&row.ref.assistantId==='asst-1'),false);assert.equal(f.collection.snapshot().archivedAssistants[0].archivedAt,123);assert.equal(f.collection.lane(ref('alpha')),null);assert.throws(()=>f.collection.select(ref('alpha')),/archiv|removed/i);await assert.rejects(lane.send('stale composer'),/archiv|removed/i);
 f.handlers['a:personal_archive']=args=>{assert.deepEqual(args,{assistantId:'asst-1',expectedRevision:2,archived:false});return {assistant:{...record('alpha','asst-1',3),paused:true}};};
 await f.collection.restoreAssistant(ref('alpha'),2);assert.equal(f.collection.snapshot().archivedAssistants.length,0);assert.equal(f.collection.lane(ref('alpha')).assistant.paused,true);assert.deepEqual(f.calls.find(([,cmd])=>cmd==='personal_archive'),['a','personal_archive',{assistantId:'asst-1',expectedRevision:1,archived:true}]);
});
test('archived assistants stay out of restored selection, notifications, machine bridges and active roster after restart',async()=>{
 const f=fixture();f.lists.local[0]={...f.lists.local[0],archivedAt:10,paused:true,machines:[{hostId:'mac',name:'Mac',folder:'/folder'}]};f.storage.value=JSON.stringify(ref('mac'));await f.collection.refresh();assert.deepEqual(f.collection.snapshot().selected,ref('alpha'));assert.equal(f.collection.snapshot().archivedAssistants.length,1);
 f.collection.openNotification({notification:{data:{hostId:'mac',assistantId:'asst-1'}}});assert.deepEqual(f.collection.snapshot().selected,ref('alpha'));await f.collection.bridge();assert.equal(f.calls.some(([route,cmd])=>route==='local'&&cmd==='personal_machine_claim'),false);
});

test('task lifecycle wire payload is minimal, revision bound and captured to its assistant',async()=>{
 const f=fixture();f.routes.a.supports=cap=>cap==='assistant_task_lifecycle_v1';await f.collection.refresh();const lane=f.collection.lane(ref('alpha'));
 f.collection.select(ref('beta'));
 await lane.taskLifecycle('delete',{source:'delegated',taskId:'task-1',revision:7,key:'delegated:task-1',title:'Display title',project:{cwd:'/irrelevant'}});
 const command=f.calls.find(([,cmd])=>cmd==='personal_task_lifecycle');
 assert.deepEqual(command,['a','personal_task_lifecycle',{assistantId:'asst-1',expectedRevision:1,action:'delete',task:{source:'delegated',taskId:'task-1',revision:7},expectedDeleted:undefined}]);
 assert.equal(f.collection.lane(ref('beta')).taskLifecycle,undefined);
});

test('a newer task tombstone snapshot updates at the same assistant revision without regressing settings',async()=>{
 const f=fixture();await f.collection.refresh();f.lists.a[0]={...record('alpha'),name:'old list value',purgedDelegatedTaskIds:['task-1'],taskLifecycleSnapshotRevision:4};await f.collection.refresh();
 const snapshot=f.collection.lane(ref('alpha')).assistant;
 assert.deepEqual(snapshot.purgedDelegatedTaskIds,['task-1']);assert.equal(snapshot.name,'alpha/asst-1');
 f.lists.a[0]={...record('alpha'),purgedDelegatedTaskIds:[],taskLifecycleSnapshotRevision:3};await f.collection.refresh();assert.deepEqual(f.collection.lane(ref('alpha')).assistant.purgedDelegatedTaskIds,['task-1']);
});

test('an archive response without persisted archivedAt cannot report successful removal',async()=>{
 const f=fixture();f.routes.a.supports=cap=>cap==='assistant_archive_v1';await f.collection.refresh();await assert.rejects(f.collection.lane(ref('alpha')).archiveAssistant(1),/confirm|archiv/i);assert.ok(f.collection.snapshot().assistants.some(row=>row.ref.hostId==='alpha'));
});
