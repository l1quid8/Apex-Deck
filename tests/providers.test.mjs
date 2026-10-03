import test from "node:test";
import assert from "node:assert/strict";
import { providerEnabled, providerForConfig } from "../src/providers.ts";

test("disabled CLI providers disappear from both terminal and chat selections", () => {
  const disabled = ["claude", "gemini", "aider"];
  assert.equal(providerEnabled("claude", disabled), false);
  assert.equal(providerEnabled("claude_code", disabled), false);
  assert.equal(providerEnabled("gemini", disabled), false);
  assert.equal(providerEnabled("codex", disabled), true);
});

test("provider choices survive a session round trip and can be re-enabled", () => {
  const session = JSON.parse(JSON.stringify({ disabledProviders: ["ollama", "api", "codex"] }));
  assert.equal(providerEnabled("ollama", session.disabledProviders), false);
  assert.equal(providerEnabled("api", session.disabledProviders), false);
  assert.equal(providerEnabled("codex", session.disabledProviders.filter((id) => id !== "codex")), true);
  assert.equal(providerEnabled("claude", []), true);
});

test("saved profiles use the same provider switches as new profiles", () => {
  const config = (backend) => ({ id: "bot", display_name: "Bot", backend, persona: "", access: "read", effort: null });
  assert.equal(providerEnabled(providerForConfig(config({kind:"agent",tool:"claude_code",model:null})), ["claude"]), false);
  assert.equal(providerForConfig(config({kind:"open_ai_compatible",base_url:"http://localhost:11434/v1/",model:"local",api_key_env:null})), "ollama");
  assert.equal(providerForConfig(config({kind:"open_ai_compatible",base_url:"https://example.com/v1",model:"hosted",api_key_env:null})), "api");
});
