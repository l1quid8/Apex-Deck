import { test } from "node:test";
import assert from "node:assert/strict";
import {
  readVoiceSettings,
  voicePreferenceKey,
  preferenceFor,
  validateVoice,
} from "../src/voice/settings.ts";
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
    preferences: {
      x: { voice: "am_michael", aliases: Array(25).fill("x".repeat(100)) },
    },
  });
  assert.equal(s.silenceMs, 700);
  assert.equal(s.preferences.x.aliases.length, 16);
  assert.equal(s.preferences.x.aliases[0].length, 64);
});
