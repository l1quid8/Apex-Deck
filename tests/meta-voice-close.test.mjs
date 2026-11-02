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

async function call() {
  globalThis.WebSocket = FakeSocket;
  FakeSocket.all = [];
  let helperError;
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
    candidates: () => [],
    bridge: () => ({ submit: async () => ({}), cancel: async () => {}, subscribe: () => () => {} }),
    voice: () => "af_heart",
    silence: () => 700,
    voiceSettings: () => ({}),
    mintSession: async () => ({ token: "t", model: "m" }),
    focus() {},
  });
  await c.start(scope);
  return { c, socket: () => FakeSocket.all.at(-1), helperError: (e) => helperError(e) };
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
