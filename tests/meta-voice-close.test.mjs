import { test } from "node:test";
import assert from "node:assert/strict";
import { setImmediate as tick } from "node:timers/promises";
import { createMetaVoiceController } from "../src/voice/metaController.ts";

// A call Meta has hung up on cannot hear, so it must not stay up looking healthy.
class FakeSocket {
  static OPEN = 1;
  static all = [];
  static afterAck;
  readyState = 1;
  bufferedAmount = 0;
  sent = [];
  constructor() {
    FakeSocket.all.push(this);
    queueMicrotask(() => this.onopen?.());
  }
  send(data) {
    this.sent.push(data);
    if (typeof data === "string") queueMicrotask(() => {
      this.onmessage?.({ data: JSON.stringify({ sessionId: "s" }) });
      FakeSocket.afterAck?.(this);
    });
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

async function call({ mint = async () => ({ token: "t", model: "m" }), candidates = [], stop = async () => {}, autoStart = true, connectGate } = {}) {
  globalThis.WebSocket = FakeSocket;
  FakeSocket.all = [];
  FakeSocket.afterAck = undefined;
  let helperError, audioCallbacks;
  const submitted = [];
  const helpers = [];
  const c = createMetaVoiceController({
    runtime: {
      status: async () => ({ installed: true, supported: true }),
      start: async () => ({ port: 1, token: "x", protocolVersion: 1 }),
      stop,
    },
    openAudio: async (...callbacks) => { audioCallbacks = callbacks; return { mute() {}, play() {}, segmentEnd() {}, flush() {}, close() {}, echoCancellation: true }; },
    connect: async (_runtime, _event, _audio, error) => {
      helperError = error;
      const helper = { sent: [], closed: false, event: _event, send(message) { this.sent.push(message); }, close() { this.closed = true; } };
      helpers.push(helper);
      if (helpers.length === 2) await connectGate?.();
      return helper;
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
    voice: (scope) => "voice-" + scope.participantId,
    silence: () => 700,
    voiceSettings: () => ({}),
    mintSession: mint,
    focus() {},
  });
  if (autoStart) await c.start(scope);
  return { c, submitted, helpers, audioCallbacks: () => audioCallbacks, socket: () => FakeSocket.all.at(-1), helperError: (e) => helperError(e) };
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


test("words from a cancelled spoken switch never reach the newer agent", async () => {
  let fail;
  const bob = { ...scope, participantId: "b", name: "Bob", aliases: [] };
  const carol = { ...scope, participantId: "c", name: "Carol", aliases: [] };
  const { c, submitted, socket } = await call({
    mint: mintThen(
      () => new Promise((_, reject) => (fail = reject)),
      async () => ({ token: "t", model: "m" }),
    ),
    candidates: [bob, carol],
  });
  socket().onmessage({ data: JSON.stringify({ type: "speechComplete", transcript: "call Bob, hello there", turnId: 1 }) });
  await tick();
  assert.equal(c.getState().scope.participantId, "b");
  await c.switchAgent(carol);
  fail(Error("cancelled"));
  await tick();
  assert.deepEqual(submitted, []);
  assert.equal(c.getState().scope.participantId, "c");
  assert.equal(c.getState().status, "listening");
  // The replacement connection still routes new speech to its own recipient.
  socket().onmessage({ data: JSON.stringify({ type: "speechComplete", transcript: "hello Carol", turnId: 2 }) });
  await tick();
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0].text, "hello Carol");
  assert.equal(submitted[0].scope.participantId, "c");
  await c.end();
});

for (const replacement of ["new call", "hangup"]) {
  test(`old Meta disconnect cleanup cannot overwrite a ${replacement}`, async () => {
    let finishStop;
    const { c, socket } = await call({
      stop: () => new Promise((resolve) => (finishStop = resolve)),
    });
    socket().drop(1006);
    await tick();
    assert.equal(typeof finishStop, "function");
    if (replacement === "new call") {
      await c.start({ ...scope, participantId: "b" });
      assert.equal(c.getState().status, "listening");
    } else {
      await c.end();
    }
    const replacementState = c.getState();
    finishStop();
    await tick();
    assert.deepEqual(c.getState(), replacementState);
    if (replacement === "new call") {
      const ending = c.end();
      await tick();
      finishStop();
      await ending;
    }
  });
}


test("words accompanying a successful switch reach the requested agent", async () => {
  const bob = { ...scope, participantId: "b", name: "Bob", aliases: [] };
  const { c, submitted, socket } = await call({ candidates: [bob] });
  socket().onmessage({ data: JSON.stringify({ type: "speechComplete", transcript: "call Bob, hello there", turnId: 1 }) });
  await tick();
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0].scope.participantId, "b");
  assert.equal(submitted[0].text, "hello there");
  await c.end();
});


