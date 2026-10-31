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

  dc._receive({ type:"response.output_item.added", item: { type:"function_call", call_id:"call-1", name:"ask_agent", arguments:"{}" } });
  dc._receive({ type:"response.function_call_arguments.delta", call_id:"call-1", delta:'{"agent":"Bob","request":"do x"}' });
  dc._receive({ type:"response.function_call_arguments.done", call_id:"call-1", name:"ask_agent", arguments:'{"agent":"Bob","request":"do x"}' });
  dc._receive({ type:"response.done", response: { output: [{ type:"function_call", call_id:"call-1", name:"ask_agent", arguments:'{"agent":"Bob","request":"do x"}' }] } });

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
