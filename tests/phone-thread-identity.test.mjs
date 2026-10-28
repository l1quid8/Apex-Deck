import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

// Two machines can each have a thread with the same id. These run PhoneApp's own handlers, sliced from
// the source, against stand-in machines: nothing drawn for one machine's thread may act on the other's.
const { transform } = createRequire(import.meta.url)('sucrase');

test('a Next button drawn for one machine\'s chat sends nothing once another machine\'s chat is open', async () => {
  const {createPhoneChatDelivery}=await import(new URL('../src/phone/phoneChatDelivery.ts', import.meta.url).href);
  const {chatRoute,threadKey,mayPostIn}=await import(new URL('../src/phone/chatRoutes.ts', import.meta.url).href);
  const {createRoomRecovery,representedRoomEvent}=await import(new URL('../src/roomRecovery.ts', import.meta.url).href);
  const {createStepsIndexLoader}=await import(new URL('../src/workSteps.ts', import.meta.url).href);
  const {formView}=await import(new URL('../src/questions.ts', import.meta.url).href);
  const {promoteHolds,readPromoteTickets}=await import(new URL('../src/chatPromote.ts', import.meta.url).href);
  const source=fs.readFileSync(new URL('../src/phone/PhoneApp.tsx', import.meta.url),'utf8');
  const slice=(s,e)=>{const at=source.indexOf(s),end=source.indexOf(e,at);assert.ok(at>=0&&end>at,s);return source.slice(at,end)};
  const effect=slice('  useEffect(() => {\n    if (!openPane || !openWorkspace)', '\n  // Who the message as typed');
  const functions=slice('  /** Whether the thread a button was drawn for', '\n  /** Stop one bot')+'\n'+slice('  function enqueueChat(', '\n  /** Send from a chat:');
  const gate=slice('  const chatGate =', '\n  const backupMachine');
  const compiled=transform(effect+'\n'+gate+'\n'+functions,{transforms:['typescript']}).code;
  const calls=[],notices=[];const disk=new Map();
  const snapshot={kind:'chat',participants:[{id:'bot',display_name:'Bot',backend:{kind:'agent',tool:'codex',model:null},persona:'',access:'read',effort:null}],options:{policy:'everyone',max_bot_hops:3},transcript:[]};
  const host={machine:{id:'B',name:'Machine B'},supports:()=>true,access:()=>({tier:'full',threads:'all'}),connection:{get:()=>({status:{kind:'connected'}})},backend:{
  roomState:async id=>{calls.push({cmd:'screen room_state',id});return new Promise(()=>{})},
  roomSteps:async()=>null,onRoomEvent:async()=>()=>{},
  supports:()=>true,call:async(cmd,args)=>{calls.push({cmd,args});if(cmd==='room_state')return{snapshot};if(cmd==='chat_list')return{rooms:[]};if(cmd==='room_post_to')return{clientMessageId:args.clientMessageId,state:'running',replySeqs:[]};throw Error(cmd)}
  }};
  const runtime=createPhoneChatDelivery({storage:{getItem:k=>disk.get(k)??null,setItem:(k,v)=>disk.set(k,v)},findHost:id=>id==='B'?host:undefined,onError:e=>notices.push(String(e))});
  const delivery=runtime.controller;
  delivery.cacheChat({id:'["B","b"]',title:'Chat B',machine:host.machine,room:'b',snapshot});
  const step={label:'Continue private A plan',prompt:'Analyze A private report: SECRET-A'};
  const oldRoom={id:'a',hostId:'A',asks:{questions:[],offer:{by:'bot',steps:[step],pending:false}},participants:[{id:'bot',display_name:'Bot'}]};
  const env={room:oldRoom,roomRef:{current:oldRoom},openPane:{id:'b',hostId:'B',workspaceId:'chats:B'},openWorkspace:{id:'chats:B'},openHostId:'B',openLink:{id:'B',status:'online'},openPath:'',openChat:{id:'b',hostId:'B',bots:[{id:'bot',name:'Bot'}]},viewingPending:false,
  phoneHost:()=>host,toLink:s=>s.kind==='connected'?'online':'offline',isChatSpace:s=>s.startsWith('chats:'),threadKey,createRoomRecovery,representedRoomEvent,createStepsIndexLoader,
  loadedSteps:{current:new Map()},refreshSteps:{current:()=>{}},catalogRef:{current:{hosts:{}}},delivery,
  setRoom:next=>{env.room=typeof next==='function'?next(env.room):next;env.roomRef.current=env.room},
  setNotice:n=>notices.push(n),words:String,useEffect:cb=>cb(),chatGate:null,
  setSavedSteps:()=>{},setWaiting:()=>{},setBusy:()=>{},setCuts:()=>{},queues:{current:new Map()},stuckRef:{current:false},
  chatOnline:true,openRights:{post:true},linkOf:()=>({id:'B',status:'online'}),roomFor:row=>env.room&&env.room.id===row.id&&env.room.hostId===row.hostId?env.room:null,draft:{text:'',files:[]},mayPostIn,
  chatRoute,chatMachine:id=>({name:'Machine '+id}),queueFor:()=>{throw Error('Work queue must not run')},findRoom:()=>null,
  promoteHolds,readPromoteTickets,localStorage:{getItem:()=>null},
  };
  const h=new Function('env',`with(env){${compiled};return {sendStep}}`)(env);
  await new Promise(r=>setTimeout(r,0));
  // Fixed: the other machine's room goes the moment B starts loading, so its form can't show.
  assert.equal(env.room,null,'B load clears the A room while room_state is pending');
  assert.equal(formView(env.room?.asks).kind,'none');
  // A Next button drawn for A before the switch, pressed after it, sends nothing anywhere.
  await h.sendStep(step,'bot',{id:'a',hostId:'A'});
  await new Promise(r=>setTimeout(r,5));
  assert.equal(calls.find(c=>c.cmd==='room_post_to'),undefined);
  assert.deepEqual(notices,['That suggestion was for another thread.']);
  // Once B's own room is on screen, B's own step still sends, to B.
  const bRoom={id:'b',hostId:'B',asks:{questions:[],offer:null},participants:[{id:'bot',display_name:'Bot'}]};
  env.room=bRoom;env.roomRef.current=bRoom;
  await h.sendStep({label:'B step',prompt:'B prompt'},'bot',{id:'b',hostId:'B'});
  await new Promise(r=>setTimeout(r,5));
  const posted=calls.find(c=>c.cmd==='room_post_to');
  assert.ok(posted);assert.equal(posted.args.id,'b');assert.equal(posted.args.text,'B prompt');
  void ('stale A step refused; B step posted to b:',JSON.stringify(posted.args.text));
});

