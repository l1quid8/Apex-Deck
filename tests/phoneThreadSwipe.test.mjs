import test from "node:test";
import assert from "node:assert/strict";
import {
  EDGE_GUARD, edgeSwipe, heldStrip, holdStrip, neighbour, roomFits, stripPosition, swipeBlocked, swipeRelease, swipeStrip,
} from "../src/phone/threadSwipe.ts";

const keyOf = (pane) => `${pane.hostId ?? "local"}:${pane.id}`;
const thread = (id, over = {}) => ({ id, kind: "chat", title: id, ...over });

test("the strip is Pinned, then each project, then Work threads made from chats", () => {
  const strip = swipeStrip([
    [thread("pinned", { hostId: "mac" })],
    [thread("a1", { hostId: "mac" }), thread("a2", { hostId: "mac" })],
    [thread("b1", { hostId: "studio" })],
    [thread("from-chat", { hostId: "studio" })],
  ], keyOf);
  assert.deepEqual(strip, ["mac:pinned", "mac:a1", "mac:a2", "studio:b1", "studio:from-chat"]);
});

test("terminals, assistants and archived threads are not swiped through", () => {
  const strip = swipeStrip([
    [thread("t1"), { id: "shell", kind: "terminal" }, { id: "bot", kind: "agent" }, thread("old", { archived: true })],
  ], keyOf);
  assert.deepEqual(strip, ["local:t1"]);
});

test("a thread listed twice (Pinned and its project) appears once", () => {
  const strip = swipeStrip([[thread("a", { hostId: "mac" })], [thread("a", { hostId: "mac" }), thread("b", { hostId: "mac" })]], keyOf);
  assert.deepEqual(strip, ["mac:a", "mac:b"]);
});

test("the same thread id on two machines is two threads", () => {
  const strip = swipeStrip([[thread("same", { hostId: "mac" }), thread("same", { hostId: "studio" })]], keyOf);
  assert.deepEqual(strip, ["mac:same", "studio:same"]);
});

test("while a thread is open its neighbours stay put, so a new thread can't shuffle them", () => {
  const held = ["mac:a", "mac:b", "mac:c"];
  const arriving = ["mac:new", "mac:a", "mac:b", "mac:c"];
  assert.deepEqual(heldStrip(held, arriving, "mac:b"), ["mac:a", "mac:b", "mac:c"]);
});

test("a thread that is gone leaves the strip, so no swipe lands on nothing", () => {
  assert.deepEqual(heldStrip(["mac:a", "mac:b", "mac:c"], ["mac:a", "mac:c"], "mac:a"), ["mac:a", "mac:c"]);
});

test("opening a thread — from the list, or by a swipe — takes the order as it is now", () => {
  const was = { open: "mac:a", keys: ["mac:a", "mac:b"] };
  assert.deepEqual(holdStrip(was, ["mac:new", "mac:a", "mac:b"], "mac:b"), { open: "mac:b", keys: ["mac:new", "mac:a", "mac:b"] });
  assert.deepEqual(holdStrip(null, ["mac:a", "mac:b"], "mac:b"), { open: "mac:b", keys: ["mac:a", "mac:b"] });
  // Back to the list: nothing is open, so the next thread opened starts from the list's order again.
  assert.deepEqual(holdStrip(was, ["mac:new", "mac:a", "mac:b"], null), { open: null, keys: ["mac:new", "mac:a", "mac:b"] });
});

test("staying in a thread keeps its order, and drops only what is gone", () => {
  const was = { open: "mac:b", keys: ["mac:a", "mac:b", "mac:c"] };
  assert.deepEqual(holdStrip(was, ["mac:new", "mac:a", "mac:b", "mac:c"], "mac:b"), { open: "mac:b", keys: ["mac:a", "mac:b", "mac:c"] });
  assert.deepEqual(holdStrip(was, ["mac:a", "mac:c"], "mac:b"), { open: "mac:b", keys: ["mac:a", "mac:c"] });
});

test("a thread that isn't in the strip yet (unsent text) gets the whole strip back", () => {
  assert.deepEqual(heldStrip(["mac:a"], ["mac:a", "mac:b"], "draft-1"), ["mac:a", "mac:b"]);
});

test("the position under the title counts threads, and says nothing when there is only one", () => {
  const strip = ["mac:a", "mac:b", "mac:c", "mac:d"];
  assert.equal(stripPosition(strip, "mac:c"), "3 of 4");
  assert.equal(stripPosition(strip, "mac:a"), "1 of 4");
  assert.equal(stripPosition(["mac:a"], "mac:a"), "");
  assert.equal(stripPosition(strip, "draft-7"), "");
  assert.equal(stripPosition(strip, null), "");
});

