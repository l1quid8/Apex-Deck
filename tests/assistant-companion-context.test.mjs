import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyCatalog,parseChatList,withListedRooms} from '../src/chatCatalog.ts';
import {deriveCompanionCatalog,reconcileCompanionSelection,companionFloatContext,companionViewContext,companionNewThreadTarget,loadCompanionSelection,saveCompanionSelection,companionSelectionKey} from '../src/assistantCompanionContext.ts';
const owner={hostId:'durable-a',assistantId:'alfred'};
const binding=(id,cwd,tools='ask',hostId=owner.hostId)=>({project:{hostId,workspaceId:id,cwd},tools});
const room=(id,cwd='/canonical/a',extra={})=>({id,kind:'work',cwd,title:'Host fallback',participants:[],...extra});
function input(extra={}) {
 const rooms=[room('open'),room('closed'),room('talk','/canonical/a',{kind:'chat'}),room('trash','/canonical/a',{trashedAt:10}),room('archive','/canonical/a',{archived:true}),room('unbound',null,{kind:'chat'}),room('foreign','/other'),room('explicit','/canonical/a',{title:'Authoritative title',titleExplicit:true})];
 let catalog=withListedRooms(emptyCatalog(),'route-a','Owner',parseChatList('route-a',{rooms}),1);
 catalog=withListedRooms(catalog,'route-b','Other',parseChatList('route-b',{rooms:[room('open','/canonical/a',{title:'Other host'})]}),1);
 return {owner,assistant:{id:'alfred',hostId:'durable-a',projects:[binding('a','/canonical/a'),binding('off','/off','off'),binding('remote','/canonical/a','full','durable-b')]},routeHostId:'route-a',authenticatedHostId:'durable-a',catalog,
 workspaces:[{id:'a',hostId:'route-a',name:'A',path:'/canonical/a'},{id:'b',hostId:'route-b',name:'Other',path:'/canonical/a'}],
 panes:[{id:'open',kind:'chat',workspaceId:'a',title:'Visible name'},{id:'closed',kind:'chat',workspaceId:'a',title:'Closed name',closed:true},{id:'explicit',kind:'chat',workspaceId:'a',title:'Stale local name',closed:true},{id:'open',kind:'chat',workspaceId:'b',title:'Other host collision'}],focusedPane:'open',...extra};
}
const memory=()=>{const data=new Map();return {data,getItem:key=>data.get(key)??null,setItem:(key,value)=>data.set(key,value)};};

test('real catalog uses only the authenticated assistant owner and exact granted canonical project paths',()=>{
 const result=deriveCompanionCatalog(input());
 assert.deepEqual(result.threads.map(row=>row.id).sort(),['closed','explicit','open','talk']);
 assert.equal(result.threads.find(row=>row.id==='open').title,'Visible name');
 assert.equal(result.threads.find(row=>row.id==='explicit').title,'Authoritative title');
 assert.equal(result.threads.find(row=>row.id==='open').hostId,'durable-a');
 assert.equal(result.threads.find(row=>row.id==='talk').projectId,'a');
 assert.deepEqual(result.openThreadIds,['open']);assert.equal(result.focusedThreadId,'open');
 assert.equal(result.threads.find(row=>row.id==='closed').closed,true);
 assert.equal(result.threads.find(row=>row.id==='talk').closed,true,'a listed room without an open pane is not falsely open');
 for(const change of [{authenticatedHostId:'durable-b'},{authenticatedHostId:undefined},{owner:{hostId:'durable-b',assistantId:'alfred'}},{assistant:{...input().assistant,id:'other'}}])assert.equal(deriveCompanionCatalog(input(change)).threads.length,0);
 const wrongPath=deriveCompanionCatalog(input({workspaces:[{id:'a',hostId:'route-a',name:'A',path:'/canonical/a/'}]}));
 assert.equal(wrongPath.openThreadIds.length,0,'client path normalization never grants scope');
});