test('a Work thread\'s queued rows and Edit stay on their own machine when another machine has the same thread id', async () => {
  const {ParticipantQueues}=await import(new URL('../src/turnQueue.ts', import.meta.url).href);
  const {queuedSticky,queueHears,queuedViews,giveBack}=await import(new URL('../src/phoneQueue.ts', import.meta.url).href);
  const {postFromPhone}=await import(new URL('../src/phone/phonePost.ts', import.meta.url).href);
  const {splitTldr}=await import(new URL('../src/tldr.ts', import.meta.url).href);
  const {quotesBack}=await import(new URL('../src/reply.ts', import.meta.url).href);
  const {machineThreadKey}=await import(new URL('../src/phone/chatRoutes.ts', import.meta.url).href);
  const source=fs.readFileSync(new URL('../src/phone/PhoneApp.tsx', import.meta.url),'utf8');
  const slice=(s,e)=>{const at=source.indexOf(s),end=source.indexOf(e,at);assert.ok(at>=0&&end>at);return source.slice(at,end)};
  const code=transform([slice('  const queueKey =','\n  const [queued'),slice('  function takeBack(','\n  const sessionEdits'),slice('  function unqueue(','\n  /** Ask the thread')].join('\n'),{transforms:['typescript']}).code;
  let queued={},drafts={},quotes={};const notices=[],posts=[];
  const hosts=['A','B'].map(id=>({machine:{id},connection:{get:()=>({status:'online'})},backend:{roomTargets:async()=>['bot'],roomPostTo:async(room,text,to)=>{posts.push({id,room,text,to})},roomStop:async()=>{}}}));
  const env={machineThreadKey,ParticipantQueues,queuedSticky,postFromPhone,splitTldr,quotesBack,giveBack,emptyDraft:()=>({text:'',files:[]}),
  queues:{current:new Map()},hostsRef:{current:hosts},roomRef:{current:{id:'shared',hostId:'A',participants:[{id:'bot',display_name:'Bot'}],policy:'everyone'}},busyRef:{current:{}},queuedDrafts:{current:new Map()},rostersRef:{current:new Map()},
  openHostId:'A',setQueued:fn=>queued=fn(queued),setDrafts:fn=>drafts=fn(drafts),setQuotes:fn=>quotes=fn(quotes),setNotice:n=>notices.push(n),words:String,toLink:x=>x};
  const h=new Function('env',`with(env){${code};return {queueFor,unqueue}}`)(env);
  const a=h.queueFor('shared','A');a.started('bot');await a.send('A private queued text');
  const b=h.queueFor('shared','B');b.started('bot');await b.send('B private queued text');
  assert.notEqual(a,b);env.openHostId='B';
  // An A turn event is received globally while B is open.
  queueHears(a,{type:'turn_started',id:'bot'});
  const K=(h,id)=>JSON.stringify([h,id]);
  // Fixed: A's queue is published under A's key; B's screen reads B's key and shows B's own row.
  assert.equal(queued.shared,undefined);
  const shownB=queued[K('B','shared')];
  const visible=queuedViews(shownB.items,['bot'],shownB.paused,shownB.lost,x=>x,'Machine B');
  assert.equal(visible.length,1);assert.equal(visible[0].text,'B private queued text');
  assert.equal(queued[K('A','shared')].items[0].text,'A private queued text');
  // Edit on B's visible row takes B's message back into B's box; A's queue is untouched.
  h.unqueue('shared',visible[0].id);
  assert.deepEqual(a.items.map(x=>x.text),['A private queued text']);
  assert.equal(b.items.length,0);
  assert.equal(drafts.shared.text,'B private queued text');
  assert.equal(queued[K('B','shared')].items.length,0);
  assert.equal(queued[K('A','shared')].items.length,1);
  void ('B row shows B text; Edit took back B only; A still queued:',JSON.stringify(a.items.map(x=>x.text)));
});

