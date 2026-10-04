import test from "node:test";
import assert from "node:assert/strict";
import { askerOf, hopNotice, letLabel, liveActions, retryFor, stillHere } from "../src/noticeActions.ts";

test("Try again is offered for a bot still in the room, never for storage", () => {
  assert.deepEqual(retryFor("null", ["null", "jigga"]), { kind: "retry", id: "null" });
  assert.equal(retryFor("storage", ["null"]), null);
  assert.equal(retryFor("ghost", ["null"]), null);
});

test("a button only runs bots that are still here", () => {
  assert.deepEqual(stillHere({ kind: "retry", id: "null" }, ["jigga"]), []);
  assert.deepEqual(stillHere({ kind: "let", ids: ["null", "ada"] }, ["null", "jigga"]), ["null"]);
  assert.deepEqual(stillHere({ kind: "let", ids: ["null", "jigga"] }, ["null", "jigga"]), ["null", "jigga"]);
});

test("the cut-off notice says who asked whom", () => {
  assert.equal(hopNotice(3, "Jigga", ["Null"]), "Stopped after 3 rounds of models answering each other. Jigga asked Null next.");
  assert.equal(hopNotice(1, "Jigga", ["Null", "Ada"]), "Stopped after 1 round of models answering each other. Jigga asked Null and Ada next.");
  assert.equal(hopNotice(0, "Null", ["Jigga"]), "Stopped so you can choose. Null asked Jigga next.");
  assert.equal(hopNotice(2, null, ["Null"]), "Stopped after 2 rounds of models answering each other. Null is next.");
});

test("the button names one bot, or says them", () => {
  assert.equal(letLabel(["Null"]), "Let Null answer");
  assert.equal(letLabel(["Null", "Ada"]), "Let them answer");
});

test("the asker is the latest reply since your message that mentions who is next", () => {
  const m = (seq, who, text) => ({ seq, speaker: who === "you" ? { kind: "human" } : { kind: "bot", id: who }, text });
  const ids = ["null", "jigga", "ada"];
  assert.equal(askerOf([m(0, "you", "@jigga go"), m(1, "jigga", "@null your turn"), m(2, "ada", "agreed")], ["null"], ids), "jigga");
  assert.equal(askerOf([m(0, "jigga", "@null earlier"), m(1, "you", "go"), m(2, "ada", "no mention")], ["null"], ids), null);
  assert.equal(askerOf([m(0, "you", "go"), m(1, "ada", "@all thoughts?")], ["null", "jigga"], ids), "ada");
});

test("buttons go once used or once you send", () => {
  const entries = [{ key: 1, human: false }, { key: null, human: true }, { key: 2, human: false }, { key: 3, human: false }, { key: null, human: false }];
  assert.deepEqual([...liveActions(entries, new Set([3]))], [2]);
  assert.deepEqual([...liveActions(entries, new Set())].sort(), [2, 3]);
});
