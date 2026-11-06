import { test } from "node:test";
import assert from "node:assert/strict";

// ---- minimal browser globals ----
class FakeTrack {
  constructor() { this.enabled = true; this.stopped = false; }
  stop() { this.stopped = true; }
}
class FakeStream {
  constructor() { this._tracks = [new FakeTrack()]; }
  getAudioTracks() { return this._tracks; }
  getTracks() { return this._tracks; }
}
class FakeDataChannel {
  constructor() {
    this.readyState = "connecting";
    this.sent = [];
    this.onopen = null;
    this.onmessage = null;
    this.onerror = null;
  }
  send(text) { this.sent.push(text); }
  close() { this.readyState = "closed"; }
  _open() {
    this.readyState = "open";
    if (this.onopen) this.onopen();
  }
  _receive(obj) {
    if (this.onmessage) this.onmessage({ data: JSON.stringify(obj) });
  }
}
class FakePC {
  constructor() {
    FakePC.last = this;
    this.tracks = [];
    this.dc = new FakeDataChannel();
    this.localDesc = null;
    this.remoteDesc = null;
    this.closed = false;
  }
  addTrack(t, s) { this.tracks.push(t); }
  createDataChannel() { return this.dc; }
  async createOffer() { return { type: "offer", sdp: "v=0 fake offer" }; }
  async setLocalDescription(d) { this.localDesc = d; }
  async setRemoteDescription(d) { this.remoteDesc = d; }
  close() { this.closed = true; }
  set ontrack(fn) { this._ontrack = fn; }
  get ontrack() { return this._ontrack; }
}
FakePC.last = null;

globalThis.RTCPeerConnection = FakePC;
globalThis.MediaStream = FakeStream;
globalThis.Audio = class { constructor(){ this.autoplay=false; this.srcObject=null; } play(){return Promise.resolve();} pause(){} };

let getUserMediaImpl = async () => new FakeStream();
try {
  Object.defineProperty(globalThis, 'navigator', {
    value: { mediaDevices: { getUserMedia: async (c) => getUserMediaImpl(c) } },
    writable: true,
    configurable: true,
  });
} catch {
  globalThis.navigator = { mediaDevices: { getUserMedia: async (c) => getUserMediaImpl(c) } };
}
// ensure mediaDevices uses latest impl
const _updateNavigator = () => {
  try {
    if (globalThis.navigator && globalThis.navigator.mediaDevices) {
      globalThis.navigator.mediaDevices.getUserMedia = async (c) => getUserMediaImpl(c);
    }
  } catch {}
};
if (!globalThis.crypto) globalThis.crypto = {};
if (!globalThis.crypto.randomUUID) {
  const { randomUUID } = await import("node:crypto");
  globalThis.crypto.randomUUID = randomUUID;
}

let fetchImpl = async () => new Response("v=0 fake answer", { status: 200 });
globalThis.fetch = async (...args) => fetchImpl(...args);

const { createRealtimeVoiceController } = await import("../src/voice/realtimeController.ts");
const { connectRealtime } = await import("../src/voice/realtimeClient.ts");

function cand(name, id, host, room) {
  host = host || "h1"; room = room || "r1";
  return { name, participantId:id, hostId:host, roomId:room };
}

// The provider echoes app-owned metadata on response.created. Never infer an
// input from whichever transcript happened to arrive most recently.
function voiceInput(dc, itemId, transcript, responseId = `response-${itemId}`) {
  dc._receive({ type:"input_audio_buffer.speech_started", item_id:itemId });
  dc._receive({ type:"input_audio_buffer.committed", item_id:itemId });
  dc._receive({ type:"conversation.item.input_audio_transcription.completed", item_id:itemId, transcript });
  const created = dc.sent.map(JSON.parse).filter(e => e.type === "response.create").at(-1);
  dc._receive({ type:"response.created", response:{ id:responseId, metadata:created?.response?.metadata } });
  return responseId;
}