test('saved steps that finish loading after another machine\'s same-id thread opens are dropped', async () => {
  const {readReplySteps,rememberSteps}=await import(new URL('../src/workSteps.ts', import.meta.url).href);
  const {machineThreadKey}=await import(new URL('../src/phone/chatRoutes.ts', import.meta.url).href);
  const source=fs.readFileSync(new URL('../src/phone/PhoneApp.tsx', import.meta.url),'utf8');
  const head='            loadSteps={async (seq) => {';
  const start=source.indexOf(head)+head.length,end=source.indexOf('\n            }}',start);
  assert.ok(start>head.length&&end>start);
  const code=transform('async function loadSteps(seq) {'+source.slice(start,end)+'\n}',{transforms:['typescript']}).code;
  let release;
  const env={queueKey:machineThreadKey,openHostId:'A',openPane:{id:'shared'},openPaneRef:{current:machineThreadKey('A','shared')},loadedSteps:{current:new Map()},readReplySteps,rememberSteps,
    phoneHost:id=>({backend:{roomSteps:()=>{assert.equal(id,'A');return new Promise(r=>{release=r})}}})};
  const load=new Function('env','with(env){'+code+';return loadSteps}')(env);
  const pending=load(7);
  // B/shared opens while A's load is still out: the room effect gives B a fresh cache.
  env.openHostId='B';env.loadedSteps.current=new Map();env.openPaneRef.current=machineThreadKey('B','shared');
  const privateA={by:'bot',seq:7,steps:[{key:'private',parent:null,kind:'command',label:'A PRIVATE COMMAND',folder:'/A/private',detail:'cat A-private-report',output:'SECRET-A OUTPUT',status:'done',exit_code:0,duration_ms:10}],todo:[],dropped:0};
  release(privateA);
  assert.equal(await pending,null,'the late A reply is not handed to whatever is on screen');
  assert.equal(env.loadedSteps.current.get(7),undefined,'B\'s cache never holds A\'s steps');
  // B's own load still works.
  env.phoneHost=id=>({backend:{roomSteps:async()=>{assert.equal(id,'B');return {...privateA,steps:[{...privateA.steps[0],label:'B command',output:'B output'}]}}}});
  const own=await load(7);
  assert.equal(own.steps[0].label,'B command');
  assert.equal(env.loadedSteps.current.get(7).steps[0].label,'B command');
  // The rendered steps are keyed by machine too, so A's mounted line can't carry over to B.
  assert.match(source,/<SavedSteps key=\{`\$\{props\.link\.id\}:\$\{props\.paneId\}:\$\{message\.seq\}`\}/);
});

