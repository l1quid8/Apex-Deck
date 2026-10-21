import test from "node:test";
import assert from "node:assert/strict";
import { voiceCallView, voiceSize } from "../src/phone/voiceCallView.ts";
const view = (status, over = {}) =>
  voiceCallView({
    state: { status, muted: false, voices: [] },
    agent: "Null",
    machine: "Server",
    weak: false,
    attention: false,
    canSetUp: true,
    ...over,
  });
test("status words follow every call state", () => {
  for (const [s, word] of Object.entries({
    warming: "Starting voice on Server…",
    listening: "Listening",
    hearing: "Hearing you",
    waiting: "Null is thinking",
    speaking: "Null is speaking",
    "needs-attention": "Null needs you in the thread",
    error: "The call ended",
  }))
    assert.equal(view(s).status, word);
  assert.equal(
    view("listening", { state: { status: "listening", muted: true } }).status,
    "Muted",
  );
  assert.equal(
    view("hearing", { weak: true }).status,
    "Weak connection — some words may be lost",
  );
});
test("setup explains progress, retry and Full access", () => {
  const setup = { installed: false, downloadBytes: 812000000 };
  assert.match(view("setup", { setup }).setup.body, /about 812 MB to Server/);
  assert.equal(
    view("setup", {
      setup: {
        ...setup,
        installing: {
          stage: "Downloading",
          downloaded: 300000000,
          total: 812000000,
        },
      },
    }).setup.progress,
    "Downloading · 300 MB of 812 MB",
  );
  assert.equal(
    view("setup", { setup: { ...setup, failed: "Voice setup canceled." } })
      .setup.note,
    "Setup stopped: Voice setup canceled.",
  );
  assert.equal(view("setup", { setup, canSetUp: false }).setup.button, null);
  assert.match(
    view("setup", { setup, canSetUp: false }).setup.note,
    /Full access/,
  );
  assert.equal(voiceSize(1200000000), "1.2 GB");
});
test("mic and bar name agent", () => {
  assert.equal(view("off").mic.label, "Call Null");
  assert.equal(view("listening").mic.label, "Call controls");
  assert.equal(
    view("waiting", { attention: true }).bar,
    "On call with Null · needs you",
  );
});