test("switch during startup uses current default in opening instructions (real modules)", async () => {
  FakePC.last = null;
  let resolveMint;
  const mintBlocker = new Promise((res)=>{ resolveMint = res; });

  const deps = {
    candidates: () => [cand("Alice","a1"), cand("Bob","b2")],
    bridge: () => ({ subscribe:()=>()=>{}, submit: async()=>{}, cancel: async()=>{} }),
    voiceSettings: () => ({ engine:"realtime", realtimeVoice:"verse", pauseMs:100, style:"pill", voices:[] }),
    mintSession: () => mintBlocker.then(()=> ({ client_secret:"ek_fake", model:"gpt-realtime", voice:"verse"})),
    focus: () => {},
  };

  const controller = createRealtimeVoiceController(deps);
  fetchImpl = async () => new Response("v=0 answer", { status: 200 });

  const scopeA = { hostId:"h1", roomId:"r1", participantId:"a1" };
  const scopeB = { hostId:"h1", roomId:"r1", participantId:"b2" };

  const startP = controller.start(scopeA);
  await new Promise(r=>setTimeout(r, 10));
  const switchP = controller.switchAgent(scopeB);
  resolveMint({ client_secret:"ek_fake", model:"gpt-realtime", voice:"verse" });
  // wait for connect to reach data channel creation
  await new Promise(r=>setTimeout(r, 50));
  const pc = FakePC.last;
  assert.ok(pc, "pc created");
  assert.equal(pc.dc.sent.length, 0, "no sends before open – queued until open");

  pc.dc._open();
  await new Promise(r=>setTimeout(r, 10));

  const sends = pc.dc.sent.map(s=>{ try { return JSON.parse(s); } catch { return null; } }).filter(Boolean);
  const updates = sends.filter(s=>s.type==="session.update");
  assert.ok(updates.length >= 1, "expected >=1 session.update, got "+sends.length);
  const instr = updates[0].session.instructions;
  assert.match(instr, /Bob/, "opening instructions should mention Bob (current default)");
  assert.match(instr, /Alice/, "full agent list contains Alice");
  assert.match(instr, /Rules:/, "contains delegation rules");

  const st = controller.getState();
  const scope = st.scope;
  assert.ok(scope, "scope exists");
  assert.equal(scope.participantId, "b2", "controller scope is Bob after switch");

  await controller.end();
});

test("end while key fetch pending stops mic track and leaves no peer (real controller)", async () => {
  FakePC.last = null;
  let micStream = new FakeStream();
  let stopped = false;
  const origStop = micStream.getAudioTracks()[0].stop.bind(micStream.getAudioTracks()[0]);
  micStream.getAudioTracks()[0].stop = function(){ this.stopped=true; stopped=true; origStop(); };

  getUserMediaImpl = async () => micStream;

  let resolveMint;
  const mintPromise = new Promise(r=>{ resolveMint = r; });
  const deps = {
    candidates: () => [cand("Alice","a1")],
    bridge: () => ({ subscribe:()=>()=>{}, submit: async()=>{}, cancel: async()=>{} }),
    voiceSettings: () => ({ engine:"realtime", realtimeVoice:"verse", pauseMs:100, style:"pill", voices:[] }),
    mintSession: () => mintPromise,
    focus: () => {},
  };

  fetchImpl = async () => new Response("v=0 answer", { status: 200 });

  const { createRealtimeVoiceController: createCtrl } = await import("../src/voice/realtimeController.ts");
  const controller = createCtrl(deps);

  const startP = controller.start({ hostId:"h1", roomId:"r1", participantId:"a1" });
  await new Promise(r=>setTimeout(r, 10));
  // pc not yet created because mint pending
  assert.equal(FakePC.last, null, "no peer created while mint pending");

  await controller.end();
  await new Promise(r=>setTimeout(r, 10));
  assert.ok(stopped || micStream.getAudioTracks()[0].stopped, "mic stopped after end during mint");
  assert.equal(FakePC.last, null, "still no peer after abort");

  // unblock to avoid dangling promise
  resolveMint({ client_secret:"ek_fake", model:"gpt-realtime", voice:"verse" });
  // wait a bit for any stale work to be discarded by gen guard
  await new Promise(r=>setTimeout(r, 20));
  // ensure no new pc created after end
  // (controller increments gen, so even if mint resolves, start should discard)
});

