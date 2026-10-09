import test from "node:test";
import assert from "node:assert/strict";
import {
  BACKDROP_PATTERNS, DEFAULT_APPEARANCE, MAX_GLOWS, MIN_GLOWS,
  LEGACY_GLOWS, backdropLayers, backgroundPatch, glowColorList, parseSkin, readAppearance, shuffledGlowColors, skinPrompt, themeMode, themeVariables,
} from "../src/themes.ts";

const validAppearance = { hue: 168, glow: 40, blur: 24, opacity: 76, radius: 18, backdrop: 35, density: 1, light: false, flat: false };
const skin = (appearance = validAppearance, extra = {}) => JSON.stringify({ format: "apex-glass-playground", version: 2, name: "Test", appearance, ...extra });
const withAppearance = (fields) => parseSkin(skin({ ...validAppearance, ...fields })).appearance;

const HEX = /^#[0-9a-f]{6}$/;
const PATTERN_IDS = BACKDROP_PATTERNS.map(({ id }) => id);
const COUNT_PATTERNS = ["blobs", "aurora", "corners", "horizon"];
const fullFields = {
  backdropPattern: "stripes",
  glowColors: ["#AABBCC", "#112233", "#ff8800"],
  glowCount: 5,
  glowSize: 120,
};

// Small deterministic PRNG so shuffledGlowColors can be checked for repeatability.
function seeded(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- 1. parseSkin accepts and rejects the new fields ----

test("parseSkin keeps each new field and lowercases glowColors", () => {
  for (const { id } of BACKDROP_PATTERNS) {
    assert.equal(parseSkin(skin({ ...validAppearance, backdropPattern: id })).appearance.backdropPattern, id);
  }
  const parsed = parseSkin(skin({ ...validAppearance, ...fullFields }));
  assert.equal(parsed.appearance.backdropPattern, "stripes");
  assert.deepEqual(parsed.appearance.glowColors, ["#aabbcc", "#112233", "#ff8800"]);
  assert.equal(parsed.appearance.glowCount, 5);
  assert.equal(parsed.appearance.glowSize, 120);
});

test("parseSkin accepts glowColors at both ends of the 1-8 range and glowSize at both ends of 50-200", () => {
  assert.equal(parseSkin(skin({ ...validAppearance, glowColors: ["#123456"] })).appearance.glowColors.length, MIN_GLOWS);
  const eight = Array.from({ length: MAX_GLOWS }, (_, i) => `#${(i + 1).toString(16).padStart(6, "0")}`);
  assert.equal(parseSkin(skin({ ...validAppearance, glowColors: eight })).appearance.glowColors.length, MAX_GLOWS);
  assert.equal(withAppearance({ glowSize: 50 }).glowSize, 50);
  assert.equal(withAppearance({ glowSize: 200 }).glowSize, 200);
  assert.equal(withAppearance({ glowCount: 1 }).glowCount, 1);
  assert.equal(withAppearance({ glowCount: 8 }).glowCount, 8);
});

test("parseSkin rejects an unknown backdrop pattern", () => {
  for (const backdropPattern of ["waves", "Blobs", "", 3, null]) {
    assert.throws(() => parseSkin(skin({ ...validAppearance, backdropPattern })), undefined, `pattern ${JSON.stringify(backdropPattern)} should be rejected`);
  }
});

test("parseSkin rejects bad glowColors shapes and hex values", () => {
  const bad = [
    [],
    ["#1", "#2", "#3", "#4", "#5", "#6", "#7", "#8", "#9"],
    "#aabbcc",
    null,
    { 0: "#aabbcc" },
    ["#abc"],
    ["red"],
    ["#aabbcc", "#abc"],
    [123456],
    ["#aabbcc;display:none"],
  ];
  for (const glowColors of bad) {
    assert.throws(() => parseSkin(skin({ ...validAppearance, glowColors })), undefined, `glowColors ${JSON.stringify(glowColors)} should be rejected`);
  }
});

test("parseSkin rejects glowCount outside the whole-number 1-8 range", () => {
  for (const glowCount of [0, 9, 2.5, "3", null, Number.NaN]) {
    assert.throws(() => parseSkin(skin({ ...validAppearance, glowCount })), undefined, `glowCount ${String(glowCount)} should be rejected`);
  }
});

test("parseSkin rejects glowSize outside 50-200 or not a finite number", () => {
  for (const glowSize of [49, 201, "NaN", "100", Number.NaN, null]) {
    assert.throws(() => parseSkin(skin({ ...validAppearance, glowSize })), undefined, `glowSize ${String(glowSize)} should be rejected`);
  }
});

test("skins without the new fields parse unchanged and gain no new keys", () => {
  const parsed = parseSkin(skin(validAppearance));
  assert.deepEqual(parsed.appearance, validAppearance);
  for (const key of ["backdropPattern", "glowColors", "glowCount", "glowSize"]) {
    assert.equal(Object.hasOwn(parsed.appearance, key), false, `${key} should not be added`);
  }
});

// ---- 2. readAppearance round-trip ----

test("readAppearance round-trips current and saved skins that use all four fields", () => {
  const custom = parseSkin(skin({ ...validAppearance, ...fullFields }, { name: "Glows" }));
  const stored = readAppearance(JSON.parse(JSON.stringify({ current: custom, saved: [custom] })));
  assert.deepEqual(stored.current, custom);
  assert.deepEqual(stored.saved, [custom]);
  assert.deepEqual(stored.current.appearance.glowColors, ["#aabbcc", "#112233", "#ff8800"]);
  assert.equal(stored.current.appearance.backdropPattern, "stripes");
  assert.equal(stored.current.appearance.glowCount, 5);
  assert.equal(stored.current.appearance.glowSize, 120);
});

// ---- 3. glowColorList ----

test("glowColorList without glowColors returns 3 valid hex colors by default", () => {
  const colors = glowColorList(validAppearance);
  assert.equal(colors.length, 3);
  for (const color of colors) assert.match(color, HEX);
});

test("glowColorList honours glowCount N for every allowed count", () => {
  for (let n = MIN_GLOWS; n <= MAX_GLOWS; n++) {
    const colors = glowColorList({ ...validAppearance, glowCount: n });
    assert.equal(colors.length, n, `glowCount ${n}`);
    for (const color of colors) assert.match(color, HEX);
  }
});

test("glowColorList with glowColors returns an exact copy, not the same array", () => {
  const appearance = withAppearance({ glowColors: ["#aabbcc", "#112233"] });
  const colors = glowColorList(appearance);
  assert.deepEqual(colors, ["#aabbcc", "#112233"]);
  assert.notEqual(colors, appearance.glowColors);
  colors.push("#000000");
  assert.deepEqual(appearance.glowColors, ["#aabbcc", "#112233"]);
});

// ---- 4. shuffledGlowColors ----

test("shuffledGlowColors returns count valid hex colors in both modes", () => {
  for (const light of [false, true]) {
    for (let count = MIN_GLOWS; count <= MAX_GLOWS; count++) {
      const colors = shuffledGlowColors(count, light, seeded(count * 7 + (light ? 1 : 0)));
      assert.equal(colors.length, count);
      for (const color of colors) assert.match(color, HEX);
    }
  }
});

test("shuffledGlowColors is deterministic for the same seeded random function", () => {
  assert.deepEqual(shuffledGlowColors(5, false, seeded(42)), shuffledGlowColors(5, false, seeded(42)));
  assert.deepEqual(shuffledGlowColors(4, true, seeded(7)), shuffledGlowColors(4, true, seeded(7)));
});

// ---- 5. themeVariables ----

test("a skin with none of the four new fields keeps the stylesheet backdrop default", () => {
  const variables = themeVariables(validAppearance);
  assert.equal(Object.hasOwn(variables, "--deck-backdrop-image"), false);
  assert.equal(Object.hasOwn(variables, "--deck-backdrop-size"), false);
  assert.equal(Object.hasOwn(themeVariables(DEFAULT_APPEARANCE), "--deck-backdrop-image"), false);
});

test("a skin with any one of the four new fields emits backdrop image and size variables", () => {
  const cases = [
    { backdropPattern: "dots" },
    { glowColors: ["#aabbcc"] },
    { glowCount: 2 },
    { glowSize: 80 },
  ];
  for (const fields of cases) {
    const variables = themeVariables(withAppearance(fields));
    assert.equal(typeof variables["--deck-backdrop-image"], "string", JSON.stringify(fields));
    assert.notEqual(variables["--deck-backdrop-image"], "", JSON.stringify(fields));
    assert.equal(typeof variables["--deck-backdrop-size"], "string", JSON.stringify(fields));
  }
});

test("pattern none yields image none from themeVariables and backdropLayers", () => {
  const appearance = withAppearance({ backdropPattern: "none" });
  assert.equal(themeVariables(appearance)["--deck-backdrop-image"], "none");
  assert.equal(backdropLayers(appearance).image, "none");
});

// ---- 6. backdropLayers ----

test("every non-none pattern builds a non-empty gradient-only image", () => {
  for (const backdropPattern of PATTERN_IDS.filter((id) => id !== "none")) {
    for (const glowCount of [1, 3, 8]) {
      const { image, size } = backdropLayers(withAppearance({ backdropPattern, glowCount }));
      const label = `${backdropPattern} x${glowCount}`;
      assert.notEqual(image, "", label);
      assert.notEqual(image.trim(), "", label);
      assert.doesNotMatch(image, /url\(/, label);
      assert.doesNotMatch(image, /;/, label);
      assert.doesNotMatch(image, /[{}<]/, label);
      assert.doesNotMatch(image, /expression/i, label);
      assert.equal(typeof size, "string", label);
    }
  }
});

test("blobs, corners, aurora and horizon draw one radial gradient per glow", () => {
  for (const backdropPattern of COUNT_PATTERNS) {
    for (const glowCount of [1, 3, 8]) {
      const { image } = backdropLayers(withAppearance({ backdropPattern, glowCount }));
      const count = image.split("radial-gradient(").length - 1;
      assert.equal(count, glowCount, `${backdropPattern} with ${glowCount} glows`);
    }
  }
});

test("explicit glowColors set the glow count for blobs", () => {
  const { image } = backdropLayers(withAppearance({ backdropPattern: "blobs", glowColors: ["#aabbcc", "#112233"], glowCount: 8 }));
  assert.equal(image.split("radial-gradient(").length - 1, 2);
});

test("dots emits one size entry per layer", () => {
  for (const glowCount of [1, 3, 8]) {
    const { image, size } = backdropLayers(withAppearance({ backdropPattern: "dots", glowCount }));
    const layers = image.split("radial-gradient(").length - 1;
    assert.equal(layers, glowCount * 2, `dots with ${glowCount} glows`);
    assert.equal(size.split(", ").length, layers, `dots size entries with ${glowCount} glows`);
  }
});

test("glowSize scales spot sizes in backdropLayers", () => {
  const small = backdropLayers(withAppearance({ backdropPattern: "blobs", glowSize: 50 })).image;
  const large = backdropLayers(withAppearance({ backdropPattern: "blobs", glowSize: 200 })).image;
  assert.notEqual(small, large);
});

// ---- 7. themeMode ----

test("Classic plus a backdrop pattern is no longer classic", () => {
  assert.equal(themeMode({ ...DEFAULT_APPEARANCE, backdropPattern: "dots" }), "flat");
  assert.notEqual(themeMode({ ...DEFAULT_APPEARANCE, backdropPattern: "none" }), "classic");
  assert.notEqual(themeMode({ ...DEFAULT_APPEARANCE, glowCount: 3 }), "classic");
  assert.notEqual(themeMode({ ...DEFAULT_APPEARANCE, glowSize: 100 }), "classic");
});

// ---- 8. skinPrompt ----

test("skinPrompt mentions the new fields and every backdrop pattern id", () => {
  const prompt = skinPrompt("neon rain");
  for (const field of ["backdropPattern", "glowColors", "glowCount", "glowSize"]) {
    assert.match(prompt, new RegExp(field), field);
  }
  for (const id of PATTERN_IDS) {
    assert.ok(prompt.includes(id), `pattern id ${id} missing from prompt`);
  }
});

// ---- 9. Turning off Match accent must not move or recolor the original blobs ----

test("legacy glow lightness and chroma match the stylesheet's three blobs", async () => {
  const { readFile } = await import("node:fs/promises");
  const css = await readFile(new URL("../src/glass-theme.css", import.meta.url), "utf8");
  const block = (selector) => css.slice(css.indexOf(selector)).split("}")[0];
  const triples = (text) => [...text.matchAll(/at (\d+)% (\d+)%, oklch\(([\d.]+) ([\d.]+) .*?, transparent (\d+)%/g)]
    .map(([, x, y, L, C, stop]) => [Number(x), Number(y), Number(L), Number(C), Number(stop)]);
  const expect = (light) => LEGACY_GLOWS.map(({ at: [x, y], dark, light: pale, stop }) => [x, y, ...(light ? pale : dark), stop]);
  assert.deepEqual(triples(block(':root[data-deck-theme="glass"] {')), expect(false));
  assert.deepEqual(triples(block(':root[data-deck-light="true"][data-deck-theme="glass"] {')), expect(true));
});

test("custom blobs keep the stylesheet's ellipse geometry and stops", () => {
  const values = withAppearance({ glowColors: glowColorList(validAppearance) });
  const { image } = backdropLayers(values);
  const shapes = [...image.matchAll(/radial-gradient\(ellipse at (\d+)% (\d+)%, rgb\([^)]*\), transparent (\d+)%\)/g)].map(([, x, y, stop]) => [Number(x), Number(y), Number(stop)]);
  assert.deepEqual(shapes, LEGACY_GLOWS.map(({ at: [x, y], stop }) => [x, y, stop]));
});

// ---- 10. Background changes on Classic make the glow visible ----

test("backgroundPatch turns off Flat and lifts a zero Backdrop", () => {
  assert.deepEqual(backgroundPatch(DEFAULT_APPEARANCE, { backdropPattern: "aurora" }), { flat: false, backdrop: 50, backdropPattern: "aurora" });
  assert.deepEqual(backgroundPatch({ ...validAppearance, backdrop: 35 }, { glowSize: 80 }), { glowSize: 80 });
  assert.deepEqual(backgroundPatch({ ...validAppearance, flat: true }, { glowCount: 4 }), { flat: false, glowCount: 4 });
  assert.equal(themeMode({ ...DEFAULT_APPEARANCE, ...backgroundPatch(DEFAULT_APPEARANCE, { backdropPattern: "halo" }) }), "glass");
});

test("only Background controls turn glass on; tuning, density, Light and Flat use plain tune", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../src/AppearanceSettings.tsx", import.meta.url), "utf8");
  const tuneSection = source.slice(source.indexOf("SLIDERS.map("), source.indexOf("</section>", source.indexOf("SLIDERS.map(")));
  assert.ok(tuneSection.includes("density: 0.72") && tuneSection.includes("flat: event"), "tune section located");
  assert.ok(!tuneSection.includes("tuneBackground("), "tune section must not route through tuneBackground");
});

test("mesh lays its spots on an even 4 x 3 grid at every glow count", () => {
  for (const glowCount of [1, 3, 8]) {
    const { image } = backdropLayers(withAppearance({ backdropPattern: "mesh", glowCount }));
    const spots = [...image.matchAll(/at ([\d.]+)% ([\d.]+)%/g)].map(([, x, y]) => [+x, +y]);
    assert.equal(spots.length, 12);
    assert.deepEqual([...new Set(spots.map(([x]) => x))], [12.5, 37.5, 62.5, 87.5]);
    assert.deepEqual([...new Set(spots.map(([, y]) => y))], [16.67, 50, 83.33]);
  }
});

test("mesh uses every selected glow color at every count from 1 to 8", () => {
  const palette = ["#ff0000", "#00ff00", "#0000ff", "#ffff00", "#00ffff", "#ff00ff", "#884400", "#004488"];
  for (let glowCount = MIN_GLOWS; glowCount <= MAX_GLOWS; glowCount++) {
    const glowColors = palette.slice(0, glowCount);
    const base = backdropLayers(withAppearance({ backdropPattern: "mesh", glowCount, glowColors })).image;
    for (let i = 0; i < glowCount; i++) {
      const changed = glowColors.map((color, j) => (j === i ? "#123456" : color));
      const image = backdropLayers(withAppearance({ backdropPattern: "mesh", glowCount, glowColors: changed })).image;
      assert.notEqual(image, base, `glow ${i + 1} of ${glowCount} should change the mesh`);
    }
  }
});
