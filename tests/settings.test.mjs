import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SETTINGS, readSettings, keyNamesIn, keyNameFor } from "../src/settings.ts";
import { BUILTIN_SKINS, DEFAULT_APPEARANCE } from "../src/themes.ts";

test("no settings file gives the defaults", () => {
  assert.deepEqual(readSettings(null), DEFAULT_SETTINGS);
  assert.deepEqual(readSettings("broken"), DEFAULT_SETTINGS);
});

test("saved values are kept", () => {
  const saved = { version: 1, disabledProviders: ["grok"], newThread: { policy: "round_robin", max_bot_hops: 5 }, newBotAccess: "ask", terminal: { fontSize: 15, scrollback: 10000 }, preview: { openExternally: ["github.com"] }, confirmSteer: false, botChips: { tool: false, effort: true, usage: false } };
  assert.deepEqual(readSettings(saved), saved);
});

test("values that make no sense fall back one by one", () => {
  const read = readSettings({ disabledProviders: ["codex", 4], newThread: { policy: "loudest", max_bot_hops: 99 }, newBotAccess: "root", terminal: { fontSize: 3, scrollback: 123 } });
  assert.deepEqual(read.disabledProviders, ["codex"]);
  assert.equal(read.newThread.policy, "mention");
  assert.equal(read.newThread.max_bot_hops, 10);
  assert.equal(read.newBotAccess, "read");
  assert.equal(read.terminal.fontSize, 10);
  assert.equal(read.terminal.scrollback, 5000);
});

test("the provider list older versions kept in the session file is carried over once", () => {
  assert.deepEqual(readSettings(null, ["aider"]).disabledProviders, ["aider"]);
  // A settings file, once saved, wins over the old copy.
  assert.deepEqual(readSettings({ disabledProviders: [] }, ["aider"]).disabledProviders, []);
});

test("key names are collected from saved agents, once each and sorted", () => {
  const api = (env) => ({ backend: { kind: "open_ai_compatible", base_url: "", model: "", api_key_env: env } });
  const names = keyNamesIn([api("OPENROUTER_API_KEY"), api("ANTHROPIC_API_KEY"), api("OPENROUTER_API_KEY"), api(null), api("  "), { backend: { kind: "scripted" } }]);
  assert.deepEqual(names, [{ name: "ANTHROPIC_API_KEY", uses: 1 }, { name: "OPENROUTER_API_KEY", uses: 2 }]);
});

test("hosts to open in the browser are kept lower case, once each", () => {
  assert.deepEqual(readSettings({ preview: { openExternally: ["GitHub.com", "github.com", 4, " "] } }).preview.openExternally, ["github.com"]);
  assert.deepEqual(readSettings({ preview: "broken" }).preview.openExternally, []);
});

test("decision settings default off and reject unsupported providers", () => {
  const read = readSettings({ decision: { enabled: true, provider: "evil", accountId: 4, apiKey: "must not persist" } });
  assert.deepEqual(read.decision, { enabled: false, provider: "jev", accountId: "" });
  assert.deepEqual(readSettings({ decision: { enabled: true, provider: "openrouter", accountId: "" } }).decision, { enabled: true, provider: "openrouter", accountId: "" });
});

test("bot chips show everything until a part is turned off", () => {
  assert.deepEqual(DEFAULT_SETTINGS.botChips, { tool: true, effort: true, usage: true });
  assert.deepEqual(readSettings({ botChips: { tool: false } }).botChips, { tool: false, effort: true, usage: true });
  assert.deepEqual(readSettings({ botChips: { tool: "no", usage: 0 } }).botChips, { tool: true, effort: true, usage: true }, "only true or false count");
});

test("a provider's key name comes from its address", () => {
  assert.equal(keyNameFor("https://api.venice.ai/api/v1"), "VENICE_API_KEY");
  assert.equal(keyNameFor("https://openrouter.ai/api/v1"), "OPENROUTER_API_KEY");
  assert.equal(keyNameFor("https://api.openai.com/v1"), "OPENAI_API_KEY");
  assert.equal(keyNameFor("https://api.x.ai/v1"), "XAI_API_KEY");
  assert.equal(keyNameFor("https://api.together-ai.com/v1"), "TOGETHER_AI_API_KEY");
  for (const local of ["http://localhost:11434/v1", "http://127.0.0.1:1234/v1", "http://[::1]:8080", "http://box.local/v1", "", "not a url"]) assert.equal(keyNameFor(local), "", local);
});

const userSkin = { format: "apex-glass-playground", version: 2, name: "Saved tide", appearance: { ...BUILTIN_SKINS[2].appearance } };
const savedAppearance = { current: userSkin, saved: [userSkin] };

test("defaults keep the pre-appearance settings shape and appearance is opt-in", () => {
  assert.equal("appearance" in DEFAULT_SETTINGS, false);
  assert.deepEqual(readSettings(null), DEFAULT_SETTINGS);
  assert.deepEqual(readSettings({ ...DEFAULT_SETTINGS, appearance: savedAppearance }).appearance, savedAppearance);
});

test("invalid current appearance falls back while valid saved skins are salvaged", () => {
  const read = readSettings({ appearance: { current: { ...userSkin, appearance: { ...userSkin.appearance, hue: 900 } }, saved: [userSkin, null, { ...userSkin, appearance: { ...userSkin.appearance, flat: "yes" } }] } });
  assert.deepEqual(read.appearance, { current: { format: "apex-glass-playground", version: 2, name: "Classic", appearance: DEFAULT_APPEARANCE }, saved: [userSkin] });
});

test("saved skin gallery is capped at 50 valid normalized skins", () => {
  const skins = Array.from({ length: 55 }, (_, i) => ({ ...userSkin, name: `Skin ${i}` }));
  const read = readSettings({ appearance: { current: userSkin, saved: skins } });
  assert.equal(read.appearance.saved.length, 50);
  assert.equal(read.appearance.saved[0].name, "Skin 0");
  assert.equal(read.appearance.saved.at(-1).name, "Skin 49");
});

test("malformed appearance containers are ignored without changing other settings", () => {
  for (const appearance of [null, "bad", [], { current: "bad", saved: "bad" }]) {
    const read = readSettings({ confirmSteer: false, appearance });
    assert.equal(read.confirmSteer, false);
    if (appearance && appearance.current === "bad") assert.deepEqual(read.appearance.current.appearance, DEFAULT_APPEARANCE);
    else assert.equal("appearance" in read, false);
  }
});
