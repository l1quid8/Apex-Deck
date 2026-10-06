import test from "node:test";
import assert from "node:assert/strict";
import { exampleRows, handleFor, hasMention, mentionTarget, recipientName } from "../src/recipients.ts";

test("mentions follow the room's rules", () => {
  const ids = ["null", "jigga", "sol-6.1"];
  assert.equal(handleFor("Sol 6.1!"), "sol6.1");
  assert.deepEqual(mentionTarget("@jigga then @NULL, and @jigga again", ids), ["jigga", "null"]);
  assert.deepEqual(mentionTarget("what do you think, @sol-6.1.", ids), ["sol-6.1"]);
  assert.equal(mentionTarget("@all thoughts?", ids), "everyone");
  assert.equal(mentionTarget("hey @Everyone", ids), "everyone");
  assert.deepEqual(mentionTarget("@nobody here", ids), []);
});

test("an @ inside a word is not a mention", () => {
  const ids = ["null", "opus"];
  assert.equal(hasMention("mail me at me@opus.dev", ids), false);
  assert.equal(hasMention("see x@all and a@null", ids), false);
  assert.equal(hasMention("@param is a JSDoc tag", ids), false);
  assert.equal(hasMention("thanks @null", ids), true);
  assert.equal(hasMention("@all of you", []), true);
});

const roster = [{ id: "jigga", name: "Jigga" }, { id: "null", name: "Null" }];
const to = (extra) => recipientName({ targets: ["null"], roster, policy: "mention", ...extra });

test("the composer names who gets the message", () => {
  assert.equal(to({}), "Null");
  assert.equal(to({ targets: ["jigga", "null"] }), "everyone");
  assert.equal(to({ targets: ["jigga", "null"], policy: "everyone" }), "everyone");
  assert.equal(to({ targets: ["jigga", "null"], policy: "round_robin" }), "Jigga, then Null");
  assert.equal(to({ targets: ["null"], policy: "round_robin" }), "Null");
});

test("a room of one is never everyone", () => {
  assert.equal(to({ roster: [{ id: "null", name: "Null" }] }), "Null");
});

test("no name without bots or a target", () => {
  assert.equal(to({ roster: [], targets: [] }), null);
  assert.equal(to({ targets: [] }), null);
});

test("bots mentioned together are joined like a sentence", () => {
  const three = [...roster, { id: "ada", name: "Ada" }];
  assert.equal(to({ roster: three, targets: ["null", "ada"] }), "Null and Ada");
});

test("examples use a real handle", () => {
  assert.deepEqual(exampleRows(["Null", "jigga"]), [
    { label: "e.g. @all what would you change first?", text: "@all what would you change first?" },
    { label: "e.g. @null review the last commit", text: "@null review the last commit" },
    { label: "e.g. /export markdown", text: "/export markdown" },
  ]);
  assert.deepEqual(exampleRows([]), []);
});

