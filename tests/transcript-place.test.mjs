import test from "node:test";
import assert from "node:assert/strict";
import { AT_BOTTOM_PX, cardsOutOfView, firstUnseen, isAtBottom, newPill, owners, seenList, seenMark, unseenCount, waitingLine } from "../src/transcriptPlace.ts";

test("within 80px of the bottom counts as at the bottom", () => {
  assert.equal(AT_BOTTOM_PX, 80);
  assert.equal(isAtBottom(1000, 1500, 500), true);
  assert.equal(isAtBottom(920, 1500, 500), true);
  assert.equal(isAtBottom(919, 1500, 500), false);
  assert.equal(isAtBottom(0, 1500, 500), false);
});

test("a transcript that is not laid out counts as at the bottom", () => {
  // A hidden pane (display: none) measures all zeros. It must stay "at the
  // bottom" so it opens at the latest message when it is shown.
  assert.equal(isAtBottom(0, 0, 0), true);
});

test("the new-replies pill counts what arrived", () => {
  assert.equal(newPill(1), "1 new · Jump to latest");
  assert.equal(newPill(3), "3 new · Jump to latest");
});

test("only cards wholly outside the view count, oldest first", () => {
  const cards = [
    { by: "null", request: "ask-1", top: -300, bottom: -100 },
    { by: "jigga", request: "ask-2", top: 50, bottom: 250 },
    { by: "null", request: "ask-3", top: 380, bottom: 600 },
    { by: "ada", request: "ask-4", top: 400, bottom: 640 },
    { by: "null", request: "ask-5", top: 700, bottom: 900 },
  ];
  const away = cardsOutOfView(cards, 0, 400);
  assert.deepEqual(away.map((c) => c.request), ["ask-1", "ask-4", "ask-5"]);
  assert.deepEqual(owners(away), ["null", "ada"]);
});

test("the waiting pill names who is waiting", () => {
  assert.equal(waitingLine(["Null"]), "Null is waiting for you");
  assert.equal(waitingLine(["Null", "Jigga"]), "Null and Jigga are waiting for you");
});

const msgs = [{ seq: 0, bot: false }, { seq: 1, bot: true }, { seq: 2, bot: false }, { seq: 3, bot: true }, { seq: 4, bot: true }];

test("the divider goes above the first reply after the last one you saw", () => {
  assert.equal(firstUnseen(msgs, 1), 3);
  assert.equal(firstUnseen(msgs, 2), 3);
  assert.equal(firstUnseen(msgs, 4), null);
  assert.equal(unseenCount(msgs, 3), 2);
  assert.equal(unseenCount(msgs, null), 0);
});

test("threads saved before marks existed show no divider", () => {
  assert.equal(firstUnseen(msgs, undefined), null);
  assert.equal(firstUnseen(msgs, "3"), null);
});

test("a mark from before /clear does not hide new replies", () => {
  // Messages count from 0 again after /clear; an old mark of 40 is past them all.
  assert.equal(firstUnseen([{ seq: 0, bot: false }, { seq: 1, bot: true }], 40), 1);
  assert.equal(firstUnseen([{ seq: 0, bot: false }, { seq: 1, bot: true }], -1), 1);
});

test("the saved mark moves to the newest message only when it changes", () => {
  assert.equal(seenMark(msgs, 2), 4);
  assert.equal(seenMark(msgs, 4), null);
  assert.equal(seenMark(msgs, undefined), 4);
  assert.equal(seenMark([], -1), null);
});

test("transcript messages are read as bot or not", () => {
  assert.deepEqual(
    seenList([{ seq: 0, speaker: { kind: "human" }, text: "hi" }, { seq: 1, speaker: { kind: "bot", id: "null" }, text: "hello" }]),
    [{ seq: 0, bot: false }, { seq: 1, bot: true }],
  );
});