test("swiping moves one thread, and stops at either end", () => {
  const strip = ["mac:a", "mac:b", "mac:c"];
  assert.equal(neighbour(strip, "mac:b", "next"), "mac:c");
  assert.equal(neighbour(strip, "mac:b", "previous"), "mac:a");
  assert.equal(neighbour(strip, "mac:c", "next"), null);
  assert.equal(neighbour(strip, "mac:a", "previous"), null);
  assert.equal(neighbour([], "mac:a", "next"), null);
});

test("a thread with unsent text has no place in the strip, so the first thread is where a swipe goes", () => {
  assert.equal(neighbour(["mac:a", "mac:b"], "draft-9", "next"), "mac:a");
  assert.equal(neighbour(["mac:a", "mac:b"], "draft-9", "previous"), "mac:a");
  assert.equal(neighbour(["mac:a", "mac:b"], null, "next"), "mac:a");
});

test("a slow drag springs back until it passes a quarter of the screen", () => {
  const width = 400;
  assert.equal(swipeRelease({ dx: -60, dy: 2, width, ms: 1200 }), "back");
  assert.equal(swipeRelease({ dx: -101, dy: 2, width, ms: 1200 }), "next");
  assert.equal(swipeRelease({ dx: 140, dy: 4, width, ms: 1200 }), "previous");
});

test("a quick flick switches however short it is", () => {
  assert.equal(swipeRelease({ dx: -30, dy: 1, width: 400, ms: 60 }), "next");
  assert.equal(swipeRelease({ dx: 30, dy: 1, width: 400, ms: 60 }), "previous");
});

test("a drag that is mostly up or down belongs to the messages, not the swipe", () => {
  assert.equal(swipeRelease({ dx: -300, dy: 260, width: 400, ms: 200 }), "back");
  assert.equal(swipeRelease({ dx: -4, dy: 0, width: 400, ms: 100 }), "back");
});

test("a swipe that starts on something that scrolls sideways is theirs", () => {
  const insideCode = { closest: (selectors) => selectors.includes("pre") ? { tag: "pre" } : null };
  const insideBotRow = { closest: (selectors) => selectors.includes(".ph-crew-row") ? {} : null };
  const plain = { closest: () => null };
  assert.equal(swipeBlocked(insideCode), true);
  assert.equal(swipeBlocked(insideBotRow), true);
  assert.equal(swipeBlocked(plain), false);
  assert.equal(swipeBlocked(null), false);
  assert.equal(swipeBlocked(undefined), false);
});

test("the left edge stays iOS's back gesture", () => {
  assert.equal(edgeSwipe(0), true);
  assert.equal(edgeSwipe(EDGE_GUARD - 1), true);
  assert.equal(edgeSwipe(EDGE_GUARD), false);
  assert.equal(edgeSwipe(120), false);
});

test("several fast swipes never draw the old thread's messages under the new title", () => {
  // Swiping from the first thread to the fourth in one go: each swipe opens the next thread at once,
  // but the messages of the thread we left are still the only ones loaded. Every frame between the
  // swipe and the new messages arriving has to show nothing rather than the wrong thread's replies.
  const strip = ["mac:a", "mac:b", "mac:c", "mac:d"];
  const paneOf = (key) => key.slice("mac:".length);  // the strip names threads by machine and id
  let open = "mac:a";
  let room = { id: "a", hostId: "mac" };  // the last room that finished loading
  const shown = [];
  for (let step = 0; step < 3; step++) {
    open = neighbour(strip, open, "next");
    // The frames right after the swipe: the new title, the old room still in hand.
    for (let frame = 0; frame < 2; frame++) shown.push(roomFits(room, paneOf(open), "mac") ? `${open}:${room.id}` : null);
    room = { id: paneOf(open), hostId: "mac" };  // what lands when the new thread's room loads
  }
  assert.deepEqual(shown, [null, null, null, null, null, null]);
  assert.equal(open, "mac:d");
  assert.equal(roomFits(room, paneOf(open), "mac"), true, "the thread's own replies do show");
});

test("a reply is drawn only under its own thread's title, on its own machine", () => {
  const room = { id: "t1", hostId: "mac" };
  assert.equal(roomFits(room, "t1", "mac"), true);
  assert.equal(roomFits(room, "t2", "mac"), false, "another thread's room must not show");
  assert.equal(roomFits({ id: "t1", hostId: "studio" }, "t1", "mac"), false, "a same-id thread on another machine must not show");
  assert.equal(roomFits(null, "t1", "mac"), false);
  assert.equal(roomFits(room, null, "mac"), false);
});
