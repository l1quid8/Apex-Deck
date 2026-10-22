import { test } from "node:test";
import assert from "node:assert/strict";
import {
  readVoiceSettings,
  voicePreferenceKey,
  preferenceFor,
  validateVoice,
  voiceFor,
  chatVoice,
  withChatPreference,
  CALL_VOICES,
} from "../src/voice/settings.ts";
import { machineVoice } from "../src/phone/machineVoice.ts";
test("default off; old files; stable keys distinguish hosts and thread overrides", () => {
  assert.equal(readVoiceSettings(undefined).enabled, false);
  assert.notEqual(voicePreferenceKey("a", "p"), voicePreferenceKey("b", "p"));
  const key = voicePreferenceKey("a", "p");
  const override = voicePreferenceKey("a", "p", "r", "b");
  const settings = readVoiceSettings({
    enabled: true,
    preferences: {
      [key]: { voice: "am_michael", aliases: ["bob"] },
      [override]: { voice: "bf_emma", aliases: [] },
    },
  });
  assert.equal(preferenceFor(settings, "a", "p", "r", "b").voice, "bf_emma");
  assert.equal(preferenceFor(settings, "a", "p", "x", "b").voice, "am_michael");
  assert.equal(validateVoice("missing", ["am_michael"]), false);
});
test("sanitize limits, ignore prototype keys and malformed values", () => {
  const s = readVoiceSettings({
    silenceMs: Infinity,
    defaultVoice: "Not A Voice",
    preferences: {
      x: { voice: "am_michael", aliases: Array(25).fill("x".repeat(100)) },
      y: { voice: 42, aliases: [] },
    },
  });
  assert.equal(s.silenceMs, 100);
  assert.equal(s.preferences.x.aliases.length, 16);
  assert.equal(s.preferences.x.aliases[0].length, 64);
  assert.equal("voice" in s.preferences.y, false, "a bad saved voice falls through instead of pinning Michael");
  assert.equal(s.defaultVoice, undefined);
});
test("voice order: this chat, then the agent's form, then Settings, then Michael", () => {
  const chat = voicePreferenceKey("h", "null", "room", "null");
  let s = readVoiceSettings({});
  assert.equal(voiceFor(s, "h", "null", "room", "null", null), "am_michael");
  s = readVoiceSettings({ defaultVoice: "af_heart" });
  assert.equal(voiceFor(s, "h", "null", "room", "null", undefined), "af_heart");
  assert.equal(voiceFor(s, "h", "null", "room", "null", "bm_george"), "bm_george");
  s = readVoiceSettings({ defaultVoice: "af_heart", preferences: { [chat]: { voice: "bf_emma", aliases: [] } } });
  assert.equal(voiceFor(s, "h", "null", "room", "null", "bm_george"), "bf_emma");
  assert.equal(voiceFor(s, "h", "null", "other", "null", "bm_george"), "bm_george", "a chat's pick stays in that chat");
});
test("nicknames saved in a call don't pin the voice; Default clears the chat's pick", () => {
  let s = readVoiceSettings({ defaultVoice: "af_heart" });
  s = withChatPreference(s, "h", "null", "room", "null", { aliases: ["nul"] });
  assert.equal(chatVoice(s, "h", "null", "room", "null"), "");
  assert.equal(voiceFor(s, "h", "null", "room", "null", "bm_george"), "bm_george");
  s = withChatPreference(s, "h", "null", "room", "null", { voice: "bf_emma" });
  assert.equal(voiceFor(s, "h", "null", "room", "null", "bm_george"), "bf_emma");
  assert.deepEqual(preferenceFor(s, "h", "null", "room", "null").aliases, ["nul"]);
  s = withChatPreference(s, "h", "null", "room", "null", { voice: "" });
  assert.equal(chatVoice(s, "h", "null", "room", "null"), "");
  assert.equal(voiceFor(s, "h", "null", "room", "null", "bm_george"), "bm_george");
  assert.deepEqual(preferenceFor(s, "h", "null", "room", "null").aliases, ["nul"]);
  // Saved and read back, the cleared pick stays cleared.
  assert.equal(chatVoice(readVoiceSettings(JSON.parse(JSON.stringify(s))), "h", "null", "room", "null"), "");
});
test("the picker list is the English voices the call helper offers", () => {
  assert.equal(CALL_VOICES.length, 28);
  assert.ok(CALL_VOICES.every((v) => /^[ab][fm]_[a-z]+$/.test(v)));
  assert.ok(CALL_VOICES.includes("am_michael"));
});
test("a phone follows its machine's default voice", () => {
  const phone = readVoiceSettings({});
  const machine = readVoiceSettings({ defaultVoice: "bf_lily" });
  const touched = { silence: false, look: false };
  assert.equal(machineVoice(phone, machine, touched, "mac").defaultVoice, "bf_lily");
  assert.equal(voiceFor(machineVoice(phone, machine, touched, "mac"), "mac", "null", "r", "null", null), "bf_lily");
});
