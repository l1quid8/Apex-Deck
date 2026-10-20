import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { BUILTIN_SKINS, CLAY_ACCENT_PRESETS, DEFAULT_APPEARANCE, accentHex, parseSkin, readAppearance, skinPrompt, themeMode, themeVariables } from "../src/themes.ts";
import { DEFAULT_LANDING_TEXTURE, effectiveLandingTexture } from "../src/settings.ts";
import { AGENT_COLORS } from "../src/identicon.ts";

const claySkin = BUILTIN_SKINS.find((skin) => skin.id === "clay");
const clay = claySkin.appearance;
const asFile = (appearance, name = "Clay") => JSON.stringify({ format: "apex-glass-playground", version: 2, name, appearance });

test("Clay is an additive builtin; Classic and the default are untouched", () => {
  assert.equal(clay.theme, "clay");
  assert.equal(themeMode(clay), "clay");
  assert.equal(themeMode(DEFAULT_APPEARANCE), "classic");
  assert.deepEqual(DEFAULT_APPEARANCE, BUILTIN_SKINS[0].appearance);
  assert.deepEqual(CLAY_ACCENT_PRESETS.map(({ id, hue }) => [id, hue]), [["terracotta", 38], ["sage", 152], ["slate", 252]]);
});

test("themeMode puts Clay first in both modes, whatever flat says", () => {
  assert.equal(themeMode({ ...clay, light: true }), "clay");
  assert.equal(themeMode({ ...clay, flat: false }), "clay");
  assert.equal(themeMode({ ...DEFAULT_APPEARANCE, theme: "clay" }), "clay");
});

test("legacy skins without theme still parse; only \"clay\" is accepted", () => {
  const legacy = { hue: 168, glow: 40, blur: 24, opacity: 76, radius: 18, backdrop: 35, density: 1, light: false, flat: false };
  assert.equal(parseSkin(asFile(legacy, "Old")).appearance.theme, undefined);
  assert.equal(parseSkin(asFile(clay)).appearance.theme, "clay");
  for (const theme of ["glass", "Clay", "", 1, true, null]) {
    assert.throws(() => parseSkin(asFile({ ...legacy, theme }, "Bad")), /Theme must be "clay"/);
  }
});

test("Clay survives export/import and persisted current/saved skins, key order included", () => {
  const parsed = parseSkin(asFile(clay));
  assert.deepEqual(parsed.appearance, clay);
  // The gallery highlights by JSON string equality, so order must survive.
  assert.equal(JSON.stringify(parsed.appearance), JSON.stringify(clay));
  assert.deepEqual(parseSkin(JSON.stringify(parsed)), parsed);
  const stored = readAppearance(JSON.parse(JSON.stringify({ current: parsed, saved: [parsed] })));
  assert.deepEqual(stored.current, parsed);
  assert.deepEqual(stored.saved, [parsed]);
});

test("Clay variables are the short solid list; glass values never reach inline style", () => {
  assert.deepEqual(themeVariables(clay), {
    "--deck-hue": "38", "--deck-radius": "10px", "--deck-density": "1",
  });
  const custom = themeVariables({ ...clay, accentColor: "#b1552f", density: 0.72, radius: 20 });
  assert.equal(custom["--deck-custom-accent"], "#b1552f");
  assert.equal(custom["--deck-density"], "0.72");
  assert.equal(custom["--deck-radius"], "20px");
  for (const key of ["--deck-glow", "--deck-blur", "--deck-opacity", "--deck-backdrop", "--deck-backdrop-image"]) {
    assert.equal(custom[key], undefined, key);
  }
});

