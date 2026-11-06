import { test } from "node:test";
import assert from "node:assert/strict";
import { createMetaVoiceController } from "../src/voice/metaController.ts";

// Meta rejects a live stream that falls behind real time, so a muted call must keep sending silence.
class FakeSocket {
  static OPEN = 1;
  static last;
  readyState = 1;
  sent = [];
  constructor() {
    FakeSocket.last = this;
    queueMicrotask(() => this.onopen?.());
  }
  send(data) {
    this.sent.push(data);
    if (typeof data === "string") queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ sessionId: "s" }) }));
  }
  close() {}
}

async function call() {
  globalThis.WebSocket = FakeSocket;
  let frame;
  const workletMutes = [];
  const scope = { hostId: "h", roomId: "r", participantId: "a" };
  const c = createMetaVoiceController({
    runtime: {
      status: async () => ({ installed: true, supported: true }),
      start: async () => ({ port: 1, token: "x", protocolVersion: 1 }),
      stop: async () => {},
    },
    openAudio: async (onFrame) => {
      frame = onFrame;
      return { mute: (v) => workletMutes.push(v), play() {}, segmentEnd() {}, flush() {}, close() {}, echoCancellation: true };
    },
    connect: async () => ({ send() {}, close() {} }),
    candidates: () => [],
    bridge: () => ({ submit: async () => ({}), cancel: async () => {}, subscribe: () => () => {} }),
    voice: () => "af_heart",
    silence: () => 700,
    voiceSettings: () => ({}),
    mintSession: async () => ({ token: "t", model: "m" }),
    focus() {},
  });
  await c.start(scope);
  return { c, frame: (f) => frame(f), workletMutes, audioSent: () => FakeSocket.last.sent.filter((x) => typeof x !== "string") };
}

test("a muted Meta call sends silence in place of every mic frame", async () => {
  const { c, frame, audioSent } = await call();
  c.mute(true);
  frame(new Int16Array(512).fill(1000));
  const sent = audioSent();
  assert.equal(sent.length, 1, "the stream must not stop while muted");
  assert.equal(sent[0].byteLength, 1024);
  assert.ok(new Uint8Array(sent[0]).every((b) => b === 0), "muted speech must never reach Meta");
});

test("muting a Meta call keeps the capture worklet running", async () => {
  const { c, workletMutes } = await call();
  c.mute(true);
  assert.deepEqual(workletMutes, []);
});

test("an unmuted Meta call sends the real mic audio", async () => {
  const { frame, audioSent } = await call();
  frame(new Int16Array(512).fill(1000));
  assert.ok(new Uint8Array(audioSent()[0]).some((b) => b !== 0));
});