test('zero-agent threads and explicitly proven route aliases are retained; unknown aliases cannot provide pane context',()=>{
 const data=input();data.panes=[{id:'open',kind:'chat',workspaceId:'alias-workspace',title:'Alias title'}];
 data.workspaces=[{id:'alias-workspace',hostId:'second-route',name:'Alias',path:'/canonical/a'}];
 assert.equal(deriveCompanionCatalog(data).threads.find(row=>row.id==='open').title,'Host fallback');
 const verified=deriveCompanionCatalog({...data,authenticatedHostForRoute:route=>route==='second-route'?'durable-a':undefined});
 assert.equal(verified.threads.find(row=>row.id==='open').title,'Alias title');
 assert.deepEqual(verified.openThreadIds,['open']);
 assert.equal(deriveCompanionCatalog(input()).threads.find(row=>row.id==='talk').title,'Host fallback');
});

test('default followers are open eligible panes; a closed active pin stays independent and revocation/removal prunes it',()=>{
 const catalog=deriveCompanionCatalog(input());
 assert.deepEqual(reconcileCompanionSelection(catalog,null),{followedThreadIds:['open'],activeThreadId:null});
 const selected=reconcileCompanionSelection(catalog,{followedThreadIds:['talk','talk','missing'],activeThreadId:'closed'});
 assert.deepEqual(selected,{followedThreadIds:['talk'],activeThreadId:'closed'});
 assert.equal(companionViewContext(catalog,selected).focusedThreadId,'closed');
 assert.deepEqual(companionViewContext(catalog,selected).openThreadIds,['open']);
 assert.deepEqual(companionViewContext(catalog,selected).followedThreadIds,['talk']);
 const data=input();data.catalog=withListedRooms(data.catalog,'route-a','Owner',parseChatList('route-a',{rooms:[room('open')]}),2);
 assert.deepEqual(reconcileCompanionSelection(deriveCompanionCatalog(data),selected),{followedThreadIds:[],activeThreadId:null});
 const revoked=deriveCompanionCatalog(input({assistant:{...data.assistant,projects:[binding('a','/canonical/a','off')]}}));
 assert.deepEqual(reconcileCompanionSelection(revoked,selected),{followedThreadIds:[],activeThreadId:null});
});

test('selection persistence is qualified by durable assistant identity, rejects copied owners and falls back safely',()=>{
 const storage=memory(),catalog=deriveCompanionCatalog(input());const selection={followedThreadIds:['talk'],activeThreadId:'closed'};
 assert.equal(saveCompanionSelection(storage,owner,catalog,selection),true);
 assert.deepEqual(loadCompanionSelection(storage,owner,catalog),selection);
 const other={hostId:'durable-a',assistantId:'other'};
 assert.notEqual(companionSelectionKey(owner),companionSelectionKey(other));
 storage.data.set(companionSelectionKey(other),storage.data.get(companionSelectionKey(owner)));
 const otherCatalog=deriveCompanionCatalog(input({owner:other,assistant:{...input().assistant,id:'other'}}));
 assert.deepEqual(loadCompanionSelection(storage,other,otherCatalog),{followedThreadIds:['open'],activeThreadId:null});
 storage.data.set(companionSelectionKey(owner),'{broken');assert.deepEqual(loadCompanionSelection(storage,owner,catalog),{followedThreadIds:['open'],activeThreadId:null});
 assert.equal(saveCompanionSelection({setItem(){throw Error('quota');}},owner,catalog,selection),false);
});

test('send-time snapshots copy arrays, bound followers to 64 and do not call a closed pin open',()=>{
 const data=input();const rooms=Array.from({length:90},(_,i)=>room(`r${i}`));data.catalog=withListedRooms(data.catalog,'route-a','Owner',parseChatList('route-a',{rooms}),2);data.panes=rooms.map(row=>({id:row.id,workspaceId:'a',kind:'chat',title:row.id,closed:row.id==='r89'}));data.focusedPane='r89';
 const catalog=deriveCompanionCatalog(data),selection={followedThreadIds:rooms.map(row=>row.id),activeThreadId:'r89'};
 const snapshot=companionViewContext(catalog,selection);
 assert.equal(snapshot.hostId,'durable-a');assert.equal(snapshot.focusedThreadId,'r89');assert.equal(snapshot.openThreadIds.includes('r89'),false);
 assert.equal(snapshot.followedThreadIds.length,64);assert.equal(snapshot.openThreadIds.length,64);
 snapshot.openThreadIds.push('tampered');snapshot.followedThreadIds.length=0;
 assert.equal(companionViewContext(catalog,selection).followedThreadIds.length,64);assert.equal(catalog.openThreadIds.includes('tampered'),false);
 assert.equal(companionFloatContext(catalog,selection).activeThreadId,'r89');
});

