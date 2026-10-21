import { test } from "node:test";
import assert from "node:assert/strict";
import { createVoiceController } from "../src/voice/controller.ts";
function fixture() {
  let helper, listener, drained, playing;
  const sent = [],
    posted = [],
    stopped = [];
  let closed = 0;
  const scope = { hostId: "h", roomId: "r", participantId: "a" };
  const candidate = { ...scope, profileId: "a", name: "Null", aliases: [] };
  const bridge = {
    submit: async (turn) => {
      posted.push(turn);
      return { requestId: turn.requestId };
    },
    cancel: async (id) => {
      stopped.push(id);
    },
    subscribe: (fn) => {
      listener = fn;
      return () => {};
    },
  };
  const c = createVoiceController({
    runtime: {
      status: async () => ({ installed: true, supported: true }),
      start: async () => ({ port: 1, token: "x", protocolVersion: 1 }),
      stop: async () => {},
    },
    openAudio: async (_frame, onDrain, onPlay) => {
      drained = onDrain;
      playing = onPlay;
      return {
        mute() {},
        play() {},
        segmentEnd() {},
        flush() {},
        close() {
          closed++;
        },
        echoCancellation: true,
      };
    },
    connect: async (_r, fn) => {
      helper = fn;
      return { send: (m) => sent.push(m), audio() {}, close() {} };
    },
    candidates: () => [candidate],
    bridge: () => bridge,
    voice: () => "am_michael",
    silence: () => 700,
    focus: () => {},
  });
  return {
    c,
    scope,
    sent,
    posted,
    stopped,
    bridge,
    get closed() {
      return closed;
    },
    event: (e) => helper(e),
    reply: (e) => listener(e),
    drained: () => drained(1),
    playing: () => playing(),
  };
}
test("call default off, transcript once, matching reply, interruption, end", async () => {
  const f = fixture();
  assert.equal(f.c.getState().status, "off");
  await f.c.start(f.scope);
  const start = f.sent.find((m) => m.type === "start");
  f.event({
    type: "ready",
    callId: start.callId,
    generation: 0,
    voices: ["am_michael"],
  });
  const t = {
    type: "transcript",
    callId: start.callId,
    generation: 0,
    utteranceId: "u",
    text: "Hello",
  };
  f.event(t);
  f.event(t);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(f.posted.length, 1);
  f.reply({
    scope: f.scope,
    requestId: "unrelated",
    type: "text",
    text: "Never speak.",
  });
  assert.equal(f.sent.filter((m) => m.type === "speak").length, 0);
  f.event({ type: "speechStart", callId: start.callId, generation: 0 });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(f.stopped.length, 1);
  await f.c.end();
  assert.equal(f.c.getState().status, "off");
  assert.equal(f.closed, 1);
});
test("stale events cannot leave error, muted and code are not sent", async () => {
  const f = fixture();
  await f.c.start(f.scope);
  const start = f.sent.find((m) => m.type === "start");
  f.c.mute(true);
  f.event({
    type: "transcript",
    callId: start.callId,
    generation: 0,
    utteranceId: "u",
    text: "not sent",
  });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(f.posted.length, 0);
  await f.c.end();
  f.event({ type: "ready", callId: start.callId, generation: 0 });
  assert.equal(f.c.getState().status, "off");
});
test("permission denial releases runtime and leaves a visible scoped error", async () => {
  let stopped = 0;
  const scope = { hostId: "h", roomId: "r", participantId: "a" };
  const c = createVoiceController({
    runtime: {
      status: async () => ({ supported: true, installed: true }),
      start: async () => ({ port: 1, token: "x", protocolVersion: 1 }),
      stop: async () => {
        stopped++;
      },
    },
    openAudio: async () => {
      throw Error("Microphone denied");
    },
    connect: async () => {
      throw Error("must not connect");
    },
    candidates: () => [],
    bridge: () => {
      throw Error("no bridge");
    },
    voice: () => "am_michael",
    silence: () => 700,
    focus: () => {},
  });
  await c.start(scope);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(stopped, 1);
  assert.deepEqual(c.getState().scope, scope);
  assert.equal(c.getState().status, "error");
});