test("a switch cancels helper recovery without retrying the old recipient", async () => {
  let finishRecovery;
  const recipients = [];
  const { c, helperError, socket, submitted, helpers } = await call({
    mint: async ({ participant }) => {
      recipients.push(participant);
      if (recipients.length === 2) return new Promise(resolve => { finishRecovery = resolve; });
      return { token: "t", model: "m" };
    },
  });
  helperError(Object.assign(Error("helper gone"), { name: "VoiceDisconnected" }));
  await tick();
  assert.equal(typeof finishRecovery, "function");
  await c.switchAgent({ ...scope, participantId: "b" });
  finishRecovery({ token: "t", model: "m" });
  await tick();
  await tick();
  assert.deepEqual(recipients, ["a", "a", "b"]);
  assert.equal(helpers[1].sent.find(message => message.type === "start")?.voice, "voice-a",
    "recovered helper must start before the pending Meta connection can be cancelled");
  assert.equal(FakeSocket.all.filter(s => s.readyState === FakeSocket.OPEN).length, 1);
  assert.equal(c.getState().status, "listening");
  assert.equal(c.getState().reconnecting, false);
  socket().onmessage({ data: JSON.stringify({ type: "speechComplete", transcript: "hello Bob", turnId: 1 }) });
  await tick();
  assert.equal(submitted[0].scope.participantId, "b");
  await c.end();
});

test("a superseded connection closing during handshake handoff cannot end the current call", async () => {
  const { c, socket } = await call();
  let replacement;
  FakeSocket.afterAck = oldSocket => {
    FakeSocket.afterAck = undefined;
    replacement = c.switchAgent({ ...scope, participantId: "c" });
    // The abort listener is not installed until the handshake promise resumes.
    oldSocket.drop(1008, "old connection closed");
  };
  await c.switchAgent({ ...scope, participantId: "b" });
  await replacement;
  await tick();
  assert.equal(c.getState().status, "listening");
  assert.equal(c.getState().scope.participantId, "c");
  // A close from the current connection still ends the call.
  socket().drop(1008, "current connection closed");
  await tick();
  assert.equal(c.getState().status, "error");
  assert.match(c.getState().error, /current connection closed/);
});

for (const replacement of ["new call", "hangup"]) {
  test(`failed start cleanup cannot overwrite a ${replacement}`, async () => {
    let finishStop;
    let mints = 0;
    const { c } = await call({
      autoStart: false,
      mint: async () => {
        if (++mints === 1) throw Error("no key");
        return { token: "t", model: "m" };
      },
      stop: () => new Promise(resolve => { finishStop = resolve; }),
    });
    const starting = c.start(scope);
    await tick();
    assert.equal(typeof finishStop, "function");
    if (replacement === "new call") {
      await c.start({ ...scope, participantId: "b" });
      assert.equal(c.getState().status, "listening");
    } else {
      await c.end();
    }
    const replacementState = c.getState();
    finishStop();
    await starting;
    assert.deepEqual(c.getState(), replacementState);
    if (replacement === "new call") {
      const ending = c.end();
      await tick();
      finishStop();
      await ending;
    }
  });
}


test("a switch during helper connection owns Meta and recovery starts the current voice", async () => {
  let finishHelper;
  const recipients = [];
  const { c, helperError, helpers, socket, submitted } = await call({
    connectGate: () => new Promise(resolve => { finishHelper = resolve; }),
    mint: async ({ participant }) => {
      recipients.push(participant);
      return { token: "t", model: "m" };
    },
  });
  helperError(Object.assign(Error("helper gone"), { name: "VoiceDisconnected" }));
  await tick();
  assert.equal(typeof finishHelper, "function");
  await c.switchAgent({ ...scope, participantId: "b" });
  finishHelper();
  await tick();
  await tick();
  assert.deepEqual(recipients, ["a", "b"], "recovery must not replace the switch's connection");
  assert.equal(FakeSocket.all.filter(s => s.readyState === FakeSocket.OPEN).length, 1);
  assert.equal(helpers[1].sent.find(message => message.type === "start")?.voice, "voice-b");
  assert.equal(c.getState().scope.participantId, "b");
  assert.equal(c.getState().status, "listening");
  assert.equal(c.getState().reconnecting, false);
  socket().onmessage({ data: JSON.stringify({ type: "speechComplete", transcript: "hello Bob", turnId: 1 }) });
  await tick();
  assert.equal(submitted[0].scope.participantId, "b");
  await c.end();
});