test("accentHex mirrors the Clay stylesheet per mode and the prompt names the field", () => {
  assert.match(accentHex(clay), /^#[0-9a-f]{6}$/);
  assert.notEqual(accentHex(clay), accentHex({ ...clay, light: true }));
  assert.equal(accentHex({ ...clay, accentColor: "#123456" }), "#123456");
  assert.match(skinPrompt("warm"), /theme \(optional, exactly "clay"/);
});

test("under Clay a default one-color field follows the accent; picked colors never move", () => {
  const single = { ...DEFAULT_LANDING_TEXTURE, mode: "single" };
  assert.equal(effectiveLandingTexture(single, clay).color, accentHex(clay));
  assert.equal(effectiveLandingTexture(single, { ...clay, light: true }).color, accentHex({ ...clay, light: true }));
  const picked = { ...single, color: "#123456" };
  assert.equal(effectiveLandingTexture(picked, clay), picked);
  assert.equal(effectiveLandingTexture(DEFAULT_LANDING_TEXTURE, clay), DEFAULT_LANDING_TEXTURE);
  assert.equal(effectiveLandingTexture(single, DEFAULT_APPEARANCE), single);
});

const hexToRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const luminance = (hex) => {
  const [r, g, b] = hexToRgb(hex).map((v) => { const s = v / 255; return s <= .04045 ? s / 12.92 : ((s + .055) / 1.055) ** 2.4; });
  return .2126 * r + .7152 * g + .0722 * b;
};
const ratio = (a, b) => { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); };
const mix = (agent, text, p) => "#" + hexToRgb(agent).map((v, i) => Math.round(v * p + hexToRgb(text)[i] * (1 - p)).toString(16).padStart(2, "0")).join("");

// The token values clay-theme.css must carry. Panel/raised expand the RGB
// triplets so contrast can be checked as solid colors.
const MODES = {
  ember: { light: false, ink: "#2a1e16", bg: "#262421", panel: "#1e1c1a", raised: "#302d29", code: "#1b1917", selected: "#3a3630", human: "#38332d", text: "#efe9e0", muted: "#c2b9ad", muted2: "#ada294", warn: "#e6b562", danger: "#f0907f", success: "#9dc79b", edge: "#544e46", line: "#3b3732" },
  paper: { light: true, ink: "#fffaf3", bg: "#f8f5ee", panel: "#f0ece3", raised: "#fffdf9", code: "#f0ebe1", selected: "#e5dfd2", human: "#ebe4d7", text: "#29251f", muted: "#58514a", muted2: "#6a6258", warn: "#865800", danger: "#ad3626", success: "#356b3a", edge: "#c9c0b1", line: "#e1dacd" },
};

test("every Clay text pair passes WCAG AA, accents included", () => {
  const css = readFileSync(new URL("../src/clay-theme.css", import.meta.url), "utf8");
  for (const [name, mode] of Object.entries(MODES)) {
    for (const [key, value] of Object.entries(mode)) {
      // Panel/raised ship as RGB triplets, everything else as hex.
      if (key === "panel" || key === "raised") continue;
      if (typeof value === "string") assert.ok(css.includes(value), `${name} ${key} ${value} missing from clay-theme.css`);
    }
    const triplet = (hex) => hexToRgb(hex).join(" ");
    assert.ok(css.includes(`--deck-panel: ${triplet(mode.panel)}`), `${name} panel triplet missing`);
    assert.ok(css.includes(`--deck-panel-raised: ${triplet(mode.raised)}`), `${name} raised triplet missing`);
    const surfaces = [mode.bg, mode.panel, mode.raised, mode.code, mode.selected, mode.human];
    for (const fg of [mode.text, mode.muted, mode.muted2]) {
      for (const bg of surfaces) assert.ok(ratio(fg, bg) >= 4.5, `${name} ${fg} on ${bg}: ${ratio(fg, bg).toFixed(2)}`);
    }
    for (const fg of [mode.warn, mode.danger, mode.success]) {
      for (const bg of [mode.bg, mode.raised, mode.code]) assert.ok(ratio(fg, bg) >= 4.5, `${name} status ${fg} on ${bg}: ${ratio(fg, bg).toFixed(2)}`);
    }
    for (const { hue } of CLAY_ACCENT_PRESETS) {
      const accent = accentHex({ ...clay, hue, light: mode.light });
      for (const bg of surfaces) assert.ok(ratio(accent, bg) >= 4.5, `${name} hue ${hue} accent ${accent} on ${bg}: ${ratio(accent, bg).toFixed(2)}`);
      assert.ok(ratio(mode.ink, accent) >= 4.5, `${name} hue ${hue} ink on accent: ${ratio(mode.ink, accent).toFixed(2)}`);
    }
  }
  // Paper diff inks are deeper than the status colors.
  assert.ok(ratio("#14532d", MODES.paper.code) >= 4.5);
  assert.ok(ratio("#7f1d1d", MODES.paper.code) >= 4.5);
});

test("muted speaker names keep every built-in agent color readable in both modes", () => {
  // The color-mix declarations are the fallback for engines without
  // relative oklch; the built-in palette must pass on those alone.
  for (const color of AGENT_COLORS) {
    assert.ok(ratio(mix(color, MODES.ember.text, .8), MODES.ember.bg) >= 4.5, `ember ${color}`);
    assert.ok(ratio(mix(color, MODES.ember.text, .8), MODES.ember.raised) >= 4.5, `ember raised ${color}`);
    assert.ok(ratio(mix(color, MODES.paper.text, .38), MODES.paper.bg) >= 4.5, `paper ${color}`);
    assert.ok(ratio(mix(color, MODES.paper.text, .38), MODES.paper.raised) >= 4.5, `paper raised ${color}`);
  }
});

test("agent names everywhere read --agent-color, and Clay clamps picked colors into range", () => {
  const chat = readFileSync(new URL("../src/ChatPane.tsx", import.meta.url), "utf8");
  const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  const clayCss = readFileSync(new URL("../src/clay-theme.css", import.meta.url), "utf8");
  const phoneCss = readFileSync(new URL("../src/phone/phone-themes.css", import.meta.url), "utf8");
  // Details ("Bots" cards and Always allowed) names were the last inline
  // text colors; inline color would bypass Clay's muting entirely.
  assert.doesNotMatch(chat, /<strong style=\{\{ color:/);
  assert.ok(chat.split('"--agent-color": color(').length >= 5, "bubbles and details names carry --agent-color");
  assert.match(styles, /\.details-bot-copy strong \{[^}]*color: var\(--agent-color/);
  assert.match(styles, /\.allowed-copy strong \{[^}]*color: var\(--agent-color/);
  // Where relative oklch is supported, lightness is clamped per mode, so
  // even an arbitrary user-picked color (black, white, the background
  // itself) stays readable; the mixes above remain as the fallback.
  for (const css of [clayCss, phoneCss]) {
    assert.ok(css.includes("oklch(from var(--agent-color, var(--accent)) clamp(.76, l, .92) clamp(0, c, .13) h)"), "ember clamp");
    assert.ok(css.includes("oklch(from var(--agent-color, var(--accent)) clamp(.28, l, .44) clamp(0, c, .13) h)"), "paper clamp");
  }
  assert.match(clayCss, /\.details-bot-copy strong/);
  assert.match(clayCss, /\.allowed-copy strong/);
  // The same move covers the Changes group headings and the question
  // form's "X asks" line, the other places a name takes the agent color.
  const diffPanel = readFileSync(new URL("../src/DiffPanel.tsx", import.meta.url), "utf8");
  const questionForm = readFileSync(new URL("../src/QuestionForm.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(diffPanel, /\{ color: colorOf\(/);
  assert.doesNotMatch(questionForm, /\{ color: props\.colorOf\(/);
  assert.match(styles, /\.diff-group h4 \{[^}]*color: var\(--agent-color/);
  assert.match(styles, /\.qform-who \{[^}]*color: var\(--agent-color/);
  assert.match(clayCss, /\.diff-group h4/);
  assert.match(clayCss, /\.qform-who/);
});

test("Clay stays scoped and approvals keep the shared amber treatment", () => {
  const clayCss = readFileSync(new URL("../src/clay-theme.css", import.meta.url), "utf8");
  const glassCss = readFileSync(new URL("../src/glass-theme.css", import.meta.url), "utf8");
  assert.match(clayCss, /data-deck-theme="clay"/);
  assert.match(clayCss, /--deck-font-reading/);
  assert.match(clayCss, /\.bubble\.bot \{[^}]*background: transparent/);
  // Serif is scoped to the reply body itself (a direct child), so the
  // Markdown inside a plan approval card keeps the safety treatment.
  assert.match(clayCss, /\.bubble\.bot > :is\(\.md, \.draft-text\) \{[^}]*--deck-font-reading/);
  assert.doesNotMatch(clayCss, /\.bubble\.bot \{[^}]*font-family/);
  assert.doesNotMatch(clayCss, /\.approval/);
  // The speaker moved from an inline color to --agent-color; under Glass a
  // shared muted-text rule must not outrank the speaker's own color rule
  // (the inline style used to win that cascade by default).
  assert.ok(!glassCss.includes(":is(.speaker, .muted"), "glass muted list must not swallow the speaker color");
  assert.match(glassCss, /\[data-deck-theme="glass"\] \.speaker \{ color: var\(--agent-color/);
  assert.match(glassCss, /data-deck-theme="clay"\] \.approval \{/);
  assert.match(glassCss, /data-deck-theme="clay"\] \.approval-actions button\[data-answer="deny"\]/);
  const main = readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8");
  const phone = readFileSync(new URL("../src/phone/main.tsx", import.meta.url), "utf8");
  assert.match(main, /clay-theme\.css/);
  assert.match(phone, /clay-theme\.css/);
});

test("Clay replaces the base stylesheet's fixed dark and mint colors", () => {
  const css = readFileSync(new URL("../src/clay-theme.css", import.meta.url), "utf8");
  const rule = (selector) => {
    const at = css.indexOf(selector);
    assert.ok(at >= 0, `missing Clay rule for ${selector}`);
    return css.slice(at, css.indexOf("}", at));
  };
  // Base hover is navy #1b2834 and primary hover is mint #91efc8.
  assert.match(rule(':where(:root[data-deck-theme="clay"]) button:hover:not(:disabled)'), /background-color:\s*color-mix/);
  assert.match(rule(':root[data-deck-theme="clay"] button.primary:hover:not(:disabled)'), /background:\s*color-mix\(in srgb, var\(--accent\)/);
  // Agent picker tiles are fixed dark green in the base sheet.
  assert.match(rule(':where(:root[data-deck-theme="clay"]) .picker-grid.single button {'), /var\(--accent\)/);
  // Pastel +/− counts and server errors are unreadable on Paper.
  assert.match(rule(':root[data-deck-theme="clay"] {'), /--plus:\s*var\(--deck-success\)/);
  assert.match(rule(':root[data-deck-theme="clay"] :is(.plus, .minus, .server-error)'), /var\(--/);
  assert.match(rule(':root[data-deck-light="true"][data-deck-theme="clay"] :is(.details-backdrop, .artifacts-backdrop)'), /background/);
});

test("Clay reshapes the layout toward the mock, scoped and CSS-only", () => {
  const css = readFileSync(new URL("../src/clay-theme.css", import.meta.url), "utf8");
  const rule = (selector) => {
    const at = css.indexOf(selector + " {");
    assert.ok(at >= 0, `missing Clay rule for ${selector}`);
    return css.slice(at, css.indexOf("}", at));
  };
  const clay = ':root[data-deck-theme="clay"]';
  // Flush shell: no gutter frame, rail and Details split by hairlines.
  assert.match(css, /:root\[data-deck-theme="clay"\] \{ --deck-gap: 0px; \}/);
  // The grid's -4px margin assumes an 8px gutter; with none it reaches 4px
  // past the window, so the canvas clips it (clip, not hidden: no scroller).
  assert.match(rule(`${clay} .canvas`), /overflow: clip/);
  assert.match(rule(`${clay} .rail`), /border-right: 1px solid var\(--line\)/);
  assert.match(rule(`${clay} .pane`), /border: 0/);
  // Classic's mint focused-pane border and cyan status color don't reach Clay.
  assert.match(css, /--brand-cyan: var\(--deck-success\)/);
  assert.match(rule(`${clay} .pane.focused`), /box-shadow: none/);
  // One centered column for the transcript and the composer.
  assert.match(rule(`${clay} .transcript`), /padding-inline: max\(24px, calc\(\(100% - var\(--deck-message-width\)\) \/ 2\)\)/);
  assert.match(rule(`${clay} .composer`), /padding-inline: max\(16px, calc\(\(100% - var\(--deck-message-width\)\) \/ 2\)\)/);
  // Senders inline: the reply takes the whole column, the avatar is placed over the name line.
  assert.match(rule(`${clay} .bot-row`), /grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(rule(`${clay} .bot-row > .identicon`), /position: absolute/);
  // In that grid a start-aligned reply is at least as wide as its longest
  // unbroken line, and step rows never wrap, so a long command pushed the
  // reply past the column and the thread scrolled sideways. It's clamped.
  assert.match(rule(`${clay} .bot-row > .bubble`), /max-width: 100%/);
  // Two-row composer: text first, tools below.
  assert.match(rule(`${clay} .composer-box > .composer-field`), /order: -1; flex-basis: 100%/);
  // Sentence-case labels instead of uppercase tracking.
  for (const label of [".rail-sec", ".eyebrow", ".right-dashboard-group"]) assert.match(rule(`${clay} ${label}`), /text-transform: none/);
  // Every structural selector stays behind the Clay attribute.
  const structure = css.slice(css.indexOf("── Structure"));
  for (const [, selector] of structure.matchAll(/^([^\s/*@}][^{]*)\{/gm)) {
    assert.match(selector, /data-deck-theme="clay"/, `unscoped selector: ${selector.trim()}`);
  }
});
