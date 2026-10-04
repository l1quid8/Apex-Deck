import { test } from "node:test";
import assert from "node:assert/strict";
import { composerCopy, doingNow, elapsed, headLine, heardFrom, isCommandLine, joinNames, quietLine, replyingVerb, statusParts, stopLabel, stopTargets, threadStatusOf, waitingVerb, workingFor } from "../src/composerStatus.ts";

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

const bot = (name, doing, startedAt = 0, heardAt = null) => ({ name, doing, startedAt, heardAt });

test("one bot at work: its name, its step and how long", () => {
  assert.equal(headLine(2, [bot("Null", "Running: npm test", 0, 60_000)], 72_000), "Null · Running: npm test · 1m 12s");
  assert.equal(headLine(1, [bot("Null", "Thinking")], 8_000), "Null · Thinking · 8s");
});

test("two or more at work: how many, and what one of them is doing", () => {
  assert.equal(headLine(3, [bot("Null", "Editing src/App.tsx"), bot("Jigga", "Thinking")], 5_000), "2 replying · Null: Editing src/App.tsx");
});

test("nobody at work: how many bots", () => {
  assert.equal(headLine(0, [], 0), "No bots yet");
  assert.equal(headLine(1, [], 0), "1 bot");
  assert.equal(headLine(2, [], 0), "2 bots");
});

test("a command-line bot silent for 5 minutes reads as quiet, with the cutoff", () => {
  assert.equal(quietLine(0, 5 * 60_000 - 1), null);
  assert.equal(quietLine(0, 5 * 60_000), "Quiet 5m · stops at 15m");
  assert.equal(quietLine(0, 6 * 60_000 + 59_000), "Quiet 6m · stops at 15m");
  assert.equal(quietLine(null, 60 * 60_000), null, "API bots have no silence limit");
  assert.equal(headLine(1, [bot("Null", "Running: sleep 600", 0, 0)], 6 * 60_000), "Null · Quiet 6m · stops at 15m");
  assert.equal(headLine(2, [bot("Null", "Reading a.ts", 0, 6 * 60_000), bot("Jigga", "Running: sleep 600", 0, 0)], 6 * 60_000), "2 replying · Jigga: Quiet 6m · stops at 15m", "the quiet one is named");
});

test("only command-line bots have the silence limit", () => {
  assert.equal(isCommandLine({ kind: "agent", tool: "codex", model: null }), true);
  assert.equal(isCommandLine({ kind: "cli", program: "mytool", args: [] }), true);
  assert.equal(isCommandLine({ kind: "open_ai_compatible", base_url: "http://localhost:11434/v1", model: "llama3", api_key_env: null }), false);
  assert.equal(isCommandLine({ kind: "scripted", lines: [] }), false);
});

test("an answered card's step doesn't linger, and waiting on a card isn't silence", () => {
  assert.equal(doingNow({ phase: "tool", steps: ["Reading a.ts", "Waiting for approval: Run a command"] }), "Working");
  assert.equal(doingNow({ phase: "tool", steps: ["Running: npm test"] }), "Running: npm test");
  assert.equal(doingNow({ phase: "writing", steps: ["Running: npm test"] }), "Writing");
  assert.equal(doingNow({ phase: "thinking", steps: [] }), "Thinking");
  assert.equal(heardFrom({ type: "approval_resolved", id: "null", request: "ask-1", approved: true }), "null", "an answer starts the clock again");
  assert.equal(heardFrom({ type: "approval_requested", id: "null", request: "ask-1", action: { kind: "command", title: "Run a command", detail: "ls" } }), null);
  assert.equal(heardFrom({ type: "delta", id: "null", text: "hi" }), "null");
  assert.equal(heardFrom({ type: "activity", id: "null", text: "Reading a.ts" }), "null");
  assert.equal(heardFrom({ type: "turn_started", id: "null" }), "null");
  assert.equal(heardFrom({ type: "usage", id: "null", input_tokens: 1, output_tokens: 1 }), null);
  assert.equal(heardFrom({ type: "editor_changed", id: null }), null);
  assert.equal(heardFrom({ type: "idle" }), null);
});

test("elapsed time reads as seconds, then minutes and seconds", () => {
  assert.equal(elapsed(8_000), "8s");
  assert.equal(elapsed(65_000), "1m 05s");
  assert.equal(elapsed(-50), "0s");
});

test("a terminal's head says how long it has been working", () => {
  assert.equal(workingFor(0, 59_999), "Working");
  assert.equal(workingFor(0, 60_000), "Working 1m");
  assert.equal(workingFor(0, 4 * 60_000 + 30_000), "Working 4m");
});

test("the waiting verb agrees with the count", () => {
  assert.equal(waitingVerb(1), "is waiting for you");
  assert.equal(waitingVerb(2), "are waiting for you");
});

test("the status line splits who is replying from who is waiting", () => {
  assert.deepEqual(statusParts(["Jigga"], ["Null"]), [{ who: ["Jigga"], verb: "is replying" }, { who: ["Null"], verb: "is waiting for you" }]);
  assert.deepEqual(statusParts([], ["Null", "Ada"]), [{ who: ["Null", "Ada"], verb: "are waiting for you" }]);
  assert.deepEqual(statusParts(["Jigga", "Ada"], []), [{ who: ["Jigga", "Ada"], verb: "are replying" }]);
  assert.deepEqual(statusParts([], []), []);
});

test("Stop names only the bots that are replying", () => {
  assert.equal(stopLabel(["Jigga"]), "Stop Jigga");
  assert.equal(stopLabel(["Jigga", "Ada"]), "Stop Jigga and Ada");
  assert.equal(stopLabel(["Jigga", "Ada", "Null"]), "Stop 3 bots");
});

test("Stop leaves a waiting card up, and stops everything when nobody waits", () => {
  assert.deepEqual(stopTargets(["jigga"], ["null"]), ["jigga"]);
  assert.equal(stopTargets(["jigga", "ada"], []), "all");
  assert.deepEqual(stopTargets([], ["null"]), []);
});

test("before the first message in a room of two or more bots, the hint teaches @all", () => {
  assert.equal(composerCopy(false, false, { firstMessage: true }).hint, "@all asks everyone · / for commands · ↵ send");
  assert.equal(composerCopy(false, false).hint, "@ who answers · ! which tools · ↵ send · ⇧↵ new line");
  assert.match(composerCopy(true, false, { firstMessage: true }).hint, /↵ queue/);
});

test("while quoting, the placeholder suggests what to ask", () => {
  assert.equal(composerCopy(false, false, { quoting: true }).placeholder, "e.g. Check this against the tests and say what breaks");
  assert.equal(composerCopy(true, false, { quoting: true }).placeholder, "e.g. Check this against the tests and say what breaks");
  assert.match(composerCopy(true, false, { quoting: true }).hint, /↵ queue/);
});
