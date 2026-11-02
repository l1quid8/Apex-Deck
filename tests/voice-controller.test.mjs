import { test } from "node:test";
import assert from "node:assert/strict";
import { createVoiceController } from "../src/voice/controller.ts";
function fixture(options = {}) {
  let helper, listener, drained, playing, disconnected, helperAudio;
  const sent = [],
    posted = [],
    stopped = [],
    closeReasons = [],
    runtimeStops = [];
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
      status: async () =>
        options.status ?? { installed: true, supported: true },
      start:
        options.start ??
        (async () => ({ port: 1, token: "x", protocolVersion: 1 })),
      stop: async (runtime) => {
        runtimeStops.push(runtime);
        await options.stop?.(runtime);
      },
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
    connect: async (_r, fn, audio, failure) => {
      helper = fn;
      helperAudio = audio;
      disconnected = failure;
      return {
        send: (m) => sent.push(m),
        audio() {},
        close(reason) {
          closeReasons.push(reason);
        },
      };
    },
    playSample: options.playSample,
    candidates: () => options.candidates ?? [candidate],
    bridge: () => bridge,
    voice: () => "am_michael",
    silence: () => 700,
    focus: () => {},
  });
  return {
    helperAudio: (pcm, gen = 0) => helperAudio(pcm, gen),
    c,
    scope,
    sent,
    posted,
    stopped,
    closeReasons,
    runtimeStops,
    disconnect: () =>
      disconnected(Object.assign(Error("lost"), { name: "VoiceDisconnected" })),
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
  // Talking over the agent only cancels once the new words are a message.
  assert.equal(f.stopped.length, 0);
  f.event({ ...t, generation: 1, utteranceId: "u2", text: "Never mind that" });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(f.stopped.length, 1);
  assert.equal(f.posted.length, 2);
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
  await new Promise((r) => setTimeout(r, 0));
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
  f.event({
    type: "transcript",
    callId: start.callId,
    generation: 0,
    utteranceId: "silent-wait",
    text: "Check the build",
  });
  await Promise.resolve();
  assert.equal(f.posted.length, 1);
  t.mock.timers.tick(5000);
  assert.equal(f.c.getState().status, "waiting");
  assert.deepEqual(
    f.sent.filter((m) => m.type === "speak"),
    [],
  );
  f.reply({
    scope: f.scope,
    requestId: f.posted[0].requestId,
    type: "text",
    text: "The build passed. ",
  });
  f.reply({ scope: f.scope, requestId: f.posted[0].requestId, type: "done" });
  assert.equal(
    f.sent
      .filter((m) => m.type === "speak")
      .map((m) => m.text)
      .join(" "),
    "The build passed.",
  );
});
test("a dropped helper connection reconnects and keeps the call", async () => {
  let fail,
    connects = 0;
  const sent = [];
  const scope = { hostId: "h", roomId: "r", participantId: "a" };
  const c = createVoiceController({
    runtime: {
      status: async () => ({ installed: true, supported: true }),
      start: async () => ({ port: 1, token: "x", protocolVersion: 1 }),
      stop: async () => {},
    },
    openAudio: async () => ({
      mute() {},
      play() {},
      segmentEnd() {},
      flush() {},
      close() {},
      echoCancellation: true,
    }),
    connect: async (_r, _fn, _a, err) => {
      connects++;
      fail = err;
      return { send: (m) => sent.push(m), audio() {}, close() {} };
    },
    candidates: () => [{ ...scope, profileId: "a", name: "Null", aliases: [] }],
    bridge: () => ({
      submit: async () => ({}),
      cancel: async () => {},
      subscribe: () => () => {},
    }),
    voice: () => "am_michael",
    silence: () => 700,
    focus: () => {},
  });
  await c.start(scope);
  const callId = sent.find((m) => m.type === "start").callId;
  fail(
    Object.assign(Error("Local voice disconnected"), {
      name: "VoiceDisconnected",
    }),
  );
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
  f.event({
    type: "ready",
    callId: start.callId,
    generation: 0,
    voices: ["am_michael"],
  });
  f.event({
    type: "transcript",
    callId: start.callId,
    generation: 0,
    utteranceId: "m",
    text: "Explain the build",
  });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(f.posted.length, 1);
  f.c.mute(true);
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(f.stopped, []);
  assert.equal(f.sent.filter((m) => m.type === "cancel").length, 0);
  f.reply({
    scope: f.scope,
    requestId: f.posted[0].requestId,
    type: "text",
    text: "The build passed. ",
  });
  f.reply({ scope: f.scope, requestId: f.posted[0].requestId, type: "done" });
  assert.equal(
    f.sent
      .filter((m) => m.type === "speak")
      .map((m) => m.text)
      .join(" "),
    "The build passed.",
  );
  await f.c.end();
});

