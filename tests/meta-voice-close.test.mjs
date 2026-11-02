import { test } from "node:test";
import assert from "node:assert/strict";
import { setImmediate as tick } from "node:timers/promises";
import { createMetaVoiceController } from "../src/voice/metaController.ts";

// A call Meta has hung up on cannot hear, so it must not stay up looking healthy.
class FakeSocket {
  static OPEN = 1;
  static all = [];
  readyState = 1;
  constructor() {
    FakeSocket.all.push(this);
    queueMicrotask(() => this.onopen?.());
  }
  send(data) {
    if (typeof data === "string") queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ sessionId: "s" }) }));
  }
  close() {
    queueMicrotask(() => this.drop(1000));
  }
  drop(code, reason = "") {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
}

const scope = { hostId: "h", roomId: "r", participantId: "a" };

async function call({ mint = async () => ({ token: "t", model: "m" }), candidates = [] } = {}) {
  globalThis.WebSocket = FakeSocket;
  FakeSocket.all = [];
  let helperError;
  const submitted = [];
  const c = createMetaVoiceController({
    runtime: {
      status: async () => ({ installed: true, supported: true }),
      start: async () => ({ port: 1, token: "x", protocolVersion: 1 }),
      stop: async () => {},
    },
    openAudio: async () => ({ mute() {}, play() {}, segmentEnd() {}, flush() {}, close() {}, echoCancellation: true }),
    connect: async (_runtime, _event, _audio, error) => {
      helperError = error;
      return { send() {}, close() {} };
    },
    candidates: () => candidates,
    bridge: () => ({
      submit: async (turn) => {
        submitted.push(turn);
        return {};
      },
      cancel: async () => {},
      subscribe: () => () => {},
    }),
    voice: () => "af_heart",
    silence: () => 700,
    voiceSettings: () => ({}),
    mintSession: mint,
    focus() {},
  });
  await c.start(scope);
  return { c, submitted, socket: () => FakeSocket.all.at(-1), helperError: (e) => helperError(e) };
}

test("Meta closing a live call without an error ends it and shows why", async () => {
  const { c, socket } = await call();
  socket().drop(1006);
  await tick();
  const state = c.getState();
  assert.equal(state.status, "error");
  assert.match(state.error, /Meta.*1006/);
  assert.deepEqual(state.scope, scope);
});

test("the close reason Meta gives reaches the person", async () => {
  const { c, socket } = await call();
  socket().drop(1008, "stream too slow");
  await tick();
  assert.match(c.getState().error, /stream too slow/);
});

test("a clean close from Meta still ends a live call", async () => {
  const { c, socket } = await call();
  socket().drop(1000);
  await tick();
  assert.equal(c.getState().status, "error");
});

test("Meta closing a muted call ends it too", async () => {
  const { c, socket } = await call();
  c.mute(true);
  socket().drop(1006);
  await tick();
  assert.equal(c.getState().status, "error");
});

test("hanging up does not report a Meta close", async () => {
  const { c } = await call();
  await c.end();
  await tick();
  assert.equal(c.getState().status, "off");
  assert.equal(c.getState().error, undefined);
});

test("switching agents replaces the Meta connection without ending the call", async () => {
  const { c } = await call();
  await c.switchAgent({ ...scope, participantId: "b" });
  await tick();
  assert.equal(c.getState().status, "listening");
  assert.equal(c.getState().scope.participantId, "b");
  assert.equal(FakeSocket.all.length, 2);
});

test("recovering from a helper disconnect replaces the Meta connection without ending the call", async () => {
  const { c, helperError } = await call();
  helperError(Object.assign(Error("helper gone"), { name: "VoiceDisconnected" }));
  await tick();
  await tick();
  assert.notEqual(c.getState().status, "error");
  assert.notEqual(c.getState().status, "off");
  assert.equal(FakeSocket.all.length, 2);
});

// Meta's first connection works; these scripts control the ones after it.
function mintThen(...later) {
  let calls = 0;
  return async () => {
    if (calls++ === 0) return { token: "t", model: "m" };
    return later[calls - 2]();
  };
}

test("a failed reconnect while switching agents ends the call and shows why", async () => {
  const { c } = await call({ mint: mintThen(() => Promise.reject(Error("no key"))) });
  await c.switchAgent({ ...scope, participantId: "b" });
  await tick();
  const state = c.getState();
  assert.equal(state.status, "error");
  assert.match(state.error, /Meta.*no key/);
  assert.equal(state.scope.participantId, "b");
});

test("words spoken with a switch are not sent when the reconnect fails", async () => {
  const bob = { ...scope, participantId: "b", name: "Bob", aliases: [] };
  const { c, submitted, socket } = await call({
    mint: mintThen(() => Promise.reject(Error("no key"))),
    candidates: [bob],
  });
  socket().onmessage({ data: JSON.stringify({ type: "speechComplete", transcript: "call Bob, hello there", turnId: 1 }) });
  await tick();
  await tick();
  assert.equal(c.getState().status, "error");
  assert.deepEqual(submitted, []);
});

test("hanging up during a switch does not report the cancelled reconnect", async () => {
  let fail;
  const { c } = await call({ mint: mintThen(() => new Promise((_, reject) => (fail = reject))) });
  const switching = c.switchAgent({ ...scope, participantId: "b" });
  await tick();
  await c.end();
  fail(Error("cancelled"));
  await switching;
  await tick();
  assert.equal(c.getState().status, "off");
  assert.equal(c.getState().error, undefined);
});

test("a second switch survives the first one's cancelled reconnect failing", async () => {
  let fail;
  const { c } = await call({
    mint: mintThen(
      () => new Promise((_, reject) => (fail = reject)),
      async () => ({ token: "t", model: "m" }),
    ),
  });
  const first = c.switchAgent({ ...scope, participantId: "b" });
  await tick();
  await c.switchAgent({ ...scope, participantId: "c" });
  fail(Error("cancelled"));
  await first;
  await tick();
  assert.equal(c.getState().status, "listening");
  assert.equal(c.getState().scope.participantId, "c");
});
