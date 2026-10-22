import test from "node:test";
import assert from "node:assert/strict";
import { cutBack, needsFull, outgoingText, putBackLine, withQuote } from "../src/phone/messageTools.ts";
import { responsePin } from "../src/messagePins.ts";
import { quoteFor } from "../src/reply.ts";

const people = [{ id: "null", display_name: "Null" }, { id: "jigga", display_name: "Jigga" }];
const reply = { seq: 4, speaker: { kind: "bot", id: "null" }, text: "Use @jigga's plan." };

test("the same quote isn't added twice", () => {
  const quote = quoteFor(reply, () => "Null");
  const once = withQuote([], quote);
  assert.equal(once.length, 1);
  assert.equal(withQuote(once, { ...quote }).length, 1);
  assert.equal(withQuote(once, quoteFor({ ...reply, text: "Other" }, () => "Null")).length, 2);
});

test("a quoted message goes out as the desktop sends it: led by the quoted bot, quotes below, mentions defused", () => {
  const out = outgoingText("  Why?  ", [quoteFor(reply, () => "Null")], people);
  assert.equal(out, "@null Why?\n\n> Null wrote:\n> Use ＠jigga's plan.");
});

test("without quotes the text goes as typed, trimmed", () => {
  assert.equal(outgoingText("  hello  ", [], people), "hello");
});

test("Send to ▾ hands the quotes to someone else", () => {
  const out = outgoingText("Check this", [{ ...quoteFor(reply, () => "Null"), to: "jigga" }], people);
  assert.ok(out.startsWith("@jigga Check this"));
});

test("Retry or Revert keeps only the messages before it and the pins from them", () => {
  const room = {
    id: "pane-a",
    messages: [1, 2, 3, 4].map((seq) => ({ seq, speaker: { kind: "human" }, text: `m${seq}` })),
    pins: [responsePin(1, "m1"), responsePin(3, "m3"), "a plain fact"],
  };
  const after = cutBack(room, 3);
  assert.deepEqual(after.messages.map((m) => m.seq), [1, 2]);
  assert.deepEqual(after.pins, [responsePin(1, "m1"), "a plain fact"]);
  assert.equal(after.id, "pane-a");
});

test("lines it says", () => {
  assert.equal(needsFull("Pinning", "MacBook"), "Pinning needs Full access on MacBook. Change this phone's level in that machine's Settings → Phones.");
  assert.equal(putBackLine([]), null);
  assert.equal(putBackLine(["src/a.ts"]), "Put back src/a.ts.");
  assert.equal(putBackLine(["a", "b", "c"]), "Put back 3 files.");
});