test("a switch during a failed helper attempt keeps ownership of Meta across recovery retries", async () => {
  let failHelper;
  const recipients = [];
  const { c, helperError, helpers, socket, submitted } = await call({
    connectGate: () => new Promise((_, reject) => { failHelper = reject; }),
    mint: async ({ participant }) => {
      recipients.push(participant);
      return { token: "t", model: "m" };
    },
  });
  try {
    helperError(Object.assign(Error("helper gone"), { name: "VoiceDisconnected" }));
    await tick();
    assert.equal(typeof failHelper, "function");
    await c.switchAgent({ ...scope, participantId: "b" });
    failHelper(Error("helper connection failed"));
    await tick();
    await tick();
    assert.equal(helpers.length, 3, "recovery retried the helper connection");
    assert.equal(FakeSocket.all.filter(s => s.readyState === FakeSocket.OPEN).length, 1);
    assert.deepEqual(recipients, ["a", "b"], "retry must preserve the switch's Meta connection");
    assert.equal(helpers[2].sent.find(message => message.type === "start")?.voice, "voice-b");
    assert.equal(c.getState().status, "listening");
    assert.equal(c.getState().reconnecting, false);
    socket().onmessage({ data: JSON.stringify({ type: "speechComplete", transcript: "hello Bob", turnId: 1 }) });
    await tick();
    assert.equal(submitted[0].scope.participantId, "b");
  } finally {
    await c.end();
  }
});

test("a failed Meta recovery attempt closes its helper before retrying", async () => {
  const { c, helperError, helpers } = await call({
    mint: mintThen(
      async () => { throw Error("mint failed"); },
      async () => ({ token: "t", model: "m" }),
    ),
  });
  try {
    helperError(Object.assign(Error("helper gone"), { name: "VoiceDisconnected" }));
    await tick();
    await tick();
    assert.equal(helpers.length, 3);
    assert.ok(helpers[1].sent.some(message => message.type === "start"));
    assert.equal(helpers[1].closed, true, "failed attempt must not leave an active helper");
    assert.equal(helpers[2].closed, false);
    const started = helpers[2].sent.find(message => message.type === "start");
    assert.ok(started);
    helpers[2].event({ type: "ready", callId: started.callId, generation: started.generation, voices: ["voice-a"] });
    assert.equal(FakeSocket.all.filter(s => s.readyState === FakeSocket.OPEN).length, 1);
    assert.equal(c.getState().status, "listening");
    assert.equal(c.getState().reconnecting, false);
  } finally {
    await c.end();
  }
});


test("Meta returns consumed playback credits and segment completion to helper", async () => {
  const { c, helpers, audioCallbacks } = await call();
  audioCallbacks()[4](48000);
  audioCallbacks()[1](7);
  assert.ok(helpers[0].sent.some(m => m.type === 'playbackProgress' && m.bytes === 48000));
  assert.ok(helpers[0].sent.some(m => m.type === 'playbackComplete' && m.segmentId === 7));
  await c.end();
});
test("Meta turn begun muted cannot submit after unmute", async () => {
  const { c, socket, submitted } = await call();
  const emit = e => socket().onmessage({data: JSON.stringify(e)});
  c.mute(true);
  emit({type:'speechStart',turnId:9});
  c.mute(false);
  emit({type:'speechComplete',turnId:9,transcript:'phantom words'});
  await tick();
  assert.equal(submitted.length, 0);
  await c.end();
});

test("Meta mic send queue remains bounded and resumes after congestion", async () => {
  const { c, socket, audioCallbacks } = await call();
  socket().bufferedAmount = 40000;
  for(let i=0;i<100;i++) audioCallbacks()[0](new Int16Array(512));
  assert.equal(socket().sent.filter(x=>typeof x !== 'string').length,0);
  socket().bufferedAmount = 0;
  audioCallbacks()[0](new Int16Array(512));
  assert.equal(socket().sent.filter(x=>typeof x !== 'string').length,1);
  assert.equal(c.getState().status,'listening');
  await c.end();
});

test("noise over a Meta call does not cancel anything, and an empty final resumes", async () => {
  const { c, socket, submitted, helpers } = await call();
  const emit = (e) => socket().onmessage({ data: JSON.stringify(e) });
  const cancels = () => helpers.at(-1).sent.filter((m) => m.type === "cancel").length;
  const before = cancels();
  emit({ type: "speechStart", turnId: 9 });
  assert.equal(c.getState().status, "hearing");
  emit({ type: "speechEnd", turnId: 9 });
  assert.equal(c.getState().status, "hearing", "nothing is known yet, so no working dots");
  emit({ type: "speechComplete", turnId: 9, transcript: "" });
  await tick();
  assert.equal(c.getState().status, "listening");
  assert.equal(cancels(), before);
  assert.equal(submitted.length, 0);
});
