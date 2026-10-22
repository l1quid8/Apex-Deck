import test from "node:test";
import assert from "node:assert/strict";
import { cutBack, needsFull, outgoingText, putBackLine, quotesBack, selectionSpot, withQuote } from "../src/phone/messageTools.ts";
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

test("a message taken back brings its quotes and their Send to back, ahead of any quoted since", () => {
  const sent = [{ ...quoteFor(reply, () => "Null"), to: "jigga" }];
  const since = [quoteFor({ ...reply, seq: 6, text: "Later" }, () => "Null")];
  const back = quotesBack(since, sent);
  assert.deepEqual(back, [...sent, ...since]);
  assert.ok(outgoingText("Why?", back, people).startsWith("@jigga Why?"));
});

test("a quote still in the box isn't doubled when its message comes back", () => {
  const quote = quoteFor(reply, () => "Null");
  assert.deepEqual(quotesBack([quote], [{ ...quote, to: "jigga" }]), [{ ...quote, to: "jigga" }]);
  assert.deepEqual(quotesBack([quote], []), [quote]);
});

// Add to chat / More details float in the phone frame, on the side iPhone's own Copy menu leaves free:
// it goes under text in the top half of the screen and over text in the bottom half.
const frame = { left: 0, top: 0, right: 393, bottom: 852 };
const chat = { top: 120, bottom: 700 };
const text = (left, width, top, bottom) => ({ left, width, top, bottom });

test("text in the top half gets them over it, centred", () => {
  assert.deepEqual(selectionSpot(text(100, 100, 300, 340), chat, frame, 100), { x: 150, y: 300, side: "above" });
});

test("text in the bottom half gets them under it, centred", () => {
  assert.deepEqual(selectionSpot(text(100, 100, 500, 540), chat, frame, 100), { x: 150, y: 540, side: "below" });
});

test("they stay 8px inside the frame's edges", () => {
  assert.equal(selectionSpot(text(16, 40, 300, 320), chat, frame, 100).x, 108);
  assert.equal(selectionSpot(text(340, 40, 300, 320), chat, frame, 100).x, 285);
});

test("text running past the chat's edge keeps them at that edge", () => {
  assert.deepEqual(selectionSpot(text(100, 100, 600, 900), chat, frame, 100), { x: 150, y: 700, side: "below" });
  assert.deepEqual(selectionSpot(text(100, 100, 60, 300), chat, frame, 100), { x: 150, y: 120, side: "above" });
});

test("text scrolled out of the chat has none", () => {
  assert.equal(selectionSpot(text(100, 100, 20, 110), chat, frame, 100), null);
  assert.equal(selectionSpot(text(100, 100, 710, 760), chat, frame, 100), null);
});

test("the spot is measured from the frame, wherever the frame sits", () => {
  const wide = { left: 300, top: 40, right: 740, bottom: 892 };
  assert.deepEqual(selectionSpot(text(400, 100, 600, 640), { top: 160, bottom: 740 }, wide, 100), { x: 150, y: 600, side: "below" });
});
