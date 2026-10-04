import test from "node:test";
import assert from "node:assert/strict";
import { exampleRows, handleFor, hasMention, mentionTarget, recipientLine, showsRecipientLine } from "../src/recipients.ts";

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
const line = (extra) => recipientLine({ targets: ["null"], roster, policy: "mention", mentioned: false, addressedBefore: true, busy: [], ...extra });

test("the recipient line says who gets the message and why", () => {
  assert.deepEqual(line({ mentioned: true }), { to: "Null", reason: "you mentioned", queued: false });
  assert.deepEqual(line({}), { to: "Null", reason: "last addressed", queued: false });
  assert.deepEqual(line({ targets: ["jigga"], addressedBefore: false }), { to: "Jigga", reason: "first in the room", queued: false });
  assert.deepEqual(line({ targets: ["jigga", "null"], policy: "everyone" }), { to: "everyone", reason: "everyone at once", queued: false });
  assert.deepEqual(line({ targets: ["jigga", "null"], policy: "round_robin" }), { to: "Jigga, then Null", reason: "everyone in turn", queued: false });
});

test("a busy recipient means the message waits", () => {
  assert.equal(line({ busy: ["null"] }).queued, true);
  assert.equal(line({ busy: ["jigga"] }).queued, false);
});

test("no line without bots or a target", () => {
  assert.equal(line({ roster: [], targets: [] }), null);
  assert.equal(line({ targets: [] }), null);
});

test("bots mentioned together are joined like a sentence", () => {
  const three = [...roster, { id: "ada", name: "Ada" }];
  assert.equal(line({ roster: three, targets: ["null", "ada"], mentioned: true }).to, "Null and Ada");
});

test("examples use a real handle", () => {
  assert.deepEqual(exampleRows(["Null", "jigga"]), [
    { label: "e.g. @all what would you change first?", text: "@all what would you change first?" },
    { label: "e.g. @null review the last commit", text: "@null review the last commit" },
    { label: "e.g. /pin Use pnpm, not npm", text: "/pin Use pnpm, not npm" },
  ]);
  assert.deepEqual(exampleRows([]), []);
});

test("the line hides in a pane under 260px tall", () => {
  assert.equal(showsRecipientLine(259), false);
  assert.equal(showsRecipientLine(260), true);
});