test("unsupported machine explains its reason", async () => {
  const reason = "Phone voice calls need a Linux x86-64 server for now.",
    f = fixture({ status: { supported: false, installed: false, reason } });
  await f.c.start(f.scope);
  await new Promise((r) => setImmediate(r));
  assert.equal(f.c.getState().status, "error");
  assert.equal(f.c.getState().error, reason);
});
test("ending a call never cancels the agent's reply and passes close reason", async () => {
  for (const reason of ["ended by user", "spoken stop phrase", "thread closed", "app left the screen"]) {
    const f = fixture();
    await f.c.start(f.scope);
    const start = f.sent.find((m) => m.type === "start");
    f.event({
      type: "ready",
      callId: start.callId,
      generation: 0,
      voices: ["am_michael"],
    });
    f.event({
      type: "transcript",
      callId: start.callId,
      generation: 0,
      utteranceId: "keep",
      text: "check the build",
    });
    await new Promise((r) => setImmediate(r));
    await f.c.end(reason);
    assert.equal(f.stopped.length, 0, reason);
    assert.deepEqual(f.closeReasons, [reason]);
  }
});

test("ending during a delayed reconnect closes that runtime without closing a newer call", async () => {
  let launches = 0,
    resolveReconnect;
  const first = { port: 1 },
    second = { port: 2 },
    third = { port: 3 };
  const f = fixture({
    start: () => {
      launches++;
      return launches === 1
        ? Promise.resolve(first)
        : launches === 2
          ? new Promise((r) => (resolveReconnect = r))
          : Promise.resolve(third);
    },
  });
  await f.c.start(f.scope);
  f.disconnect();
  await new Promise((r) => setImmediate(r));
  await f.c.end("app left the screen");
  await f.c.start(f.scope);
  resolveReconnect(second);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(f.runtimeStops, [first, second]);
  assert.notEqual(f.c.getState().status, "off");
  await f.c.end();
});

test("a spoken call reaches this chat's agent before same-named agents in other chats", async () => {
  const nul = { hostId: "h", roomId: "r", participantId: "a", profileId: "a", name: "Null", aliases: [] };
  const jigga = { hostId: "h", roomId: "r", participantId: "b", profileId: "b", name: "Jigga", aliases: [] };
  const elsewhere = { ...jigga, roomId: "s", roomTitle: "Voice calls" };
  const f = fixture({ candidates: [elsewhere, nul, jigga] });
  await f.c.start(f.scope);
  const start = f.sent.find((m) => m.type === "start");
  const event = (e) => f.event({ callId: start.callId, ...e });
  event({ type: "ready", generation: 0, voices: ["am_michael"] });
  event({ type: "transcript", generation: 0, utteranceId: "u0", text: "Call Jigga, what's next?" });
  await new Promise((r) => setImmediate(r));
  assert.equal(f.c.getState().candidates, undefined);
  assert.equal(f.c.getState().scope.roomId, "r");
  assert.equal(f.c.getState().scope.participantId, "b");
  assert.equal(f.posted.at(-1).text, "what's next?");
  await f.c.end();
});

