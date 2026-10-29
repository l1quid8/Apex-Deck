import test from 'node:test';
import assert from 'node:assert/strict';
import { availableMenuItems, menuItems } from '../src/composerMenu.ts';

test('talk-only menu excludes workspace actions and labels fork as a new chat', () => {
  for (const trigger of [null, {kind:'command', query:'', start:0, end:1}]) {
    const items = availableMenuItems(menuItems(trigger, [{id:'null',display_name:'Null'}]), {talkOnly:true});
    assert.equal(items.some(x => ['attach','attach-folder','tools','server'].includes(x.kind)), false);
    assert.equal(items.some(x => x.kind === 'command' && ['plan','diff','image'].includes(x.key)), false);
    assert.equal(items.find(x => x.key === 'fork').detail, 'Copy into a new chat');
    for (const key of ['clear','compact','export']) assert.ok(items.some(x => x.key === key));
  }
});
test('Work menu retains attachment, tool and project commands', () => {
  const items = availableMenuItems(menuItems(null, []), {});
  for (const kind of ['attach','attach-folder','tools']) assert.ok(items.some(x => x.kind === kind));
  for (const key of ['plan','diff','image']) assert.ok(items.some(x => x.key === key));
  assert.equal(items.find(x => x.key === 'fork').detail, 'Copy this chat into a new thread');
});

import { chatThreadBackend } from '../src/chatThreadBackend.ts';
const bot = {id:'null',display_name:'Null',access:'read',effort:'high',backend:{kind:'agent',tool:'codex',model:'old',effort:'high'}};
function routeFixture() {
  const calls=[], sent=[], snapshot={participants:[bot],transcript:[],options:{policy:'everyone',max_bot_hops:3}};
  let online=true, blocked=null;
  const raw={call:async(cmd,args)=>{calls.push({cmd,args});return bot;},roomState:async()=>({snapshot,active:[],approvals:[]}),roomClear:async()=>calls.push('clear')};
  const adapted=chatThreadBackend(raw,{room:'same-id',online:()=>online,blocked:()=>blocked,cached:()=>({snapshot,active:[],approvals:[]}),remember(){},send:text=>{if(blocked)throw Error(blocked);sent.push(text);},profile:id=>id==='null'?'profile-null':undefined});
  return {adapted,calls,sent,snapshot,setOnline:v=>online=v,setBlocked:v=>blocked=v};
}
test('chat settings use dedicated routes and never submit access/backend authority',async()=>{
  const {adapted,calls}=routeFixture();
  await adapted.roomUpdateParticipant('same-id',{...bot,access:'full',backend:{...bot.backend,model:'new'}});
  assert.deepEqual(calls[0],{cmd:'chat_update_participant',args:{id:'same-id',participant:'null',patch:{model:'new'}}});
  await adapted.roomAddParticipant('same-id',bot);await adapted.roomRemoveParticipant('same-id','null');
  assert.deepEqual(calls.slice(1).map(x=>x.cmd),['chat_add_participant','chat_remove_participant']);
});
test('offline chat reads cached history and every post enters the durable sender',async()=>{
  const f=routeFixture();f.setOnline(false);
  assert.equal((await f.adapted.roomState('same-id')).snapshot,f.snapshot);
  assert.equal(await f.adapted.roomCreate('same-id',[],{},'/forbidden'),f.snapshot);
  await f.adapted.roomPost('same-id','hello');await f.adapted.roomPostTo('same-id','@null hello',['null']);
  assert.deepEqual(f.sent,['hello','@null hello']);assert.deepEqual(f.calls,[]);
  await f.adapted.roomClose('same-id');assert.deepEqual(f.calls,[]);
});
test('moved and moving chats refuse history and bot mutations',async()=>{
  const f=routeFixture();f.setBlocked('Moved to Work');
  await assert.rejects(()=>f.adapted.roomClear('same-id'),/Moved to Work/);
  await assert.rejects(()=>f.adapted.roomRemoveParticipant('same-id','null'),/Moved to Work/);
  await assert.rejects(()=>f.adapted.roomPost('same-id','late'),/Moved to Work/);
  assert.deepEqual(f.calls,[]);assert.deepEqual(f.sent,[]);
});
test('a move hold guards every posting path even when the sender itself is permissive',async()=>{
  const sent=[];
  const adapted=chatThreadBackend({}, {room:'r',online:()=>true,blocked:()=> 'Finish the move first',cached:()=>null,remember(){},send:text=>sent.push(text),profile:()=>undefined});
  await assert.rejects(()=>adapted.roomPostTo('r','late',['null']),/Finish the move first/);
  assert.deepEqual(sent,[]);
});

test('Stop stays available during a move but never sends while offline',async()=>{
  const calls=[];
  let online=true;
  const adapted=chatThreadBackend({roomStop:async(...args)=>calls.push(args)}, {room:'r',online:()=>online,blocked:()=> 'Finish the move first',cached:()=>null,remember(){},send(){},profile(){}});
  await adapted.roomStop('r','null');
  await adapted.roomStop('r');
  assert.deepEqual(calls,[['r','null'],['r',undefined]]);
  online=false;
  await assert.rejects(()=>adapted.roomStop('r'),/reconnecting/);
  assert.equal(calls.length,2);
});

test('chat reasoning and Speed edits stay in the allowed patch',async()=>{
  const f=routeFixture();
  await f.adapted.roomUpdateParticipant('same-id',{...bot,effort:'low',speed:'fast'});
  assert.deepEqual(f.calls[0].args.patch,{effort:'low',speed:'fast'});
});
test('resync reads the authoritative room before declaring recovery complete',async()=>{
  let remembered;
  const snapshot={transcript:[],participants:[],options:{policy:'everyone',max_bot_hops:3}};
  const adapted=chatThreadBackend({host:{connection:{get:()=>({status:{kind:'resync'}})}},roomState:async()=>({snapshot,active:[],approvals:[]})},{room:'r',online:()=>false,blocked:()=>null,cached:()=>{throw Error('stale cache');},remember:state=>remembered=state,send(){},profile(){}});
  assert.equal((await adapted.roomState('r')).snapshot,snapshot);assert.equal(remembered.snapshot,snapshot);
});
test('a speed edit does not overwrite a model changed on the phone',async()=>{
  const calls=[];
  const changed={...bot,backend:{...bot.backend,model:'phone-model'}};
  const adapted=chatThreadBackend({roomState:async()=>({snapshot:{participants:[changed]},active:[],approvals:[]}),call:async(cmd,args)=>{calls.push({cmd,args});return changed;}},{room:'r',online:()=>true,blocked:()=>null,cached:()=>null,remember(){},send(){},profile(){}});
  await adapted.roomUpdateParticipant('r',{...bot,speed:'fast'},bot);
  assert.deepEqual(calls[0].args.patch,{speed:'fast'});
});
test('promoted chats refuse interactive-card saves including already queued saves',async()=>{
  let saves=0;
  const adapted=chatThreadBackend({answerSave:async()=>{saves++;}},{room:'r',online:()=>true,blocked:()=> 'This chat moved to a Work thread.',cached:()=>null,remember(){},send(){},profile(){}});
  await assert.rejects(()=>adapted.answerSave('r','card','fingerprint',{},0),/moved to a Work thread/);
  assert.equal(saves,0);
});
