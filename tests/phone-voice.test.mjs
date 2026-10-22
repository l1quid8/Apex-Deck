import test from "node:test";
import assert from "node:assert/strict";
import { createPhoneVoice, PHONE_VOICE_KEY } from "../src/phone/phoneVoice.ts";
import { ParticipantQueues } from "../src/turnQueue.ts";
import { voicePreferenceKey } from "../src/voice/settings.ts";
const tick = () => new Promise((r) => setImmediate(r));
function fixture(storage = new Map(), options = {}) {
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
    roomTitle: options.roomTitle,
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
test("phone voice candidates carry the current title for their host and thread", () => {
  let title = "Voice calls";
  const f = fixture(new Map(), {
    roomTitle: (hostId, roomId) => hostId === "h" && roomId === "r" ? title : undefined,
  });
  assert.equal(f.voice.candidates("h", "r")[0].roomTitle, "Voice calls");
  title = "Voice call fixes";
  assert.equal(f.voice.candidates("h", "r")[0].roomTitle, "Voice call fixes", "renames are read without recreating voice");
  assert.equal(f.voice.candidates("h", "other")[0].roomTitle, undefined);
  assert.equal(f.voice.candidates("other", "r")[0].roomTitle, undefined);
  assert.equal(fixture().voice.candidates("h", "r")[0].roomTitle, undefined, "existing callers can omit title lookup");
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
  assert.ok(f.posts[0][4].requestId);
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
    client_turn_id: f.posts[0][4].requestId,
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
    f.posts[0][4].requestId,
    Error("post failed"),
  );
  await tick();
  assert.equal(f.voice.controller.getState().status, "error");
  assert.match(f.voice.controller.getState().error, /post failed/);
  assert.equal(f.stopped.length, 0);
});
test("the Mac's saved voices carry over; a settings load failure keeps phone settings", async () => {
  const f = fixture();
  f.host.backend.settingsLoad = async () => ({
    voice: { silenceMs: 900, look: "capsule", preferences: { [voicePreferenceKey("local", "null", "r", "null")]: { voice: "bf_emma", aliases: [] } } },
  });
  f.voice.threadOpened("h", "r");
  await tick();
  assert.equal(f.voice.settingsFor("h").silenceMs, 900);
  assert.equal(f.voice.settingsFor("h").look, "capsule");
  await f.voice.controller.start(f.scope);
  assert.equal(f.sent.find((m) => m.type === "start").voice, "bf_emma");
  await f.voice.controller.end();
  f.voice.save({ ...f.voice.settingsFor("h"), silenceMs: 200 }, "h");
  assert.equal(f.voice.settingsFor("h").silenceMs, 200);
  assert.equal(f.voice.settingsFor("h").look, "capsule");
  const g = fixture();
  g.host.backend.settingsLoad = async () => {
    throw Error("Full access needed");
  };
  g.voice.threadOpened("h", "r");
  await tick();
  assert.deepEqual(g.voice.settingsFor("h"), g.voice.settings());
});