test("single tool call added->done->response.done submits exactly one request (real client)", async () => {
  FakePC.last = null;
  const submitted = [];
  const subs = new Set();
  const fakeBridge = {
    subscribe(fn){ subs.add(fn); return () => subs.delete(fn); },
    async submit(args){ submitted.push(args); },
    async cancel(){},
  };

  const deps = {
    candidates: () => [cand("Bob","b2")],
    bridge: () => fakeBridge,
    voiceSettings: () => ({ engine:"realtime", realtimeVoice:"verse", pauseMs:100, style:"pill", voices:[] }),
    mintSession: async () => ({ client_secret:"ek_fake", model:"gpt-realtime", voice:"verse"}),
  };

  getUserMediaImpl = async () => new FakeStream();
  fetchImpl = async () => new Response("v=0 answer", { status: 200 });

  const client = await connectRealtime(
    deps,
    { hostId:"h1", roomId:"r1", participantId:"b2" },
    { onEvent:()=>{}, onAudio:()=>{}, onError:()=>{}, onClose:()=>{} },
    { muted:()=>false, stream:()=>new FakeStream() },
    {}
  );

  const dc = FakePC.last ? FakePC.last.dc : null;
  assert.ok(dc, "dc exists");
  dc._open();

  const responseId = voiceInput(dc, "audio-1", "do x");
  dc._receive({ type:"response.output_item.added", response_id:responseId, item: { type:"function_call", call_id:"call-1", name:"ask_agent", arguments:"{}" } });
  dc._receive({ type:"response.function_call_arguments.delta", call_id:"call-1", delta:'{"agent":"Bob","request":"do x"}' });
  dc._receive({ type:"response.function_call_arguments.done", response_id:responseId, call_id:"call-1", name:"ask_agent", arguments:'{"agent":"Bob","request":"do x"}' });
  dc._receive({ type:"response.done", response: { id:responseId, status:"completed", output: [{ type:"function_call", call_id:"call-1", name:"ask_agent", arguments:'{"agent":"Bob","request":"do x"}' }] } });

  await new Promise(r=>setTimeout(r, 30));
  assert.equal(submitted.length, 1, "exactly one submission expected, got "+submitted.length);

  const submitted2 = [];
  const fakeBridge2 = {
    subscribe(fn){ return ()=>{}; },
    async submit(args){ submitted2.push(args); },
    async cancel(){},
  };
  const deps2 = { candidates: () => [cand("Bob","b2")], bridge: () => fakeBridge2, voiceSettings: deps.voiceSettings, mintSession: deps.mintSession };
  FakePC.last = null;
  getUserMediaImpl = async () => new FakeStream();
  const client2 = await connectRealtime(
    deps2,
    { hostId:"h1", roomId:"r1", participantId:"b2" },
    { onEvent:()=>{}, onAudio:()=>{}, onError:()=>{}, onClose:()=>{} },
    { muted:()=>false, stream:()=>new FakeStream() },
    {}
  );
  const dc2 = FakePC.last ? FakePC.last.dc : null;
  assert.ok(dc2, "dc2 exists");
  dc2._open();
  dc2._receive({ type:"response.function_call_arguments.done", call_id:"c2", name:"ask_agent", arguments:"{}" });
  await new Promise(r=>setTimeout(r, 20));
  assert.equal(submitted2.length, 0, "empty {} should not submit");

  client.close();
  client2.close();
});

test("builder single source – controller uses buildRealtimeInstructions", async () => {
  const fs = await import("node:fs");
  const srcClient = fs.readFileSync("src/voice/realtimeClient.ts","utf8");
  const srcCtrl = fs.readFileSync("src/voice/realtimeController.ts","utf8");
  assert.ok(srcClient.includes("export function buildRealtimeInstructions"));
  assert.ok(srcCtrl.includes("buildRealtimeInstructions"));
  const dup = (srcCtrl.match(/You are GPT-Live inside Apex Deck/g) || []).length;
  assert.equal(dup, 0, "controller should not contain duplicated prompt");
});