test("switching agents mid-call keeps the previous agent working", async () => {
  const nul = { hostId: "h", roomId: "r", participantId: "a", profileId: "a", name: "Null", aliases: [] };
  const jigga = { hostId: "h", roomId: "r", participantId: "b", profileId: "b", name: "Jigga", aliases: [] };
  for (const how of ["spoken", "menu"]) {
    const f = fixture({ candidates: [nul, jigga] });
    await f.c.start(f.scope);
    const start = f.sent.find((m) => m.type === "start");
    const event = (e) => f.event({ callId: start.callId, ...e });
    event({ type: "ready", generation: 0, voices: ["am_michael"] });
    event({ type: "transcript", generation: 0, utteranceId: "u0", text: "check the build" });
    await new Promise((r) => setImmediate(r));
    if (how === "spoken") {
      event({ type: "speechStart", generation: 0 });
      event({ type: "transcript", generation: 1, utteranceId: "u1", text: "Call Jigga, what's next?" });
    } else {
      await f.c.switchAgent({ hostId: "h", roomId: "r", participantId: "b" });
    }
    await new Promise((r) => setImmediate(r));
    assert.equal(f.stopped.length, 0, how);
    assert.equal(f.c.getState().scope.participantId, "b", how);
    if (how === "spoken") assert.equal(f.posted.at(-1).scope.participantId, "b");
    await f.c.end();
  }
});

