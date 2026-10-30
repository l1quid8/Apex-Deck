import test from "node:test";
import assert from "node:assert/strict";
import { machineVoice } from "../src/phone/machineVoice.ts";
import { createPhoneVoice, PHONE_VOICE_KEY } from "../src/phone/phoneVoice.ts";
import { readVoiceSettings } from "../src/voice/settings.ts";

class FakeChannel {
  readyState = "connecting";
  sent = [];
  send(text) { this.sent.push(text); }
  close() { this.readyState = "closed"; }
}
class FakePeer {
  static last;
  channel = new FakeChannel();
  closed = false;
  constructor() { FakePeer.last = this; }
  addTrack() {}
  createDataChannel() { return this.channel; }
  async createOffer() { return { type: "offer", sdp: "offer" }; }
  async setLocalDescription() {}
  async setRemoteDescription() {}
  close() { this.closed = true; }
}
const track = () => ({ enabled: true, stopped: false, stop() { this.stopped = true; } });
class FakeStream {
  tracks = [track()];
  getAudioTracks() { return this.tracks; }
  getTracks() { return this.tracks; }
}
globalThis.RTCPeerConnection = FakePeer;
globalThis.Audio = class { play() { return Promise.resolve(); } pause() {} };
const stream = new FakeStream();
Object.defineProperty(globalThis, "navigator", { configurable: true, value: { mediaDevices: { getUserMedia: async () => stream } } });
const sdp = [];
globalThis.fetch = async (url, init) => { sdp.push({ url: String(url), auth: init.headers.Authorization }); return new Response("answer"); };

function fixture({ machine, settingsLoad, call, connected } = {}) {
  const calls = [], opened = [];
  const storage = new Map();
  const backend = {
    settingsLoad: settingsLoad ?? (async () => ({ voice: machine })),
    voiceCapabilities: async () => ({ voice_turn_correlation_v1: true }),
    onRoomEvent: async () => () => {},
    call: call ?? (async (cmd, args) => { calls.push({ cmd, args }); return { client_secret: "ek_test", model: args.model, voice: args.voice }; }),
  };
  const voice = createPhoneVoice({
    host: (id) => id === "mac" ? {
      name: "Mac", backend, canCall: () => true, whenConnected: connected ?? (async () => {}),
      voice: { open: async (room) => { opened.push(room); return { channel: 5, protocolVersion: 1 }; }, warm: async () => {}, status: async () => ({ installed: true, supported: true }), close: async () => {} },
    } : null,
    queue: () => ({ items: [] }),
    participants: () => [{ id: "null", display_name: "Null" }, { id: "jigga", display_name: "Jigga" }],
    onScreen: () => true,
    storage: { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v) },
    keepAwake: () => {},
    openAudio: async () => ({ mute() {}, play() {}, segmentEnd() {}, flush() {}, close() {}, echoCancellation: true }),
    connect: async () => ({ send() {}, audio() {}, close() {} }),
  });
  return { voice, calls, opened, storage };
}
const scope = { hostId: "mac", roomId: "r", participantId: "null" };
const none = { silence: false, look: false, realtimeVoice: false, realtimeModel: false };

test("the phone follows the machine's engine, and its GPT-Live picks unless it chose its own", () => {
  const mac = readVoiceSettings({ engine: "realtime", realtimeVoice: "marin", realtimeModel: "gpt-realtime-2.1" });
  const followed = machineVoice(readVoiceSettings({ realtimeVoice: "cedar" }), mac, none, "mac");
  assert.equal(followed.engine, "realtime");
  assert.equal(followed.realtimeVoice, "marin");
  assert.equal(followed.realtimeModel, "gpt-realtime-2.1");
  const own = machineVoice(readVoiceSettings({ realtimeVoice: "cedar" }), mac, { ...none, realtimeVoice: true }, "mac");
  assert.equal(own.realtimeVoice, "cedar");
  assert.equal(machineVoice(readVoiceSettings({ engine: "realtime" }), readVoiceSettings({}), none, "mac").engine, "local", "only the machine picks the engine");
});