test('a queued Work message picks its bots with its own machine\'s rules, not the same-id room on screen', async () => {
  const {ParticipantQueues}=await import(new URL('../src/turnQueue.ts', import.meta.url).href);
  const {queuedSticky,giveBack}=await import(new URL('../src/phoneQueue.ts', import.meta.url).href);
  const {postFromPhone}=await import(new URL('../src/phone/phonePost.ts', import.meta.url).href);
  const {splitTldr}=await import(new URL('../src/tldr.ts', import.meta.url).href);
  const {quotesBack}=await import(new URL('../src/reply.ts', import.meta.url).href);
  const {machineThreadKey}=await import(new URL('../src/phone/chatRoutes.ts', import.meta.url).href);
  const source=fs.readFileSync(new URL('../src/phone/PhoneApp.tsx', import.meta.url),'utf8');
  const slice=(s,e)=>{const at=source.indexOf(s),end=source.indexOf(e,at);assert.ok(at>=0&&end>at,s);return source.slice(at,end)};
  const code=transform([slice('  const queueKey =','\n  const [queued'),slice('  const rostersRef =','\n  const phoneVoiceRef'),slice('  function takeBack(','\n  const sessionEdits')].join('\n'),{transforms:['typescript']}).code;
  let queued={},drafts={},quotes={};const targetCalls=[];
  const hosts=['A','B'].map(id=>({machine:{id},connection:{get:()=>({status:'online'})},backend:{roomTargets:async(room,text)=>{targetCalls.push({id,room,text});return text.includes('@One')?['one']:['one','two']},roomPostTo:async()=>{},roomStop:async()=>{}}}));
  const people=[{id:'one',display_name:'One'},{id:'two',display_name:'Two'}];
  const env={machineThreadKey,ParticipantQueues,queuedSticky,postFromPhone,splitTldr,quotesBack,giveBack,emptyDraft:()=>({text:'',files:[]}),queues:{current:new Map()},hostsRef:{current:hosts},
    roomRef:{current:{id:'shared',hostId:'A',participants:people,policy:'everyone'}},busyRef:{current:{}},queuedDrafts:{current:new Map()},useRef:current=>({current}),
    setQueued:fn=>{queued=fn(queued)},setDrafts:fn=>{drafts=fn(drafts)},setQuotes:fn=>{quotes=fn(quotes)},setNotice:()=>{},words:String,toLink:x=>x};
  env.room=env.roomRef.current;
  const h=new Function('env',`with(env){${code};return {queueFor}}`)(env);
  const a=h.queueFor('shared','A');a.started('one');a.started('two');
  await a.send('@One wait');
  // B/shared, which only answers when tagged, is now on screen; an A message still in flight reaches the queue.
  env.roomRef.current={id:'shared',hostId:'B',participants:people,policy:'mention'};
  await a.send('A follow-up captured before switching to B');
  assert.deepEqual(a.items.map(x=>x.to),[['one'],['one','two']]);
  assert.deepEqual(targetCalls.map(c=>c.id),['A','A'],'A is asked, B never is');
});

