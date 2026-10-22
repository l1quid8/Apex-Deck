import test from "node:test";
import assert from "node:assert/strict";
import { machineVoice } from "../src/phone/machineVoice.ts";
import { readVoiceSettings, voicePreferenceKey, preferenceFor } from "../src/voice/settings.ts";

const mac = readVoiceSettings({
  silenceMs: 700,
  look: "bar",
  preferences: { [voicePreferenceKey("local", "p1", "r1", "p1")]: { voice: "bf_emma", aliases: ["Nul"] } },
});

test("machine settings fill only what the phone left alone", () => {
  const phone = readVoiceSettings(undefined);
  const merged = machineVoice(phone, mac, { silence: false, look: false }, "mac-id");
  assert.equal(merged.silenceMs, 700);
  assert.equal(merged.look, "bar");
  assert.deepEqual(preferenceFor(merged, "mac-id", "p1", "r1", "p1"), { voice: "bf_emma", aliases: ["Nul"] });
  const own = machineVoice(
    readVoiceSettings({
      silenceMs: 100,
      look: "capsule",
      preferences: { [voicePreferenceKey("mac-id", "p1", "r1", "p1")]: { voice: "am_adam", aliases: [] } },
    }),
    mac,
    { silence: true, look: true },
    "mac-id",
  );
  assert.equal(own.silenceMs, 100);
  assert.equal(own.look, "capsule");
  assert.equal(preferenceFor(own, "mac-id", "p1", "r1", "p1").voice, "am_adam");
});

test("no machine settings leaves the phone's own", () => {
  const phone = readVoiceSettings({ silenceMs: 300 });
  assert.deepEqual(machineVoice(phone, null, { silence: false, look: false }, "h"), phone);
});
