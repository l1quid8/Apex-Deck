import test from "node:test";
import assert from "node:assert/strict";
import { BUILTIN_SKINS, DEFAULT_APPEARANCE, parseSkin, skinPrompt, themeMode, themeVariables } from "../src/themes.ts";
import * as themes from "../src/themes.ts";

const validAppearance = { hue: 168, glow: 40, blur: 24, opacity: 76, radius: 18, backdrop: 35, density: 1, light: false, flat: false };
const skin = (appearance = validAppearance, extra = {}) => JSON.stringify({ format: "apex-glass-playground", version: 2, name: "Test", appearance, ...extra });

test("exports the nine presets and the legacy-compatible default is Classic", () => {
  assert.deepEqual(BUILTIN_SKINS.map(({ id, name }) => [id, name]), [
    ["classic", "Classic"], ["smoked", "Liquid Smoked"], ["tide", "Liquid Tide"], ["dusk", "Liquid Dusk"], ["rose", "Liquid Rose"], ["frost", "Liquid Frost"], ["liquid", "Liquid Full glass"], ["clay", "Clay Warm"], ["clay-black", "Clay Black"],
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

test("custom hex accent survives export/import and persisted current/saved skins", async () => {
  const { readAppearance } = await import("../src/themes.ts");
  const custom = parseSkin(skin({ ...validAppearance, accentColor: "#aB12Ef" }));
  assert.equal(custom.appearance.accentColor, "#ab12ef");
  assert.deepEqual(parseSkin(JSON.stringify(custom)), custom);
  const stored = readAppearance(JSON.parse(JSON.stringify({ current: custom, saved: [custom] })));
  assert.deepEqual(stored.current, custom);
  assert.deepEqual(stored.saved, [custom]);
  assert.equal(themeVariables(custom.appearance)["--deck-custom-accent"], "#ab12ef");
  assert.notEqual(themeMode({ ...DEFAULT_APPEARANCE, accentColor: "#ab12ef" }), "classic");
});

test("hex accent rejects CSS, names, alpha, and wrong types", () => {
  for (const accentColor of ["red", "#abc", "#12345678", "#123456;display:none", 123, null]) {
    assert.throws(() => parseSkin(skin({ ...validAppearance, accentColor })));
  }
});

test("color picker conversion preserves saturation and brightness, including neutrals", async () => {
  const { accentHex, colorAppearance } = await import("../src/themes.ts");
  assert.deepEqual(colorAppearance("#aBc"), { accentColor: "#aabbcc", hue: 210 });
  assert.equal(accentHex({ ...validAppearance, ...colorAppearance("#101010") }), "#101010");
  assert.equal(accentHex({ ...validAppearance, ...colorAppearance("#ffffff") }), "#ffffff");
  assert.equal(accentHex({ ...validAppearance, ...colorAppearance("#ff0000") }), "#ff0000");
  assert.throws(() => colorAppearance("#oops"));
  assert.match(accentHex(validAppearance), /^#[0-9a-f]{6}$/);
  assert.equal(themeVariables({ ...validAppearance, ...colorAppearance("#101010") })["--deck-custom-accent-ink"], "#ffffff");
  assert.equal(themeVariables({ ...validAppearance, ...colorAppearance("#ffffff") })["--deck-custom-accent-ink"], "#000000");
});

test('every built-in sits in its theme', () => {
  const byTheme = t => themes.BUILTIN_SKINS.filter(s => s.theme === t).map(s => s.preset);
  assert.deepEqual(byTheme('clay'), ['Warm', 'Black']);
  assert.deepEqual(byTheme('classic'), ['Standard']);
  assert.deepEqual(byTheme('liquid').sort(), ['Dusk', 'Frost', 'Full glass', 'Rose', 'Smoked', 'Tide']);
  for (const skin of themes.BUILTIN_SKINS) assert.equal(themes.themeFamily(skin.appearance), skin.theme);
});
test('Classic stays Classic after its corners change', () => {
  assert.equal(themes.themeFamily({ ...themes.DEFAULT_APPEARANCE, radius: 22 }), 'classic');
});
test('Liquid with solid panels stays Liquid', () => {
  const tide = themes.BUILTIN_SKINS.find(s => s.id === 'tide').appearance;
  assert.equal(themes.themeFamily({ ...tide, flat: true }), 'liquid');
});
test('new fields round-trip and bad ones are refused', () => {
  const file = v => JSON.stringify({ format: 'apex-glass-playground', version: 2, name: 'x', appearance: { ...themes.BUILTIN_SKINS[0].appearance, ...v } });
  assert.deepEqual(themes.parseSkin(file({ palette: 'black', reply: 'sans', edges: 'strong' })).appearance.palette, 'black');
  for (const bad of [{ palette: 'warm' }, { reply: 'mono' }, { edges: 'soft' }]) assert.throws(() => themes.parseSkin(file(bad)));
});
test('a reply font equal to the theme default is not stored', () => {
  const file = v => JSON.stringify({ format: 'apex-glass-playground', version: 2, name: 'x', appearance: { ...v } });
  const clay = themes.BUILTIN_SKINS.find(s => s.id === 'clay').appearance;
  assert.equal('reply' in themes.parseSkin(file({ ...clay, reply: 'serif' })).appearance, false);
  assert.equal(themes.parseSkin(file({ ...clay, reply: 'sans' })).appearance.reply, 'sans');
  assert.equal('reply' in themes.parseSkin(file({ ...themes.DEFAULT_APPEARANCE, reply: 'sans' })).appearance, false);
  assert.equal(themes.parseSkin(file({ ...themes.DEFAULT_APPEARANCE, reply: 'serif' })).appearance.reply, 'serif');
});
test('old settings keep their identity without being rewritten', () => {
  const clay = themes.BUILTIN_SKINS.find(s => s.id === 'clay');
  const old = { format: 'apex-glass-playground', version: 2, name: 'Clay', appearance: clay.appearance };
  assert.deepEqual(themes.deriveSource({ current: old, saved: [] }), { kind: 'builtin', id: 'clay' });
  const custom = { ...old, name: 'Custom', appearance: { ...clay.appearance, radius: 20 } };
  assert.deepEqual(themes.deriveSource({ current: custom, saved: [] }), { kind: 'builtin', id: 'clay' });
  assert.deepEqual(themes.deriveSource({ current: { ...custom, name: 'Mine' }, saved: [{ ...custom, name: 'Mine' }] }), { kind: 'saved', name: 'Mine' });
});
test('a stored source wins over matching, and a dangling one is ignored', () => {
  const clay = themes.BUILTIN_SKINS.find(s => s.id === 'clay');
  const current = { format: 'apex-glass-playground', version: 2, name: 'Clay Warm', appearance: clay.appearance };
  const mine = { ...current, name: 'Mine' };
  assert.deepEqual(themes.deriveSource({ current, saved: [mine], source: { kind: 'saved', name: 'Mine' } }), { kind: 'saved', name: 'Mine' });
  assert.deepEqual(themes.deriveSource({ current, saved: [], source: { kind: 'saved', name: 'Mine' } }), { kind: 'builtin', id: 'clay' });
  assert.deepEqual(themes.deriveSource({ current, saved: [], source: { kind: 'builtin', id: 'gone' } }), { kind: 'builtin', id: 'clay' });
});
test('readAppearance keeps a valid source and drops a bad one', () => {
  const mine = { format: 'apex-glass-playground', version: 2, name: 'Mine', appearance: { ...themes.DEFAULT_APPEARANCE } };
  const kept = themes.readAppearance({ current: mine, saved: [mine], source: { kind: 'saved', name: 'Mine' }, sourceBehind: true });
  assert.deepEqual(kept.source, { kind: 'saved', name: 'Mine' });
  assert.equal(kept.sourceBehind, true);
  const dropped = themes.readAppearance({ current: mine, saved: [], source: { kind: 'saved', name: 'Gone' }, sourceBehind: true });
  assert.equal('source' in dropped, false);
  assert.equal('sourceBehind' in dropped, false);
});
test('duplicate saved names become unique on read', () => {
  const skin = hue => ({ format: 'apex-glass-playground', version: 2, name: 'Same', appearance: { ...themes.DEFAULT_APPEARANCE, hue } });
  assert.deepEqual(themes.readAppearance({ current: skin(1), saved: [skin(1), skin(2)] }).saved.map(s => s.name), ['Same', 'Same 2']);
});
test('Light hint is not a difference between looks', () => {
  assert.ok(themes.sameLook({ ...themes.DEFAULT_APPEARANCE, light: true }, themes.DEFAULT_APPEARANCE));
  assert.ok(!themes.sameLook({ ...themes.DEFAULT_APPEARANCE, radius: 20 }, themes.DEFAULT_APPEARANCE));
});
test('applyAppearance paints the new fields and clears them', () => {
  const root = { dataset: {}, style: { setProperty() {}, removeProperty() {} } };
  const stop = themes.applyAppearance(root, { ...themes.BUILTIN_SKINS.find(s => s.id === 'clay-black').appearance, reply: 'sans', edges: 'strong' });
  assert.equal(root.dataset.deckPalette, 'black');
  assert.equal(root.dataset.deckReply, 'sans');
  assert.equal(root.dataset.deckEdges, 'strong');
  stop();
  assert.deepEqual(root.dataset, {});
});
test('the prompt describes the new optional fields', () => {
  for (const word of ['palette', 'reply', 'edges']) assert.match(themes.skinPrompt('x'), new RegExp(word));
});
