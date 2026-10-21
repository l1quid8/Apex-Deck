import { test } from "node:test";
import assert from "node:assert/strict";
import { connectServerVoice } from "../src/voice/serverClient.ts";
import { decodeAudio, encodeAudio } from "../src/voice/audioProtocol.ts";
import { fromBase64, toBase64 } from "../src/daemon/transport.ts";
function fixture(initial) {
  let receive, lost;
  const sent = [],
    closed = [],
    events = [],
    audio = [],
    errors = [],
    weak = [];
  const link = {
    attach: (_c, cb) => {
      receive = cb;
      if (initial) cb(initial);
      return () => {};
    },
    onLost: (cb) => {
      lost = cb;
      return () => {};
    },
    send: (f) => {
      sent.push(f);
      return true;
    },
    close: async (...a) => {
      closed.push(a);
    },
  };
  return {
    link,
    sent,
    closed,
    events,
    audio,
    errors,
    weak,
    receive: (f) => receive(f),
    lost: () => lost("lost"),
    connect: () =>
      connectServerVoice(
        link,
        { channel: 5, protocolVersion: 1 },
        (e) => events.push(e),
        (...a) => audio.push(a),
        (e) => errors.push(e),
        (w) => weak.push(w),
      ),
  };
}
test("helper events and audio reach callbacks", async () => {
  const f = fixture();
  await f.connect();
  f.receive({ channel: 5, ctl: { type: "ready" } });
  f.receive({
    channel: 5,
    bin: toBase64(new Uint8Array(encodeAudio(2, 1, new Int16Array([12, -5])))),
  });
  assert.deepEqual(f.events, [{ type: "ready" }]);
  assert.deepEqual(f.audio, [[new Int16Array([12, -5]), 2]]);
});
test("mic backs off at 96 unacked frames and resumes below 32", async () => {
  const f = fixture(),
    c = await f.connect();
  for (let i = 0; i < 100; i++) c.audio(new Int16Array([3]), 2);
  assert.equal(f.sent.length, 96);
  assert.deepEqual(f.weak, [true]);
  f.receive({ channel: 5, rx: 80 });
  c.audio(new Int16Array([4]), 2);
  assert.deepEqual(f.weak, [true, false]);
  const frame = decodeAudio(fromBase64(f.sent.at(-1).bin).buffer);
  assert.equal(frame.sequence, 97);
  assert.equal(frame.generation, 2);
});
test("close sends reason exactly once and suppresses subsequent failure", async () => {
  const f = fixture(),
    c = await f.connect();
  c.close("ended by user");
  c.close();
  f.lost();
  assert.deepEqual(f.closed, [[5, "ended by user"]]);
  assert.equal(f.errors.length, 0);
});
test("closed or lost channel reports VoiceDisconnected", async () => {
  for (const kind of ["closed", "lost"]) {
    const f = fixture();
    await f.connect();
    if (kind === "closed") f.receive({ channel: 5, closed: "gone" });
    else f.lost();
    assert.equal(f.errors[0].name, "VoiceDisconnected");
  }
});
test("already closed channel rejects connecting", async () => {
  const f = fixture({ channel: 5, closed: "gone" });
  await assert.rejects(f.connect(), { name: "VoiceDisconnected" });
});
test("server link buffers early frames, remembers closes and clears session numbers on loss", async () => {
  const { serverVoiceLink } = await import("../src/voice/serverClient.ts");
  let receive, status;
  const client = {
    onVoice: (cb) => (receive = cb),
    onStatus: (cb) => {
      status = cb;
      cb({ kind: "connected" });
    },
    call: async () => {},
    sendVoice: () => true,
  };
  const link = serverVoiceLink(client),
    got = [];
  for (let i = 0; i < 70; i++)
    receive({ channel: 5, ctl: { type: "timing", n: i } });
  link.attach(5, (f) => got.push(f));
  assert.equal(got.length, 64);
  assert.equal(got[0].ctl.n, 6);
  receive({ channel: 6, closed: "gone" });
  await assert.rejects(
    connectServerVoice(
      link,
      { channel: 6, protocolVersion: 1 },
      () => {},
      () => {},
      () => {},
    ),
    { name: "VoiceDisconnected" },
  );
  let lost = 0;
  link.onLost(() => lost++);
  status({ kind: "reconnecting" });
  assert.equal(lost, 1);
  status({ kind: "connected" });
  const fresh = [];
  link.attach(6, (f) => fresh.push(f));
  assert.equal(fresh.length, 0);
});
