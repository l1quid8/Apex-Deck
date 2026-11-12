import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyCatalog,parseChatList,withListedRooms,chatRows,promotedWork,readCatalog} from '../src/chatCatalog.ts';
import {restoredChat,workThreadPlace,sendBlock} from '../src/desktopChats.ts';
import {trashRows,withoutTrashedPanes,closeTrashedPanes,setThreadTrashed} from '../src/threadTrash.ts';
const listed=(catalog,host,rooms)=>withListedRooms(catalog,host,host,parseChatList(host,{rooms}),1);
const fixture=()=>listed(listed(emptyCatalog(),'local',[
 {id:'same',kind:'work',cwd:'/repo',promotedFrom:'source',trashedAt:10}, {id:'talk',kind:'chat',trashedAt:20}, {id:'live',kind:'chat'}, {id:'bad',kind:'chat',trashedAt:-1},
]),'remote',[{id:'same',kind:'work',cwd:'/repo',promotedFrom:'source'},{id:'talk',kind:'chat'}]);

test('Trash persists separately while normal chat and promoted Work lists exclude it',()=>{
 const catalog=readCatalog(JSON.stringify(fixture()));
 assert.deepEqual(trashRows(catalog).map(row=>[row.hostId,row.id]),[['local','talk'],['local','same']]);
 assert.deepEqual(chatRows(catalog,true).rows.map(row=>[row.hostId,row.id]).sort(),[['local','bad'],['local','live'],['remote','talk']]);
 assert.equal(promotedWork(catalog,'local').length,0);
 assert.equal(promotedWork(catalog,'remote').length,1);
 assert.equal(restoredChat(catalog,{hostId:'local',room:'talk'}),'drop');
 assert.equal(restoredChat(catalog,{hostId:'remote',room:'talk'}),'keep');
 assert.equal(workThreadPlace([],[],'local',trashRows(catalog)[1],()=>'',()=>''),'unlisted');
 assert.match(sendBlock(trashRows(catalog)[0],{id:'local',name:'Mac'},true),/Trash/);
});

test('only the exact machine and room disappear; restoration keeps its saved pane closed',()=>{
 const workspaces=[{id:'a',name:'A',path:'/repo'},{id:'b',name:'B',path:'/repo',hostId:'remote'}];
 const panes=[{id:'same',workspaceId:'a',kind:'chat',title:'Local'},{id:'same',workspaceId:'b',kind:'chat',title:'Remote'},{id:'same',workspaceId:'a',kind:'terminal',title:'Terminal'}];
 const catalog=fixture();
 assert.deepEqual(withoutTrashedPanes(panes,workspaces,catalog).map(row=>row.title),['Remote','Terminal']);
 const closed=closeTrashedPanes(panes,workspaces,catalog);
 assert.equal(closed[0].closed,true);assert.equal(closed[1],panes[1]);assert.equal(closed[2],panes[2]);
 const restored=listed(catalog,'local',[{id:'same',kind:'work',cwd:'/repo'}]);
 assert.equal(withoutTrashedPanes(closed,workspaces,restored)[0].closed,true);
 assert.equal(closeTrashedPanes(closed,workspaces,restored),closed);
});

test('Trash and Restore call only the selected route, and never start or send a turn',async()=>{
 const calls=[];const backend={supports:key=>key==='room_trash_v1',call:async(command,args)=>{calls.push([command,args]);return args.trashed?{trashedAt:42}:{title:'Kept'};}};
 const row=trashRows(fixture())[0];
 const restored=await setThreadTrashed(backend,row,false,true);
 assert.equal(restored.trashedAt,undefined);
 const trashed=await setThreadTrashed(backend,restored,true,true);assert.equal(trashed.trashedAt,42);
 assert.deepEqual(calls,[['room_set_trashed',{id:'talk',trashed:false}],['room_set_trashed',{id:'talk',trashed:true}]]);
});

test('old or disconnected hosts expose no working mutation and refusals keep state unchanged',async()=>{
 const row=trashRows(fixture())[0];let calls=0;
 for(const [supported,online]of [[undefined,true],[false,true],[true,false]])await assert.rejects(()=>setThreadTrashed({supports:()=>supported,call:async()=>{calls++;}},row,false,online));
 assert.equal(calls,0);
 await assert.rejects(()=>setThreadTrashed({supports:()=>true,call:async()=>{throw new Error('Stop the running reply first');}},row,false,true),/running reply/);
 assert.equal(row.trashedAt,20);
});

test('a queued message observed in Trash stays held through restore, relaunch and reconnect until explicit resume',async()=>{
 const {TrashDeliveryHolds}=await import('../src/threadTrash.ts');
 const {ChatDeliveryController,JsonChatDeliveryStorage}=await import('../src/chatDelivery.ts');
 const data=new Map();const storage={getItem:key=>data.get(key)??null,setItem:(key,value)=>data.set(key,value)};
 let holds=new TrashDeliveryHolds(storage);const sent=[];
 const snapshot={kind:'chat',transcript:[],participants:[],options:{policy:'everyone',max_bot_hops:3},clientMessages:{}};
 const controller=new ChatDeliveryController({storage:new JsonChatDeliveryStorage(storage,{key:'test-outbox'}),rpc:{exportRoom:async()=>snapshot,claim:async()=>({state:'unseen',replySeqs:[]}),post:async(machine,room,text)=>{sent.push([machine,room,text]);return {state:'done',replySeqs:[]};}},canSend:(_chat,message)=>!holds.blocked(message.machine.id,message.room)});
 controller.cacheChat({id:'queued',title:'Kept',machine:{id:'local',name:'Mac'},room:'talk',profiles:{},snapshot});
 controller.enqueue('queued','Saved unsent text',[]);
 holds.observe(fixture());
 assert.equal(holds.blocked('local','talk'),true);assert.equal(holds.blocked('remote','talk'),false);
 holds.observe(listed(emptyCatalog(),'local',[{id:'talk',kind:'chat'}]));
 holds=new TrashDeliveryHolds(storage);
 await controller.reconnect('local');assert.deepEqual(sent,[]);
 assert.equal(controller.snapshot().chats.queued.outbox[0].text,'Saved unsent text');
 holds.resume('local','talk');await controller.flush('queued');assert.equal(sent.length,1);
});

test('delivery holds fail closed on corrupt storage or an unsaved explicit resume',async()=>{
 const {TrashDeliveryHolds,TRASH_DELIVERY_HOLDS_KEY}=await import('../src/threadTrash.ts');
 assert.throws(()=>new TrashDeliveryHolds({getItem:()=>JSON.stringify(['not-a-route']),setItem(){}}),/could not be read/);
 const data=new Map();let fail=false;const storage={getItem:key=>data.get(key)??null,setItem:(key,value)=>{if(fail)throw new Error('disk full');data.set(key,value);}};
 const holds=new TrashDeliveryHolds(storage);holds.hold('local','same');fail=true;
 assert.throws(()=>holds.resume('local','same'),/could not be saved/);
 assert.equal(holds.blocked('local','same'),true);
 assert.ok(data.get(TRASH_DELIVERY_HOLDS_KEY).includes('local'));
});
