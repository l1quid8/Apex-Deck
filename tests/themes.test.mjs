import test from "node:test";
import assert from "node:assert/strict";
import { BUILTIN_SKINS, DEFAULT_APPEARANCE, parseSkin, skinPrompt, themeMode, themeVariables } from "../src/themes.ts";

const validAppearance = { hue: 168, glow: 40, blur: 24, opacity: 76, radius: 18, backdrop: 35, density: 1, light: false, flat: false };
const skin = (appearance = validAppearance, extra = {}) => JSON.stringify({ format: "apex-glass-playground", version: 2, name: "Test", appearance, ...extra });

test("exports the seven v4 presets and the legacy-compatible default is Classic", () => {
  assert.deepEqual(BUILTIN_SKINS.map(({ id, name }) => [id, name]), [
    ["classic", "Classic"], ["smoked", "Smoked"], ["tide", "Tide"], ["dusk", "Dusk"], ["rose", "Rose"], ["frost", "Frost"], ["liquid", "Liquid"],
  ]);
  assert.deepEqual(DEFAULT_APPEARANCE, BUILTIN_SKINS[0].appearance);
  assert.equal(themeMode(DEFAULT_APPEARANCE), "classic");
  assert.deepEqual(themeVariables(DEFAULT_APPEARANCE), {});
});

test("theme variables are numeric CSS values and mode follows flat/light flags", () => {
  assert.deepEqual(themeVariables(validAppearance), {
    "--deck-hue": "168", "--deck-glow": "0.4", "--deck-blur": "24px", "--deck-opacity": "0.76",
    "--deck-radius": "18px", "--deck-backdrop": "0.35", "--deck-density": "1",
  });
  assert.equal(themeMode(validAppearance), "glass");
  assert.equal(themeMode({ ...validAppearance, flat: true }), "flat");
  assert.equal(themeMode({ ...validAppearance, light: true }), "glass");
});

test("v2 skin imports normalize names and values into the canonical v2 format", () => {
  const parsed = parseSkin(skin(validAppearance, { author: "Ada" }));
  assert.deepEqual(parsed, { format: "apex-glass-playground", version: 2, name: "Test", author: "Ada", appearance: validAppearance });
  assert.throws(() => parseSkin(skin(validAppearance, { name: "  " })));
});

test("v1 imports migrate missing backdrop to 50 and return v2", () => {
  const old = { ...validAppearance };
  delete old.backdrop;
  assert.deepEqual(parseSkin(JSON.stringify({ format: "apex-glass-playground", version: 1, name: "Old", appearance: old })), {
    format: "apex-glass-playground", version: 2, name: "Old", appearance: { ...validAppearance, backdrop: 50 },
  });
});

test("skin parser rejects unsupported keys, types, ranges, flags, versions, and oversized UTF-8", () => {
  const rejects = [
    skin(validAppearance, { css: "body{}" }),
    skin({ ...validAppearance, color: "red" }),
    skin({ ...validAppearance, hue: "168" }),
    skin({ ...validAppearance, hue: 361 }),
    skin({ ...validAppearance, opacity: 29 }),
    skin({ ...validAppearance, glow: Number.NaN }),
    skin({ ...validAppearance, density: 0.8 }),
    skin({ ...validAppearance, light: 1 }),
    JSON.stringify({ format: "apex-glass-playground", version: 3, name: "Test", appearance: validAppearance }),
    " ".repeat(32_001),
    "é".repeat(16_001),
  ];
  for (const input of rejects) assert.throws(() => parseSkin(input));
});

test("skin names are trimmed and capped at 40 characters", () => {
  const parsed = parseSkin(skin(validAppearance, { name: `  ${"x".repeat(50)}  ` }));
  assert.equal(parsed.name, "x".repeat(40));
});

test("AI prompt describes supported data and makes no generation claim", () => {
  const prompt = skinPrompt("a calm ocean palette");
  assert.match(prompt, /apex-glass-playground/);
  assert.match(prompt, /appearance/);
  assert.match(prompt, /hue.*glow.*blur.*opacity.*radius.*backdrop.*density.*light.*flat/s);
  assert.match(prompt, /calm ocean palette/);
  assert.doesNotMatch(prompt, /Deck generated|AI generated/i);
});
