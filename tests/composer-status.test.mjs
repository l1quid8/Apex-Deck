import { test } from "node:test";
import assert from "node:assert/strict";
import { joinNames, replyingVerb, composerCopy } from "../src/composerStatus.ts";

test("names join the way a sentence would", () => {
  assert.equal(joinNames([]), "");
  assert.equal(joinNames(["Opus"]), "Opus");
  assert.equal(joinNames(["Opus", "Codex"]), "Opus and Codex");
  assert.equal(joinNames(["Opus", "Codex", "Gemini"]), "Opus, Codex and Gemini");
});

test("the verb agrees with the count", () => {
  assert.equal(replyingVerb(1), "is replying");
  assert.equal(replyingVerb(2), "are replying");
});

test("placeholder and hint say what Enter does", () => {
  assert.match(composerCopy(true, false).hint, /↵ queue/);
  assert.match(composerCopy(true, false).placeholder, /steer/);
  assert.match(composerCopy(false, false).hint, /↵ send/);
  assert.equal(composerCopy(false, true).placeholder, "Add a model to start");
});
