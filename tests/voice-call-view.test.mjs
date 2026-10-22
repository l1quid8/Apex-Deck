import { test } from "node:test";
import assert from "node:assert/strict";
import { callLine, callClock, readCallLook, DEFAULT_CALL_LOOK, pickNote, pickRows } from "../src/voice/callView.ts";
import { readVoiceSettings } from "../src/voice/settings.ts";

const state = (patch) => ({ status: "listening", muted: false, voices: [], ...patch });

test("the look is one of the three, and the pill when unset or unknown", () => {
  assert.equal(DEFAULT_CALL_LOOK, "pill");
  for (const look of ["bar", "pill", "capsule"]) assert.equal(readCallLook(look), look);
  for (const bad of [undefined, null, "", "dock", 3, {}]) assert.equal(readCallLook(bad), "pill");
  assert.equal(readVoiceSettings(undefined).look, "pill");
  assert.equal(readVoiceSettings({ look: "capsule" }).look, "capsule");
  assert.equal(readVoiceSettings({ look: "island" }).look, "pill");
});

test("each moment of a call has its own words and wave", () => {
  assert.deepEqual(callLine(state({ status: "speaking" }), "Null"), {
    status: "Talking · speak to interrupt",
    hint: "Null is talking · speak to interrupt",
    wave: "bot",
    tone: "ok",
  });
  assert.equal(callLine(state({ status: "waiting" }), "Null").hint, "Null is working…");
  assert.equal(callLine(state({ status: "waiting" }), "Null").wave, "dots");
  assert.equal(callLine(state({ status: "hearing" }), "Null").wave, "you");
  assert.equal(callLine(state({ status: "listening" }), "Null").status, "Listening");
  assert.equal(callLine(state({ status: "warming" }), "Null").status, "Starting…");
});

test("reconnecting, problems and mute read differently from a normal call", () => {
  const back = callLine(state({ status: "warming", reconnecting: true }), "Null");
  assert.equal(back.status, "Reconnecting…");
  assert.equal(back.tone, "warn");
  const lost = callLine(state({ status: "needs-attention", error: "Choose which agent to call." }), "Null");
  assert.equal(lost.status, "Choose which agent to call.");
  assert.equal(lost.tone, "warn");
  assert.equal(callLine(state({ status: "needs-attention" }), "Null").status, "Needs you in the thread");
  const muted = callLine(state({ muted: true }), "Null");
  assert.equal(muted.status, "Muted · Null can still talk");
  assert.equal(muted.tone, "muted");
  assert.equal(muted.wave, "flat");
  // A muted call still shows the bot's voice moving while it talks.
  assert.equal(callLine(state({ muted: true, status: "speaking" }), "Null").wave, "bot");
});

test("the call timer reads m:ss, then h:mm:ss after an hour", () => {
  assert.equal(callClock(0), "0:00");
  assert.equal(callClock(-5000), "0:00");
  assert.equal(callClock(134_900), "2:14");
  assert.equal(callClock(3_600_000 + 65_000), "1:01:05");
});

test("voice ids read as a name and accent", async () => {
  const { voiceLabel } = await import("../src/voice/callView.ts");
  assert.equal(voiceLabel("am_michael"), "Michael · US");
  assert.equal(voiceLabel("bf_emma"), "Emma · UK");
  assert.equal(voiceLabel("custom"), "custom");
  assert.equal(voiceLabel("qx_odd"), "qx_odd");
});

test("composer button swaps mic and Send", async () => {
  const { composerButton } = await import("../src/voice/callView.ts");
  const b = (hasContent, canCall, live, look = "pill") => composerButton({ hasContent, canCall, live, look });
  assert.deepEqual(b(false, true, false), { mic: true, send: false });
  assert.deepEqual(b(true, true, false), { mic: false, send: true });
  assert.deepEqual(b(false, false, false), { mic: false, send: true });
  assert.deepEqual(b(true, false, false), { mic: false, send: true });
  assert.deepEqual(b(false, true, true, "pill"), { mic: true, send: false });
  assert.deepEqual(b(true, true, true, "pill"), { mic: true, send: true });
  for (const look of ["bar", "capsule"]) {
    assert.deepEqual(b(false, true, true, look), { mic: true, send: false });
    assert.deepEqual(b(true, true, true, look), { mic: false, send: true });
  }
});

test("Call who? names each agent's thread when the list spans threads", () => {
  const jigga = { hostId: "h", roomId: "pane-1", participantId: "j", name: "Jigga", roomTitle: "Voice calls" };
  const untitled = { ...jigga, roomId: "pane-2", roomTitle: "  " };
  const nul = { ...jigga, participantId: "n", name: "Null" };
  const kind = (c) => (c.name === "Null" ? "Codex" : "Claude");
  assert.deepEqual(pickRows([jigga, untitled], kind).map((r) => r.detail), ["Voice calls", "Untitled thread"]);
  assert.deepEqual(pickRows([jigga, nul], kind).map((r) => r.detail), ["Claude", "Codex"]);
  assert.equal(pickNote([untitled, jigga]), "Say “call Jigga in Voice calls” to pick one hands-free.");
  assert.equal(pickNote([jigga, nul]), "During a call, say “call Jigga” to switch.");
});

test("an uncertain thread choice labels even one candidate with its thread", () => {
  const jigga = { hostId: "h", roomId: "pane-1", name: "Jigga", roomTitle: "Voice calls" };
  assert.deepEqual(pickRows([jigga], () => "Claude", true).map((r) => r.detail), ["Voice calls"]);
  assert.deepEqual(pickRows([{ ...jigga, roomTitle: " " }], () => "Claude", true).map((r) => r.detail), ["Untitled thread"]);
  assert.equal(pickNote([jigga], true), "Say “call Jigga in Voice calls” to pick one hands-free.");
});
