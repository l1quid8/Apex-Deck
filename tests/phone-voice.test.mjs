import test from "node:test";
import assert from "node:assert/strict";
import { createPhoneVoice, PHONE_VOICE_KEY } from "../src/phone/phoneVoice.ts";
import { ParticipantQueues } from "../src/turnQueue.ts";
import { voicePreferenceKey } from "../src/voice/settings.ts";
const tick = () => new Promise((r) => setImmediate(r));
function fixture(storage = new Map()) {
  let event,
    roomEvent,
    screen = true,
    now = 100000;
  const sent = [],
    posts = [],
    closed = [],
    awake = [],
    warms = [],
    stopped = [];
  const scope = { hostId: "h", roomId: "r", participantId: "null" };
  const link = {
    status: async () => ({ installed: true, supported: true }),
    open: async (room) => ({ channel: 5, protocolVersion: 1 }),
    close: async (...args) => closed.push(args),
    warm: async (room) => warms.push(room),
  };
  const backend = {
    onRoomEvent: async (cb) => {
      roomEvent = cb;
      return () => {};
    },
    voiceCapabilities: async () => ({ voice_turn_correlation_v1: true }),
    roomStopRequest: async (...a) => {
      stopped.push(a);
      return "already-ended";
    },
  };
  const q = new ParticipantQueues(
    async () => ["null"],
    async (...a) => posts.push(a),
    async () => {},
    () => {},
  );
  const host = {
    name: "Server",
    backend,
    voice: link,
    canCall: () => true,
    whenConnected: async () => {},
  };
  const voice = createPhoneVoice({
    host: (id) => (id === "h" ? host : null),
    queue: () => q,
    participants: () => [{ id: "null", display_name: "Null" }],
    onScreen: () => screen,
    storage: {
      getItem: (k) => storage.get(k) ?? null,
      setItem: (k, v) => storage.set(k, v),
    },
    keepAwake: (on) => awake.push(on),
    now: () => now,
    openAudio: async () => ({
      mute() {},
      play() {},
      segmentEnd() {},
      flush() {},
      close() {},
      echoCancellation: true,
    }),
    connect: async (_l, _r, cb) => {
      event = cb;
      return {
        send: (m) => sent.push(m),
        audio() {},
        close: (r) => closed.push([5, r]),
      };
    },
  });
  return {
    voice,
    scope,
    host,
    storage,
    sent,
    posts,
    closed,
    awake,
    warms,
    stopped,
    event: (e) => event({ ...sent.find((m) => m.type === "start"), ...e }),
    room: (e) => roomEvent("r", e),
    screen: (v) => (screen = v),
    time: (v) => (now = v),
  };
}
test("canCall requires eligible host", () => {
  const f = fixture();
  assert.equal(f.voice.canCall("missing"), false);
  assert.equal(f.voice.canCall("h"), true);
  f.host.canCall = () => false;
  assert.equal(f.voice.canCall("h"), false);
});
test("call transcripts target chosen agent; leaving preserves turn and releases awake", async () => {
  const f = fixture();
  await f.voice.controller.start(f.scope);
  f.event({ type: "ready", voices: ["am_michael"] });
  f.event({ type: "transcript", utteranceId: "u", text: "check the build" });
  await tick();
  await tick();
  assert.equal(f.posts[0][0], "check the build");
  assert.deepEqual(f.posts[0][1], ["null"]);
  assert.ok(f.posts[0][5].requestId);
  f.voice.leftScreen();
  await tick();
  assert.equal(f.voice.controller.getState().status, "off");
  assert.equal(f.stopped.length, 0);
  assert.deepEqual(f.awake, [true, false]);
  assert.ok(f.closed.some((x) => x[1] === "app left the screen"));
});
test("settings aliases survive recreation and warm only previously called hosts", async () => {
  const f = fixture();
  f.voice.threadOpened("h", "r");
  assert.equal(f.warms.length, 0);
  const key = voicePreferenceKey("h", "null", "r", "null");
  f.voice.save({
    ...f.voice.settings(),
    preferences: { [key]: { voice: "af_heart", aliases: ["Null bot"] } },
  });
  assert.ok(f.storage.has(PHONE_VOICE_KEY));
  assert.deepEqual(fixture(f.storage).voice.candidates("h", "r")[0].aliases, [
    "Null bot",
  ]);
  await f.voice.controller.start(f.scope);
  f.event({ type: "ready", voices: ["af_heart"] });
  f.voice.threadOpened("h", "r");
  f.voice.threadOpened("h", "r");
  assert.equal(f.warms.length, 1);
  f.time(160001);
  f.voice.threadOpened("h", "r");
  assert.equal(f.warms.length, 2);
  await f.voice.controller.end();
});
test("offscreen approval marks attention without navigating; opening clears it", async () => {
  const f = fixture();
  await f.voice.controller.start(f.scope);
  f.event({ type: "ready", voices: ["am_michael"] });
  f.event({
    type: "transcript",
    utteranceId: "attention",
    text: "check the build",
  });
  await tick();
  await tick();
  f.screen(false);
  f.room({
    type: "voice_event",
    id: "null",
    client_turn_id: f.posts[0][5].requestId,
    event: { type: "approval_requested" },
  });
  assert.equal(f.voice.view().attention, true);
  f.voice.threadOpened("h", "r");
  assert.equal(f.voice.view().attention, false);
  await f.voice.controller.end("test", { keepWork: true });
});
test("failed voice post ends its call with the error", async () => {
  const f = fixture();
  await f.voice.controller.start(f.voice.candidates("h", "r")[0]);
  f.event({ type: "ready", voices: ["am_michael"] });
  f.event({ type: "transcript", utteranceId: "fail", text: "check the build" });
  await tick();
  await tick();
  f.voice.failed(
    "h",
    "r",
    "null",
    f.posts[0][5].requestId,
    Error("post failed"),
  );
  await tick();
  assert.equal(f.voice.controller.getState().status, "error");
  assert.match(f.voice.controller.getState().error, /post failed/);
  assert.equal(f.stopped.length, 0);
});
