import { test } from "node:test";
import assert from "node:assert/strict";
import { joinNames, replyingVerb, composerCopy, threadStatusOf } from "../src/composerStatus.ts";

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

const bots = [
  { id: "null", display_name: "Null" },
  { id: "jigga", display_name: "Jigga" },
  { id: "ada", display_name: "Ada" },
];

test("a thread reports who is replying and who is stopped on a card", () => {
  assert.deepEqual(threadStatusOf(bots, ["null", "jigga"], ["null"]), { text: "3 bots · replying", replying: ["Jigga"], waiting: ["Null"] });
  assert.deepEqual(threadStatusOf(bots, [], []), { text: "3 bots", replying: [], waiting: [] });
});

test("the head's words stay as they were", () => {
  assert.equal(threadStatusOf([], [], []).text, "No bots yet");
  assert.equal(threadStatusOf(bots.slice(0, 1), [], []).text, "1 bot");
  assert.equal(threadStatusOf(bots.slice(0, 1), ["null"], ["null"]).text, "1 bot · replying");
});

test("names follow the room's order, and bots no longer in the room are left out", () => {
  assert.deepEqual(threadStatusOf(bots, ["ada", "null", "gone"], ["gone"]), { text: "3 bots · replying", replying: ["Null", "Ada"], waiting: [] });
});