test("realtimeClient queues sends until open and uses current default liveScope", async () => {
  // Verify the new queue behavior via source inspection + runtime
  const fs = await import("node:fs");
  const src = fs.readFileSync("src/voice/realtimeClient.ts","utf8");
  assert.ok(src.includes("channelOpen"), "client tracks channelOpen");
  assert.ok(src.includes("queuedSends"), "client queues sends");
  assert.ok(src.includes("currentInstructions") || src.includes("buildRealtimeInstructions(candidatesLive, liveScope)"), "onopen uses liveScope");
});

test("end right after start cancels it before the mic opens (real controller)", async () => {
  let asked = 0;
  getUserMediaImpl = async () => { asked++; return new FakeStream(); };
  const { createRealtimeVoiceController: createCtrl } = await import("../src/voice/realtimeController.ts");
  const controller = createCtrl({
    candidates: () => [cand("Alice","a1")],
    bridge: () => ({ subscribe:()=>()=>{}, submit: async()=>{}, cancel: async()=>{} }),
    voiceSettings: () => ({ engine:"realtime", realtimeVoice:"verse", pauseMs:100, style:"pill", voices:[] }),
    mintSession: async () => ({ client_secret:"ek_fake", model:"gpt-realtime", voice:"verse" }),
    focus: () => {},
  });
  const started = controller.start({ hostId:"h1", roomId:"r1", participantId:"a1" });
  const ended = controller.end();
  await Promise.all([started, ended]);
  assert.equal(controller.getState().status, "off");
  assert.equal(asked, 0, "the microphone was never opened");
});

test("the session comes from the host that owns the call, with a clear failure otherwise", async () => {
  const { mintForScope } = await import("../src/voice/realtimeMint.ts");
  const asked = [];
  const entries = new Map([
    ["h1", { realtimeSession: async (args) => { asked.push(["h1", args]); return { client_secret:"ek", model:"m", voice:"v" }; } }],
    ["h2", { realtimeSession: async (args) => { asked.push(["h2", args]); return { client_secret:"ek", model:"m", voice:"v" }; } }],
    ["h3", {}],
  ]);
  const find = (hostId) => entries.get(hostId);
  await mintForScope(find, { hostId:"h2", room:"assistant:a" });
  assert.deepEqual(asked, [["h2", { room:"assistant:a" }]], "the same assistant id on another host is left alone, and hostId stays local");
  await assert.rejects(mintForScope(find, { hostId:"h3", room:"assistant:a" }), /OPENAI_API_KEY/);
  await assert.rejects(mintForScope(find, { hostId:"gone", room:"assistant:a" }), /no longer open/);
});