test("a call on a GPT-Live machine mints on that machine and skips the local helper", async () => {
  const f = fixture({ machine: { engine: "realtime", realtimeVoice: "marin" } });
  await f.voice.controller.start(scope);
  assert.equal(f.voice.engine(), "realtime");
  assert.deepEqual(f.opened, [], "the local voice helper stays closed");
  assert.equal(f.calls[0].cmd, "voice_realtime_session");
  assert.equal(f.calls[0].args.room, "r");
  assert.equal(f.calls[0].args.voice, "marin");
  assert.match(f.calls[0].args.instructions, /Default agent is "Null"/);
  assert.match(f.calls[0].args.instructions, /Jigga/);
  assert.equal(sdp.at(-1).auth, "Bearer ek_test");
  assert.equal(f.voice.controller.getState().status, "listening");
  f.voice.controller.mute(true);
  assert.equal(stream.tracks[0].enabled, false);
  assert.equal(f.voice.controller.getState().muted, true);
  await f.voice.controller.end();
  assert.equal(FakePeer.last.closed, true);
  assert.equal(f.voice.engine(), "local");
  stream.tracks[0].enabled = true;
});

test("a call reads the machine's engine again, so a change on the Mac needs no thread reopen", async () => {
  let machine = { engine: "local" };
  const f = fixture({ settingsLoad: async () => ({ voice: machine }) });
  f.voice.threadOpened("mac", "r");
  await new Promise((r) => setImmediate(r));
  assert.equal(f.voice.settingsFor("mac").engine, "local");
  machine = { engine: "realtime" };
  await new Promise((r) => setTimeout(r, 1100));
  await f.voice.controller.start(scope);
  assert.equal(f.voice.engine(), "realtime");
  await f.voice.controller.end();
});

test("a machine that can't be read in time leaves the call on Local", async () => {
  const f = fixture({ settingsLoad: async () => { throw Error("Full access needed"); } });
  await f.voice.controller.start(scope);
  assert.equal(f.voice.engine(), "local");
  assert.deepEqual(f.opened, ["r"]);
  await f.voice.controller.end();
});

test("an older machine gets a plain update message, and a missing key shows as the call's error", async () => {
  const old = fixture({ machine: { engine: "realtime" }, call: async () => { throw Error("unknown variant `voice_realtime_session`, expected one of `a`"); } });
  await old.voice.controller.start(scope);
  assert.equal(old.voice.controller.getState().status, "error");
  assert.match(old.voice.controller.getState().error, /Update Mac/);
  assert.deepEqual(old.voice.controller.getState().scope, scope);
  const nokey = fixture({ machine: { engine: "realtime" }, call: async () => { throw Error("Missing OpenAI API key."); } });
  await nokey.voice.controller.start(scope);
  assert.match(nokey.voice.controller.getState().error, /Missing OpenAI/);
});

test("picks saved on the phone stay the phone's and never store an engine", async () => {
  const f = fixture({ machine: { engine: "realtime", realtimeVoice: "marin" } });
  await f.voice.refreshSettings("mac");
  f.voice.save({ ...f.voice.settingsFor("mac"), realtimeVoice: "cedar" }, "mac");
  assert.equal(f.voice.settingsFor("mac").realtimeVoice, "cedar");
  assert.equal(f.voice.settingsFor("mac").engine, "realtime");
  assert.equal(JSON.parse(f.storage.get(PHONE_VOICE_KEY)).engine, "local");
});

test("ending a call while it waits for the machine's settings cancels it", async () => {
  let settings;
  const f = fixture({ settingsLoad: () => new Promise((resolve) => { settings = resolve; }) });
  const pending = f.voice.controller.start(scope);
  await f.voice.controller.end("user stopped");
  settings({ voice: { engine: "realtime" } });
  await pending;
  assert.equal(f.voice.controller.getState().status, "off", "the call opened after End");
  assert.deepEqual(f.calls, [], "no GPT-Live session was bought for an ended call");
});

test("leaving the screen while a call waits for the machine's settings cancels it", async () => {
  let settings;
  const f = fixture({ settingsLoad: () => new Promise((resolve) => { settings = resolve; }) });
  const pending = f.voice.controller.start(scope);
  f.voice.leftScreen();
  settings({ voice: { engine: "realtime" } });
  await pending;
  assert.equal(f.voice.controller.getState().status, "off", "the call opened on a hidden app");
  assert.deepEqual(f.calls, [], "no GPT-Live session was bought after leaving");
});

test("a mic tap still waiting is no longer wanted after End, leaving the screen or a newer call", async () => {
  const f = fixture({ machine: { engine: "local" } });
  for (const stop of [() => f.voice.leftScreen(), () => f.voice.controller.end(), () => f.voice.controller.start(scope)]) {
    const wanted = f.voice.startWanted();
    assert.equal(wanted(), true);
    await stop();
    assert.equal(wanted(), false);
  }
  await f.voice.controller.end();
});