test("repeated interruption drops old transcript waiting on cleanup", async () => {
  const f = fixture();
  let release;
  f.bridge.cancel = () => new Promise((r) => (release = r));
  await f.c.start(f.scope);
  const start = f.sent.find((m) => m.type === "start");
  const event = (type, generation, extra = {}) =>
    f.event({ type, callId: start.callId, generation, ...extra });
  event("transcript", 0, { utteranceId: "u0", text: "first" });
  await new Promise((r) => setTimeout(r, 0));
  event("speechStart", 0);
  await new Promise((r) => setTimeout(r, 0));
  event("transcript", 1, { utteranceId: "u1", text: "stale second" });
  event("speechStart", 1);
  event("transcript", 2, { utteranceId: "u2", text: "replacement third" });
  release();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(
    f.posted.map((x) => x.text),
    ["first", "replacement third"],
  );
  f.bridge.cancel = async () => {};
  await f.c.end();
});

test("playback drain returns an idle call to listening", async () => {
  const f = fixture();
  await f.c.start(f.scope);
  f.playing();
  assert.equal(f.c.getState().status, "speaking");
  f.drained();
  assert.equal(f.c.getState().status, "listening");
  await f.c.end();
});


test("waiting for an agent stays silent until its reply arrives", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture();
  t.after(() => f.c.end());
  await f.c.start(f.scope);
  const start = f.sent.find((m) => m.type === "start");
  f.event({ type: "transcript", callId: start.callId, generation: 0,
    utteranceId: "silent-wait", text: "Check the build" });
  await Promise.resolve();
  assert.equal(f.posted.length, 1);
  t.mock.timers.tick(5000);
  assert.equal(f.c.getState().status, "waiting");
  assert.deepEqual(f.sent.filter((m) => m.type === "speak"), []);
  f.reply({ scope: f.scope, requestId: f.posted[0].requestId,
    type: "text", text: "The build passed. " });
  f.reply({ scope: f.scope, requestId: f.posted[0].requestId, type: "done" });
  assert.equal(f.sent.filter((m) => m.type === "speak").map((m) => m.text).join(" "), "The build passed.");
});
test("a dropped helper connection reconnects and keeps the call", async () => {
  let fail, connects = 0;
  const sent = [];
  const scope = { hostId: "h", roomId: "r", participantId: "a" };
  const c = createVoiceController({
    runtime: {
      status: async () => ({ installed: true, supported: true }),
      start: async () => ({ port: 1, token: "x", protocolVersion: 1 }),
      stop: async () => {},
    },
    openAudio: async () => ({ mute() {}, play() {}, segmentEnd() {}, flush() {}, close() {}, echoCancellation: true }),
    connect: async (_r, _fn, _a, err) => {
      connects++;
      fail = err;
      return { send: (m) => sent.push(m), audio() {}, close() {} };
    },
    candidates: () => [{ ...scope, profileId: "a", name: "Null", aliases: [] }],
    bridge: () => ({ submit: async () => ({}), cancel: async () => {}, subscribe: () => () => {} }),
    voice: () => "am_michael",
    silence: () => 700,
    focus: () => {},
  });
  await c.start(scope);
  const callId = sent.find((m) => m.type === "start").callId;
  fail(Object.assign(Error("Local voice disconnected"), { name: "VoiceDisconnected" }));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(connects, 2);
  const starts = sent.filter((m) => m.type === "start");
  assert.equal(starts.length, 2);
  assert.equal(starts[1].callId, callId);
  assert.notEqual(c.getState().status, "off");
  assert.notEqual(c.getState().status, "error");
});
test("muting mid-reply keeps the agent working and speaking", async () => {
  const f = fixture();
  await f.c.start(f.scope);
  const start = f.sent.find((m) => m.type === "start");
  f.event({ type: "ready", callId: start.callId, generation: 0, voices: ["am_michael"] });
  f.event({ type: "transcript", callId: start.callId, generation: 0,
    utteranceId: "m", text: "Explain the build" });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(f.posted.length, 1);
  f.c.mute(true);
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(f.stopped, []);
  assert.equal(f.sent.filter((m) => m.type === "cancel").length, 0);
  f.reply({ scope: f.scope, requestId: f.posted[0].requestId,
    type: "text", text: "The build passed. " });
  f.reply({ scope: f.scope, requestId: f.posted[0].requestId, type: "done" });
  assert.equal(f.sent.filter((m) => m.type === "speak").map((m) => m.text).join(" "), "The build passed.");
  await f.c.end();
});