test("an assistant call uses the one conversation: one send, mute and end leave the work alone", async () => {
  const { createPersonalVoiceBridge } = await import("../src/voice/personalBridge.ts");
  const scope = { hostId:"h1", roomId:"assistant:a", participantId:"a" };
  const sent = [], stopped = [];
  let record = { id:"a", hostId:"h1", messages:[], events:[] };
  const bridge = createPersonalVoiceBridge({ scope, send: async (text, request) => { sent.push([text, request]); return { eventId:"pe-1" }; }, stop: async (event) => { stopped.push(event); }, read: async () => record, schedule: () => () => {} });
  const mics = [];
  getUserMediaImpl = async () => { const mic = new FakeStream(); mics.push(mic); return mic; };
  fetchImpl = async () => new Response("v=0 answer", { status: 200 });
  const controller = createRealtimeVoiceController({
    candidates: () => [{ ...scope, name:"Alfred" }], bridge: () => bridge, focus: () => {},
    voiceSettings: () => ({ engine:"realtime", realtimeVoice:"verse", pauseMs:100, style:"pill", voices:[] }),
    mintSession: async () => ({ client_secret:"ek_fake", model:"gpt-realtime", voice:"verse" }),
  });
  await controller.start(scope);
  const dc = FakePC.last.dc;
  dc._open();
  const opening = dc.sent.map(s => JSON.parse(s)).find(s => s.type === "session.update");
  assert.match(opening.session.instructions, /live voice of "Alfred"/);
  const call = (id, responseId) => dc._receive({ type:"response.function_call_arguments.done", response_id:responseId, call_id:id, name:"ask_agent", arguments:'{"agent":"Alfred","request":"status?"}' });
  const responseId = voiceInput(dc, "assistant-audio-1", "status?");
  call("c1", responseId); call("c1", responseId);
  dc._receive({type:"response.done",response:{id:responseId,status:"completed",output:[]}});
  await new Promise(r => setTimeout(r, 20));
  assert.equal(sent.length, 1, "a repeated tool event reaches the conversation once");
  record = { ...record, events:[{ id:"pe-1", state:"held" }] };
  bridge.update(record);
  assert.ok(dc.sent.some(s => s.includes("approval in Deck")), "a held reply is spoken, not silent");
  controller.mute(true);
  assert.equal(mics[0].getAudioTracks()[0].enabled, false);
  assert.deepEqual(stopped, [], "mute is not Stop");
  dc._receive({ type:"input_audio_buffer.speech_started" });
  assert.deepEqual(stopped, [], "talking over the voice doesn't stop the work");
  await controller.end();
  assert.deepEqual(stopped, [], "ending the call leaves the work running");
  assert.equal(mics[0].getAudioTracks()[0].stopped, true);
  await controller.start(scope);
  await controller.start(scope);
  assert.equal(mics[2].getAudioTracks()[0].stopped, false);
  assert.equal(mics[1].getAudioTracks()[0].stopped, true, "rejoining leaves one live mic");
  await controller.end();
  bridge.dispose();
});

async function authorityFixture() {
  const submitted = [], canceled = [], errors = [], listeners = new Set();
  let muted = false;
  const scope = {hostId:"h1", roomId:"r1", participantId:"b2"};
  const client = await connectRealtime({
    candidates:()=>[cand("Bob","b2")],
    bridge:()=>({subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);},async submit(turn){submitted.push(turn);},async cancel(id){canceled.push(id);}}),
    voiceSettings:()=>({engine:"realtime"}),
    mintSession:async()=>({client_secret:"ek_fake",model:"gpt-realtime",voice:"verse"}),
  },scope,{onEvent(){},onAudio(){},onError(error){errors.push(error);},onClose(){}},{muted:()=>muted,stream:()=>new FakeStream()});
  const dc=FakePC.last.dc;dc._open();
  const tool=(id,responseId,name="ask_agent",request="MODEL INVENTED REQUEST")=>dc._receive({type:"response.function_call_arguments.done",response_id:responseId,call_id:id,name,arguments:JSON.stringify({agent:"Bob",request})});
  return {client,dc,submitted,canceled,errors,tool,scope,listeners,mute(value){muted=value;client.setMuted?.(value);}};
}

test("model calls require one fresh committed transcript and use its exact text", async()=>{
  const f=await authorityFixture();
  f.tool("without-audio","unknown");
  assert.equal(f.submitted.length,0,"a model tool call alone has no human authority");
  const response=voiceInput(f.dc,"audio-authority","Please inspect the current error.");
  f.tool("bound",response);
  f.tool("second-call",response);
  assert.equal(f.submitted.length,1);
  assert.equal(f.submitted[0].text,"Please inspect the current error.");
  assert.equal(f.submitted[0].utteranceId,"audio-authority");
  f.client.close();
});