const tick = () => new Promise((r) => setTimeout(r, 0));
function samplePlayer() {
  const played = [];
  let finish;
  return {
    played,
    finish: () => finish(),
    playSample: (pcm, rate) => {
      played.push({ pcm, rate });
      return { done: new Promise((r) => (finish = r)), stop: () => finish() };
    },
  };
}
test("a voice sample outside a call speaks once in that voice, plays, then frees the helper", async () => {
  const p = samplePlayer();
  const f = fixture({ playSample: p.playSample });
  let started = false;
  const done = f.c.sample("bf_emma", () => (started = true));
  await tick();
  const start = f.sent.find((m) => m.type === "start");
  assert.equal(start.voice, "bf_emma");
  assert.equal(f.c.getState().status, "off");
  f.event({ type: "ready", callId: start.callId, generation: 0, voices: ["bf_emma"] });
  const speak = f.sent.find((m) => m.type === "speak");
  assert.equal(speak.voice, "bf_emma");
  assert.equal(speak.callId, start.callId);
  f.helperAudio(new Int16Array([1, 2]));
  f.helperAudio(new Int16Array([3]));
  assert.deepEqual(f.sent.filter((m) => m.type === "playbackProgress").map((m) => m.bytes), [4, 2]);
  f.event({ type: "audioEnd", callId: start.callId, generation: 0, segmentId: 1 });
  assert.deepEqual([...p.played[0].pcm], [1, 2, 3]);
  assert.equal(p.played[0].rate, 24000);
  assert.equal(started, true);
  assert.equal(f.runtimeStops.length, 0);
  p.finish();
  await done;
  assert.equal(f.runtimeStops.length, 1);
  assert.equal(f.c.getState().status, "off");
});
test("a voice sample the helper doesn't have fails plainly", async () => {
  const f = fixture({ playSample: samplePlayer().playSample });
  const done = f.c.sample("zz_nobody");
  await tick();
  const start = f.sent.find((m) => m.type === "start");
  f.event({ type: "ready", callId: start.callId, generation: 0, voices: ["bf_emma"] });
  await assert.rejects(done, /isn't installed/);
  assert.equal(f.runtimeStops.length, 1);
});
test("a voice sample before calls are set up asks for setup without starting the helper", async () => {
  let starts = 0;
  const f = fixture({
    playSample: samplePlayer().playSample,
    status: { installed: false, supported: true },
    start: async () => (starts++, { port: 1, token: "x", protocolVersion: 1 }),
  });
  await assert.rejects(f.c.sample("bf_emma"), /Set up calls first/);
  assert.equal(starts, 0);
});
test("starting a call stops a playing sample and frees the helper first", async () => {
  const p = samplePlayer();
  const f = fixture({ playSample: p.playSample });
  const done = f.c.sample("bf_emma");
  await tick();
  assert.equal(f.sent.filter((m) => m.type === "start").length, 1);
  await f.c.start(f.scope);
  await done;
  assert.equal(f.runtimeStops.length, 1);
  assert.ok(f.closeReasons.includes("sample done"));
  const starts = f.sent.filter((m) => m.type === "start");
  assert.equal(starts.length, 2);
  assert.equal(starts[1].voice, "am_michael");
  assert.notEqual(starts[1].callId, starts[0].callId);
  assert.equal(f.c.getState().status, "warming");
  await f.c.end();
});
test("settings samples during a call fail visibly and leave in-call preview available", async () => {
  const f = fixture({ playSample: samplePlayer().playSample });
  await f.c.start(f.scope);
  const start = f.sent.find((m) => m.type === "start");
  f.event({ type: "ready", callId: start.callId, generation: 0, voices: ["am_michael", "bf_emma"] });
  for (const voice of ["bf_emma", "zz_nobody"]) {
    await assert.rejects(f.c.sample(voice), /call.*preview/i);
  }
  assert.equal(f.sent.filter((m) => m.type === "speak").length, 0);
  f.c.preview("bf_emma");
  assert.equal(f.sent.filter((m) => m.type === "speak").at(-1).voice, "bf_emma");
  await f.c.end();
});
test("a call started while a sample is still loading frees the sample's helper before taking it", async () => {
  let release;
  const order = [];
  const f = fixture({
    playSample: samplePlayer().playSample,
    start: () => {
      order.push("start");
      return order.length === 1
        ? new Promise((r) => (release = () => r({ port: 1, token: "x", protocolVersion: 1 })))
        : Promise.resolve({ port: 2, token: "y", protocolVersion: 1 });
    },
  });
  const done = f.c.sample("bf_emma");
  await tick();
  const call = f.c.start(f.scope);
  await tick();
  assert.deepEqual(order, ["start"]);
  release();
  await done;
  await call;
  assert.deepEqual(f.runtimeStops.map((r) => r.port), [1]);
  assert.deepEqual(order, ["start", "start"]);
  assert.equal(f.sent.filter((m) => m.type === "start").length, 1);
  await f.c.end();
});

test("stop during sample loading keeps cleanup tracked until runtime release completes", async () => {
  let launch, release;
  let starts = 0;
  const f = fixture({
    playSample: samplePlayer().playSample,
    start: () => ++starts === 1
      ? new Promise((r) => { launch = r; })
      : Promise.resolve({ port: 2, token: "call", protocolVersion: 1 }),
    stop: () => new Promise((r) => { release = r; }),
  });
  const sample = f.c.sample("bf_emma");
  await tick();
  const stop = f.c.stopSample();
  const call = f.c.start(f.scope);
  await tick();
  assert.equal(starts, 1);
  launch({ port: 1, token: "sample", protocolVersion: 1 });
  await tick();
  assert.equal(starts, 1);
  release();
  await Promise.all([sample, stop, call]);
  assert.equal(starts, 2);
  assert.equal(f.c.getState().status, "warming");
  const end = f.c.end();
  await tick();
  release();
  await end;
});

test("two immediate sample requests cancel the first before acquiring the runtime", async () => {
  let starts = 0;
  const f = fixture({
    playSample: samplePlayer().playSample,
    start: async () => ({ port: ++starts, token: "sample", protocolVersion: 1 }),
  });
  const first = f.c.sample("bf_emma");
  const second = f.c.sample("am_michael");
  await tick();
  await f.c.stopSample();
  await Promise.all([first, second]);
  assert.equal(starts, 1);
  assert.equal(f.runtimeStops.length, 1);
});

test("a call also waits for cleanup of a sample superseded by a second sample", async () => {
  let launch;
  let starts = 0;
  const f = fixture({
    playSample: samplePlayer().playSample,
    start: () => ++starts === 1
      ? new Promise((r) => { launch = r; })
      : Promise.resolve({ port: 2, token: "call", protocolVersion: 1 }),
  });
  const first = f.c.sample("bf_emma");
  await tick();
  const second = f.c.sample("am_michael");
  const call = f.c.start(f.scope);
  await tick();
  assert.equal(starts, 1);
  launch({ port: 1, token: "sample", protocolVersion: 1 });
  await Promise.all([first, second, call]);
  assert.equal(starts, 2);
  assert.deepEqual(f.runtimeStops.map((r) => r.port), [1]);
  await f.c.end();
});

test("speaker startup failure reaches the sample caller and releases the runtime", async () => {
  const f = fixture({ playSample: () => ({ done: Promise.reject(Error("speakers unavailable")), stop() {} }) });
  const sample = f.c.sample("bf_emma");
  const rejected = assert.rejects(sample, /speakers unavailable/);
  await tick();
  const start = f.sent.find((m) => m.type === "start");
  f.event({ type: "audioEnd", callId: start.callId, generation: 0, segmentId: 1 });
  await rejected;
  assert.equal(f.runtimeStops.length, 1);
});

const caller = { hostId: "h", roomId: "r", participantId: "a", profileId: "a", name: "Null", aliases: [], roomTitle: "Current chat" };
const remoteCaller = { ...caller, roomId: "s", roomTitle: "Voice calls" };
async function choosingFixture() {
  const f = fixture({ candidates: [caller, remoteCaller] });
  await f.c.start(f.scope);
  const start = f.sent.find((m) => m.type === "start");
  f.event({ type: "ready", callId: start.callId, generation: 0, voices: ["am_michael"] });
  let utterance = 0;
  const transcript = async (text) => {
    f.event({ type: "speechStart", callId: start.callId, generation: f.sent.at(-1).generation });
    const generation = f.sent.at(-1).generation;
    f.event({ type: "transcript", callId: start.callId, generation, utteranceId: `choice-${++utterance}`, text });
    await new Promise((r) => setImmediate(r));
  };
  return { ...f, transcript };
}
test("uncertain calls speak a choice and dispatch only after the thread is chosen", async () => {
  for (const answer of ["yes", "Voice calls", "call Null in Voice calls", "menu"]) {
    const f = await choosingFixture();
    await f.transcript("call Null in voise calls, check the build");
    assert.equal(f.posted.length, 0, answer);
    assert.equal(f.c.getState().scope.roomId, "r", answer);
    assert.equal(f.c.getState().threadQuery, "voise calls");
    assert.deepEqual(f.c.getState().candidates.map((c) => c.roomId), ["s"]);
    assert.match(f.sent.find((m) => m.type === "speak").text, /Voice calls/);
    f.playing();
    f.drained();
    assert.equal(f.c.getState().status, "needs-attention");
    if (answer === "menu") await f.c.switchAgent(remoteCaller);
    else await f.transcript(answer);
    assert.equal(f.posted.length, 1, answer);
    assert.equal(f.posted[0].scope.roomId, "s", answer);
    assert.equal(f.posted[0].text, "check the build", answer);
    assert.equal(f.c.getState().candidates, undefined);
    assert.equal(f.c.getState().threadQuery, undefined);
    await f.c.end();
  }
});
test("unrecognized choice replies stay pending and cancel discards the held message", async () => {
  const f = await choosingFixture();
  await f.transcript("call Null in voise calls, check the build");
  await f.transcript("somewhere else");
  assert.equal(f.posted.length, 0);
  assert.equal(f.c.getState().status, "needs-attention");
  await f.transcript("cancel");
  assert.equal(f.posted.length, 0);
  assert.equal(f.c.getState().candidates, undefined);
  assert.equal(f.c.getState().status, "listening");
  await f.c.switchAgent(remoteCaller);
  assert.equal(f.posted.length, 0);
  await f.c.end();
});
test("ending or replacing a choice cannot send its held message later", async () => {
  for (const action of ["end", "replace", "other agent"]) {
    const f = await choosingFixture();
    await f.transcript("call Null in voise calls, old request");
    if (action === "end") {
      await f.c.end();
      await f.c.start(f.scope);
      await f.c.switchAgent(remoteCaller);
      assert.equal(f.posted.length, 0);
    } else if (action === "replace") {
      await f.transcript("call Null in Voice calls, new request");
      assert.deepEqual(f.posted.map((t) => t.text), ["new request"]);
    } else {
      await f.transcript("call Null in Current chat");
      assert.equal(f.posted.length, 0);
    }
    await f.c.end();
  }
});

test("a held request beginning with call is sent as a message after a menu choice", async () => {
  const f = await choosingFixture();
  await f.transcript("call Null in voise calls, call the test helper");
  await f.c.switchAgent(remoteCaller);
  assert.deepEqual(f.posted.map((t) => [t.scope.roomId, t.text]), [["s", "call the test helper"]]);
  await f.c.end();
});

test("a new uncertain call replaces the previous held request", async () => {
  const f = await choosingFixture();
  await f.transcript("call Null in voise calls, old request");
  await f.transcript("call Null in some other missing thread");
  await f.transcript("Voice calls");
  assert.equal(f.c.getState().scope.roomId, "s");
  assert.equal(f.posted.length, 0);
  await f.c.end();
});
test("multiple candidates with the same title never offer yes as a unique confirmation", async () => {
  const duplicate = { ...remoteCaller, roomId: "t" };
  const f = fixture({ candidates: [caller, remoteCaller, duplicate] });
  await f.c.start(f.scope);
  const start = f.sent.find((m) => m.type === "start");
  f.event({ type: "ready", callId: start.callId, generation: 0, voices: ["am_michael"] });
  f.event({ type: "transcript", callId: start.callId, generation: 0, utteranceId: "duplicates", text: "call Null in voise calls" });
  await new Promise((r) => setImmediate(r));
  assert.equal(f.c.getState().candidates.length, 2);
  assert.equal(f.posted.length, 0);
  assert.doesNotMatch(f.sent.find((m) => m.type === "speak").text, /say yes/i);
  await f.c.end();
});

test("muting the microphone does not discard a request confirmed by tapping a thread", async () => {
  const f = await choosingFixture();
  await f.transcript("call Null in voise calls, check the build");
  f.c.mute(true);
  await f.c.switchAgent(remoteCaller);
  assert.deepEqual(f.posted.map((t) => [t.scope.roomId, t.text]), [["s", "check the build"]]);
  assert.equal(f.c.getState().muted, true);
  await f.c.end();
});

test('latest mute intent survives delayed runtime, audio and connection readiness without accepting muted input',async()=>{
 for(const phase of ['runtime','audio','connect'])for(const finalMuted of [true,false]){
  let release,entered;const gate=new Promise(resolve=>{release=resolve;}),atGate=new Promise(resolve=>{entered=resolve;});let helper,frame;const mutes=[],frames=[],sent=[],scope={hostId:'mute-host',roomId:'room',participantId:'agent'};
  const wait=async name=>{if(phase===name){entered();await gate;}};
  const controller=createVoiceController({runtime:{status:async()=>({installed:true,supported:true}),start:async()=>{await wait('runtime');return {};},stop:async()=>{}},openAudio:async onFrame=>{frame=onFrame;await wait('audio');return{mute:value=>mutes.push(value),play(){},segmentEnd(){},flush(){},close(){},echoCancellation:true};},connect:async(_runtime,onEvent)=>{helper=onEvent;await wait('connect');return{send:message=>sent.push(message),audio:pcm=>frames.push(pcm),close(){}};},candidates:()=>[],bridge(){},voice:()=> 'am_michael',silence:()=>100,focus(){}});
  const started=controller.start(scope);await atGate;controller.mute(true);if(!finalMuted)controller.mute(false);release();await started;
  const start=sent.find(message=>message.type==='start');assert.ok(start);
  helper({type:'ready',callId:start.callId,generation:start.generation,voices:['am_michael']});
  assert.equal(controller.getState().muted,finalMuted,`${phase}: helper readiness preserves intent`);assert.equal(mutes.at(-1),finalMuted,`${phase}: audio acquisition follows the latest mute intent`);
  frame(new Int16Array([1]));assert.equal(frames.length,finalMuted?0:1,`${phase}: microphone forwarding follows intent`);
  await controller.end();
 }
});

test('End while the previous call closes cancels the replacement call',async()=>{
 let release,entered;const closing=new Promise(resolve=>{entered=resolve;}),held=new Promise(resolve=>{release=resolve;});
 const f=fixture({stop:()=>{entered();return held;}});
 await f.c.start(f.scope);
 const replacement=f.c.start({...f.scope,roomId:'replacement'});
 await closing;
 const ended=f.c.end('user ends replacement');
 release();
 await Promise.all([replacement,ended]);
 assert.equal(f.c.getState().status,'off');
 assert.equal(f.closed,1,'only the first call ever opened audio');
});

test('a newer call wins while an older one still waits for the previous call to close',async()=>{
 let release,entered;const closing=new Promise(resolve=>{entered=resolve;}),held=new Promise(resolve=>{release=resolve;});
 const f=fixture({stop:()=>{entered();return held;}});
 await f.c.start(f.scope);
 const older=f.c.start({...f.scope,roomId:'older'});
 await closing;
 const newer=f.c.start({...f.scope,roomId:'newer'});
 release();
 await Promise.all([older,newer]);
 assert.equal(f.c.getState().scope.roomId,'newer');
 await f.c.end();
});