test('an offscreen Work queue keeps an untagged follow-up behind its own pending @tag', async () => {
  const {ParticipantQueues}=await import(new URL('../src/turnQueue.ts', import.meta.url).href);
  const {queuedSticky,giveBack}=await import(new URL('../src/phoneQueue.ts', import.meta.url).href);
  const {postFromPhone}=await import(new URL('../src/phone/phonePost.ts', import.meta.url).href);
  const {splitTldr}=await import(new URL('../src/tldr.ts', import.meta.url).href);
  const {quotesBack}=await import(new URL('../src/reply.ts', import.meta.url).href);
  const {machineThreadKey}=await import(new URL('../src/phone/chatRoutes.ts', import.meta.url).href);
  const source=fs.readFileSync(new URL('../src/phone/PhoneApp.tsx', import.meta.url),'utf8');
  const slice=(s,e)=>{const at=source.indexOf(s),end=source.indexOf(e,at);assert.ok(at>=0&&end>at,s);return source.slice(at,end)};
  const code=transform([slice('  const queueKey =','\n  const [queued'),slice('  const rostersRef =','\n  const phoneVoiceRef'),slice('  function takeBack(','\n  const sessionEdits')].join('\n'),{transforms:['typescript']}).code;
  const people=[{id:'one',display_name:'One'},{id:'two',display_name:'Two'}];
  const run=async(next)=>{
    const targetCalls=[],posts=[];
    // Each machine last posted to Two, so it answers an untagged message with Two: it hasn't been sent the queued @One.
    const hosts=['A','B'].map(id=>({machine:{id},connection:{get:()=>({status:'online'})},backend:{roomTargets:async(room,text)=>{targetCalls.push({id,room,text});return text.includes('@One')?['one']:['two']},roomPostTo:async(room,text,to)=>{posts.push({id,room,text,to})},roomStop:async()=>{}}}));
    const env={machineThreadKey,ParticipantQueues,queuedSticky,postFromPhone,splitTldr,quotesBack,giveBack,emptyDraft:()=>({text:'',files:[]}),queues:{current:new Map()},hostsRef:{current:hosts},
      roomRef:{current:{id:'shared',hostId:'A',participants:people,policy:'mention'}},busyRef:{current:{}},queuedDrafts:{current:new Map()},useRef:current=>({current}),
      setQueued:()=>{},setDrafts:()=>{},setQuotes:()=>{},setNotice:()=>{},words:String,toLink:x=>x};
    env.room=env.roomRef.current;
    const h=new Function('env',`with(env){${code};return {queueFor}}`)(env);
    const a=h.queueFor('shared','A');a.started('one');
    await a.send('@One wait');
    // The phone moves on: the same id on B, or another thread on A. The A follow-up lands only now.
    env.roomRef.current=next;
    await a.send('A follow-up finishing after navigation');
    assert.deepEqual(a.items.map(x=>x.to),[['one'],['one']]);
    a.idle('one');await new Promise(r=>setTimeout(r,0));
    assert.deepEqual(posts.map(p=>[p.id,p.text,p.to]),[['A','@One wait',['one']]]);
    a.idle('one');await new Promise(r=>setTimeout(r,0));
    assert.deepEqual(posts.map(p=>[p.id,p.text,p.to]),[['A','@One wait',['one']],['A','A follow-up finishing after navigation',['one']]]);
    assert.ok(targetCalls.every(c=>c.id==='A'),'B is never asked');
  };
  await run({id:'shared',hostId:'B',participants:people,policy:'mention'});
  await run({id:'other-room',hostId:'A',participants:people,policy:'mention'});
});