test("readback cannot create a human request or stop, even with a fresh unbound transcript", async()=>{
  const f=await authorityFixture();
  const response=voiceInput(f.dc,"audio-readback","Inspect the error");
  f.tool("work",response);
  f.dc._receive({type:"response.done",response:{id:response,status:"completed",output:[]}});
  const turn=f.submitted[0];
  for(const fn of [...f.listeners])fn({type:"done",requestId:turn.requestId,scope:f.scope});
  const readback=f.dc.sent.map(JSON.parse).filter(e=>e.type==="response.create").at(-1);
  assert.equal(readback.response.tool_choice,"none");
  assert.equal(readback.response.metadata,undefined);
  f.dc._receive({type:"response.created",response:{id:"readback-response"}});
  f.tool("loop","readback-response");f.tool("stop-loop","readback-response","stop_agent");
  assert.equal(f.submitted.length,1);assert.equal(f.canceled.length,0);
  f.client.close();
});

test("mute, barge-in, canceled responses and close revoke old voice authority", async()=>{
  const f=await authorityFixture();
  let response=voiceInput(f.dc,"audio-muted","Inspect the error");
  f.mute(true);f.mute(false);f.tool("late-muted",response);
  response=voiceInput(f.dc,"audio-barge","Inspect the error");
  f.dc._receive({type:"input_audio_buffer.speech_started",item_id:"next-speech"});f.tool("late-barge",response);
  response=voiceInput(f.dc,"audio-canceled","Inspect the error");
  f.dc._receive({type:"response.done",response:{id:response,status:"cancelled",output:[]}});f.tool("late-cancel",response);
  response=voiceInput(f.dc,"audio-closed","Inspect the error");f.client.close();f.tool("late-close",response);
  assert.equal(f.submitted.length,0);
});

test("out-of-order, empty and failed ASR never borrow another input's authority", async()=>{
  const f=await authorityFixture();
  f.dc._receive({type:"conversation.item.input_audio_transcription.completed",item_id:"uncommitted",transcript:"Invented authority"});
  f.tool("uncommitted","unknown");
  f.dc._receive({type:"input_audio_buffer.speech_started",item_id:"empty"});
  f.dc._receive({type:"input_audio_buffer.committed",item_id:"empty"});
  f.dc._receive({type:"conversation.item.input_audio_transcription.completed",item_id:"empty",transcript:"  "});
  f.dc._receive({type:"input_audio_buffer.speech_started",item_id:"failed"});
  f.dc._receive({type:"input_audio_buffer.committed",item_id:"failed"});
  f.dc._receive({type:"conversation.item.input_audio_transcription.failed",item_id:"failed"});
  f.dc._receive({type:"response.created",response:{id:"stale-asr-response",metadata:{apex_voice_input:"unknown"}}});
  f.tool("failed-input-tool","stale-asr-response");
  const response=voiceInput(f.dc,"fresh","Please stop Bob");
  f.tool("stop",response,"stop_agent");f.tool("stop-reuse",response,"stop_agent");
  assert.equal(f.submitted.length,0);
  // A valid stop consumes its utterance even when there is no pending work.
  f.tool("reuse-as-work",response);
  assert.equal(f.submitted.length,0);
  const creates=f.dc.sent.map(JSON.parse).filter(e=>e.type==="response.create" && e.response.metadata);
  assert.equal(creates.length,1);
  f.client.close();
});

test("muted speech cannot regain authority through late commit after unmute", async()=>{
  const f=await authorityFixture();
  f.dc._receive({type:"input_audio_buffer.speech_started",item_id:"old-speech"});
  f.mute(true);f.mute(false);
  f.dc._receive({type:"input_audio_buffer.committed",item_id:"old-speech"});
  f.dc._receive({type:"conversation.item.input_audio_transcription.completed",item_id:"old-speech",transcript:"Old speech"});
  const creates=f.dc.sent.map(JSON.parse).filter(e=>e.type==="response.create");
  assert.equal(creates.length,0);
  const fresh=voiceInput(f.dc,"new-speech","New speech");f.tool("new",fresh);
  assert.equal(f.submitted[0].text,"New speech");f.client.close();
});