test('new-thread target selects active project then eligible focus then a sole project, otherwise requires a choice',()=>{
 const catalog=deriveCompanionCatalog(input());const target=companionNewThreadTarget(catalog,{followedThreadIds:[],activeThreadId:'closed'});
 assert.equal(target.kind,'project');assert.equal(target.routeHostId,'route-a');assert.deepEqual(target.project,{hostId:'durable-a',workspaceId:'a',cwd:'/canonical/a'});
 const data=input();data.assistant.projects.push(binding('second','/canonical/second'));data.catalog=withListedRooms(data.catalog,'route-a','Owner',parseChatList('route-a',{rooms:[room('second','/canonical/second')]}),2);data.panes=[];data.focusedPane=null;
 const multi=deriveCompanionCatalog(data);assert.equal(companionNewThreadTarget(multi,{followedThreadIds:[],activeThreadId:null}).kind,'selection-required');
 assert.equal(companionNewThreadTarget(multi,{followedThreadIds:[],activeThreadId:'second'}).project.workspaceId,'second');
 assert.equal(companionFloatContext(multi,{followedThreadIds:[],activeThreadId:null}).canCreateThread,false);
 assert.equal(companionNewThreadTarget(deriveCompanionCatalog(input({authenticatedHostId:undefined})),null).kind,'unavailable');
});

test('temporary loading cannot overwrite stored picks, and status is copied only when explicitly observed',()=>{
 const storage=memory(),catalog=deriveCompanionCatalog(input());const saved={followedThreadIds:['talk'],activeThreadId:'closed'};
 saveCompanionSelection(storage,owner,catalog,saved);const bytes=storage.data.get(companionSelectionKey(owner));
 const loading=deriveCompanionCatalog(input({catalog:emptyCatalog()}));
 assert.equal(loading.listed,false);assert.equal(saveCompanionSelection(storage,owner,loading,{followedThreadIds:[],activeThreadId:null}),false);
 assert.equal(storage.data.get(companionSelectionKey(owner)),bytes);
 assert.equal(catalog.threads.some(thread=>Object.hasOwn(thread,'status')),false);
 const calls=[];const observed=deriveCompanionCatalog(input({threadStatus:(route,id)=>{calls.push([route,id]);return id==='open'?'Waiting for you':undefined;}}));
 assert.equal(observed.threads.find(thread=>thread.id==='open').status,'Waiting for you');
 assert.equal(observed.threads.find(thread=>thread.id==='closed').status,undefined);
 assert.ok(calls.every(([route])=>route==='route-a'));
 const ui=companionFloatContext(observed,saved);ui.threads[0].title='Mutated';
 assert.notEqual(companionFloatContext(observed,saved).threads[0].title,'Mutated');
});

test('eligible current focus chooses its project while stale closed focus never becomes an open thread',()=>{
 const data=input();data.assistant.projects.push(binding('second','/canonical/second'));
 data.catalog=withListedRooms(data.catalog,'route-a','Owner',parseChatList('route-a',{rooms:[room('open'),room('second','/canonical/second')]}),2);
 data.workspaces.push({id:'second',hostId:'route-a',name:'Second',path:'/canonical/second'});
 data.panes.push({id:'second',kind:'chat',workspaceId:'second',title:'Current second'});data.focusedPane='second';
 const catalog=deriveCompanionCatalog(data);
 assert.equal(companionNewThreadTarget(catalog,{followedThreadIds:['open'],activeThreadId:null}).project.workspaceId,'second');
 const closed=deriveCompanionCatalog(input({focusedPane:'closed'}));
 assert.equal(closed.focusedThreadId,null);assert.equal(companionViewContext(closed,null).focusedThreadId,undefined);
 assert.equal(closed.openThreadIds.includes('closed'),false);
});