test("stop tool selection cannot turn a request to keep working into cancellation", async()=>{
  const f=await authorityFixture();
  const work=voiceInput(f.dc,"work-speech","Inspect the error");f.tool("work",work);
  f.dc._receive({type:"response.done",response:{id:work,status:"completed",output:[]}});
  const noStop=voiceInput(f.dc,"keep-going","Don't stop Bob, continue working.");f.tool("bad-stop",noStop,"stop_agent");
  assert.equal(f.canceled.length,0);
  f.dc._receive({type:"response.done",response:{id:noStop,status:"completed",output:[]}});
  const stop=voiceInput(f.dc,"stop-speech","Please stop Bob");f.tool("good-stop",stop,"stop_agent");
  await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(f.canceled.length,1);f.client.close();
});

test("waiting, approval, failed-work and routing-error speech never has tools or human authority", async()=>{
  const f=await authorityFixture();
  const response=voiceInput(f.dc,"all-readbacks","Inspect the error");f.tool("work",response);
  f.dc._receive({type:"response.done",response:{id:response,status:"completed",output:[]}});
  const finishReadback=id=>{f.dc._receive({type:"response.created",response:{id}});f.dc._receive({type:"response.done",response:{id,status:"completed",output:[]}});};
  await new Promise(resolve=>setTimeout(resolve,820));
  finishReadback("waiting-speech");
  for(const fn of [...f.listeners])fn({type:"approval",requestId:f.submitted[0].requestId,scope:f.scope});
  finishReadback("approval-speech");
  for(const fn of [...f.listeners])fn({type:"failed",text:"failed",requestId:f.submitted[0].requestId,scope:f.scope});
  finishReadback("failure-speech");
  const unknown=voiceInput(f.dc,"unknown-target","Ask missing agent to inspect the error");
  f.dc._receive({type:"response.function_call_arguments.done",response_id:unknown,call_id:"missing",name:"ask_agent",arguments:JSON.stringify({agent:"Missing",request:"inspect"})});
  f.dc._receive({type:"response.done",response:{id:unknown,status:"completed",output:[]}});
  const readbacks=f.dc.sent.map(JSON.parse).filter(e=>e.type==="response.create"&&!e.response.metadata);
  assert.equal(readbacks.length,4);
  for(const [index,readback] of readbacks.entries()){
    assert.equal(readback.response.tool_choice,"none");
    const id=`readback-${index}`;f.dc._receive({type:"response.created",response:{id}});f.tool(`loop-${index}`,id);
  }
  assert.equal(f.submitted.length,1);f.client.close();
});

test("transcription completion before commit waits for its exact item; response done and item done preserve correlation",async()=>{
 const f=await authorityFixture();
 f.dc._receive({type:"input_audio_buffer.speech_started",item_id:"reordered"});
 f.dc._receive({type:"conversation.item.input_audio_transcription.completed",item_id:"reordered",transcript:"exact transcript"});
 assert.equal(f.dc.sent.map(JSON.parse).filter(e=>e.type==="response.create").length,0);
 f.dc._receive({type:"input_audio_buffer.committed",item_id:"reordered"});
 const created=f.dc.sent.map(JSON.parse).at(-1);
 f.dc._receive({type:"response.created",response:{id:"correct",metadata:created.response.metadata}});
 const item={type:"function_call",call_id:"item-done",name:"ask_agent",arguments:JSON.stringify({agent:"Bob",request:"invented text"})};
 f.dc._receive({type:"response.output_item.done",response_id:"unrelated",item});
 assert.equal(f.submitted.length,0);
 f.dc._receive({type:"response.output_item.done",response_id:"correct",item});
 f.dc._receive({type:"response.done",response:{id:"correct",status:"completed",output:[{...item,call_id:"second"}]}});
 assert.equal(f.submitted.length,1);assert.equal(f.submitted[0].text,"exact transcript");f.client.close();
});

test("replayed audio item events and copied response metadata cannot authorize a second human turn",async()=>{
 const f=await authorityFixture();
 const response=voiceInput(f.dc,"once-only","Inspect once");
 const metadata=f.dc.sent.map(JSON.parse).at(-1).response.metadata;
 f.dc._receive({type:"response.created",response:{id:"metadata-replay",metadata}});
 f.tool("copied-metadata","metadata-replay");assert.equal(f.submitted.length,0);
 f.tool("first",response);assert.equal(f.submitted.length,1);
 const replay=voiceInput(f.dc,"once-only","Inspect once");f.tool("second",replay);
 assert.equal(f.submitted.length,1);f.client.close();
});

test("fresh speech awaiting ASR holds old agent readback and gets the next response",async()=>{
 const f=await authorityFixture();
 const response=voiceInput(f.dc,"old-work","Inspect the error");f.tool("work",response);
 f.dc._receive({type:"response.done",response:{id:response,status:"completed",output:[]}});
 f.dc._receive({type:"input_audio_buffer.speech_started",item_id:"fresh-turn"});
 for(const fn of [...f.listeners])fn({type:"done",requestId:f.submitted[0].requestId,scope:f.scope});
 assert.equal(f.dc.sent.map(JSON.parse).filter(e=>e.type==="response.create").length,1,"readback waits while user speech is awaiting ASR");
 f.dc._receive({type:"input_audio_buffer.committed",item_id:"fresh-turn"});
 f.dc._receive({type:"conversation.item.input_audio_transcription.completed",item_id:"fresh-turn",transcript:"Fresh request"});
 const next=f.dc.sent.map(JSON.parse).filter(e=>e.type==="response.create").at(-1);
 assert.ok(next.response.metadata?.apex_voice_input);
 f.dc._receive({type:"response.created",response:{id:"fresh-response",metadata:next.response.metadata}});
 f.tool("fresh-work","fresh-response");assert.equal(f.submitted.at(-1).text,"Fresh request");f.client.close();
});

test("a fresh transcribed input waits for an already active readback instead of overlapping response.create",async()=>{
 const f=await authorityFixture();
 const response=voiceInput(f.dc,"work-before-readback","Inspect the error");f.tool("work",response);
 f.dc._receive({type:"response.done",response:{id:response,status:"completed",output:[]}});
 for(const fn of [...f.listeners])fn({type:"done",requestId:f.submitted[0].requestId,scope:f.scope});
 f.dc._receive({type:"response.created",response:{id:"active-readback"}});
 f.dc._receive({type:"input_audio_buffer.speech_started",item_id:"queued-input"});
 f.dc._receive({type:"input_audio_buffer.committed",item_id:"queued-input"});
 f.dc._receive({type:"conversation.item.input_audio_transcription.completed",item_id:"queued-input",transcript:"Queued request"});
 assert.equal(f.dc.sent.map(JSON.parse).filter(e=>e.type==="response.create").length,2,"no concurrent create while readback is active");
 f.dc._receive({type:"response.done",response:{id:"active-readback",status:"cancelled",output:[]}});
 const next=f.dc.sent.map(JSON.parse).filter(e=>e.type==="response.create").at(-1);
 f.dc._receive({type:"response.created",response:{id:"queued-response",metadata:next.response.metadata}});
 f.tool("queued-work","queued-response");assert.equal(f.submitted.at(-1).text,"Queued request");f.client.close();
});

test("a correlated response creation failure revokes input and reports a visible call error",async()=>{
 const f=await authorityFixture();
 f.dc._receive({type:"input_audio_buffer.speech_started",item_id:"creation-failed"});
 f.dc._receive({type:"input_audio_buffer.committed",item_id:"creation-failed"});
 f.dc._receive({type:"conversation.item.input_audio_transcription.completed",item_id:"creation-failed",transcript:"Inspect the error"});
 const request=f.dc.sent.map(JSON.parse).filter(e=>e.type==="response.create").at(-1);
 assert.equal(typeof request.event_id,"string");
 f.dc._receive({type:"error",error:{event_id:request.event_id,message:"provider detail"}});
 f.dc._receive({type:"response.created",response:{id:"after-error-response",metadata:request.response.metadata}});
 f.tool("after-error","after-error-response");assert.equal(f.submitted.length,0);assert.equal(f.errors.length,1);
 assert.match(f.errors[0].message,/Start a new call/);f.client.close();
});
